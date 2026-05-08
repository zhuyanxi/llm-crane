import * as vscode from 'vscode';
import { LLMCraneDiagnosticError } from '@llm-crane/core';
import {
  BUILT_IN_TASK_TEMPLATES,
  TaskRequestSchema,
  getTaskTemplateDefinition,
  type RerunTaskRequest,
  type RerunnableStageId,
  type TaskContext,
  type TaskPolicyOverrides,
  type TaskRequest,
  type TaskResponse,
  type TaskTemplateDefinition,
} from '@llm-crane/schemas';
import {
  OrchestratorProcessManager,
  type OrchestratorReadyMode,
} from './orchestratorProcessManager';
import {
  getContextModeLabel,
  planTaskContexts,
  resolveContextStrategy,
  type ContextCaptureMode,
  type EditorContextSnapshot,
} from './taskContextPlan';
import { buildPipelineTimeline, type TaskTimelineStageView } from './pipelineTimeline';
import { buildRoutingInsight } from './routingInsights';
import {
  buildModelPolicyOverrides,
  describeTaskModelOverride,
  loadModelOverrideCatalog,
  type ModelOverrideMode,
} from './modelOverride';

const RUN_TASK_COMMAND = 'llmCrane.runTask';
const TASK_PANEL_VIEW_TYPE = 'llmCrane.taskPanel';
const CUSTOM_TASK_TEMPLATE_ID = 'custom';

type SubmitTaskPanelInboundMessage = {
  type: 'submitTask';
  value: string;
  contextMode: ContextCaptureMode;
  ignoreCache: boolean;
  templateId: string;
  templateValues: Record<string, string>;
  includeSupportingContext: boolean;
  modelOverrideMode: ModelOverrideMode;
  overrideModelId: string;
};

type PreviewContextPanelInboundMessage = {
  type: 'previewContext';
  contextMode: ContextCaptureMode;
  templateId: string;
  includeSupportingContext: boolean;
};

type RerunTaskPanelInboundMessage = {
  type: 'rerunTask';
  targetStageId: RerunnableStageId;
};

type TaskPanelInboundMessage = SubmitTaskPanelInboundMessage | PreviewContextPanelInboundMessage | RerunTaskPanelInboundMessage;

type TaskPanelStatus = 'idle' | 'running' | 'success' | 'error';

type TaskResultView = {
  output: string;
  runModeSummary: string;
  runModeDetail: string;
  selectedModel: string;
  runtimeSummary: string;
  selectionReason: string;
  routeSummary: string;
  routeDetail: string;
  routeReason: string;
  overrideSummary: string;
  overrideDetail: string;
  earlyExitSummary: string;
  earlyExitDetail: string;
  executionPathSummary: string;
  diagnosticSummary: string;
  diagnosticDetail: string;
  cacheSummary: string;
  cacheDetail: string;
  tokenSummary: string;
  latencySummary: string;
  costSummary: string;
  costDetail: string;
  timelineStages: TaskTimelineStageView[];
  rerunTargets: RerunnableStageId[];
  traceEntries: string[];
};

type TaskPanelSession = {
  latestResponse?: TaskResponse;
  latestSubmittedTask?: string;
};

type TaskPanelStatusMessage = {
  type: 'taskStatus';
  status: TaskPanelStatus;
  headline: string;
  detail: string;
  submittedTask?: string;
  requestPreview?: string;
  resultView?: TaskResultView;
};

type ContextPreviewItemView = {
  headline: string;
  detail: string;
  preview: string;
};

type ContextPreviewMessage = {
  type: 'contextPreview';
  headline: string;
  detail: string;
  warnings: string[];
  items: ContextPreviewItemView[];
  blockingError?: string;
};

let orchestratorManager: OrchestratorProcessManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  orchestratorManager = new OrchestratorProcessManager(context.extensionUri.fsPath, context.globalStorageUri.fsPath);
  let taskPanel: vscode.WebviewPanel | undefined;

  const disposable = vscode.commands.registerCommand(RUN_TASK_COMMAND, async () => {
    if (taskPanel) {
      taskPanel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = createTaskPanel();
    taskPanel = panel;
    const panelSession: TaskPanelSession = {};

    panel.webview.html = getTaskPanelHtml(panel.webview);
    postTaskStatus(panel.webview, {
      status: 'idle',
      headline: 'Task panel ready',
      detail: 'Choose template-aware context strategy, inspect preview, then submit task. Current panel shows output, selected model, cache state, execution path, trace, token usage, latency, and cost.',
    });

    const panelDisposables: vscode.Disposable[] = [];

    panel.onDidDispose(
      () => {
        taskPanel = undefined;
        for (const disposable of panelDisposables) {
          disposable.dispose();
        }
      },
      undefined,
      panelDisposables,
    );

    panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (!orchestratorManager) {
          return;
        }

        await handleTaskPanelMessage(panel.webview, message, orchestratorManager, panelSession);
      },
      undefined,
      panelDisposables,
    );
  });

  context.subscriptions.push(disposable);
}

export async function deactivate(): Promise<void> {
  await orchestratorManager?.dispose();
  orchestratorManager = undefined;
}

function createTaskPanel(): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(TASK_PANEL_VIEW_TYPE, 'LLM Crane Task', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
}

async function handleTaskPanelMessage(
  webview: vscode.Webview,
  message: unknown,
  processManager: OrchestratorProcessManager,
  panelSession: TaskPanelSession,
): Promise<void> {
  if (isPreviewContextPanelInboundMessage(message)) {
    postContextPreview(webview, buildContextPreviewMessage(message.contextMode, message.templateId, message.includeSupportingContext));
    return;
  }

  if (isSubmitTaskPanelInboundMessage(message)) {
    const taskDraft = buildTaskDraftPreview(message.value, message.templateId, message.templateValues);
    if (!taskDraft) {
      postTaskStatus(webview, {
        status: 'error',
        headline: 'Task description required',
        detail: 'Enter task text or choose a template with the required inputs before submitting.',
      });
      return;
    }

    postTaskStatus(webview, {
      status: 'running',
      headline: 'Submitting task',
      detail: `Collecting ${getContextModeLabel(message.contextMode).toLowerCase()} context, then starting or reusing local orchestrator process${message.ignoreCache ? ' with cache bypass enabled' : ''}.`,
      submittedTask: taskDraft,
    });

    try {
      const taskRequest = buildTaskRequest(
        message.value,
        message.contextMode,
        message.ignoreCache,
        message.templateId,
        message.templateValues,
        message.includeSupportingContext,
        message.modelOverrideMode,
        message.overrideModelId,
      );
      const { response, readyMode, processId } = await processManager.runTask(taskRequest);
      const hasFailureDiagnostic = Boolean(response.diagnostic) || response.providerResult.status === 'failed';

      panelSession.latestResponse = response;
      panelSession.latestSubmittedTask = taskRequest.task;

      postTaskStatus(webview, {
        status: hasFailureDiagnostic ? 'error' : 'success',
        headline: hasFailureDiagnostic
          ? response.diagnostic?.summary ?? 'Task completed with failure diagnostics'
          : readyMode === 'started'
            ? 'Orchestrator started and responded'
            : 'Orchestrator response received',
        detail: `${formatTaskRequestSummary(taskRequest, message.contextMode)} ${formatTaskResponseSummary(response, readyMode, processId)}`,
        submittedTask: taskRequest.task,
        requestPreview: JSON.stringify(taskRequest, null, 2),
        resultView: createTaskResultView(response),
      });
    } catch (error) {
      const headline = error instanceof LLMCraneDiagnosticError ? error.diagnostic.summary : 'Submission blocked';
      const detail =
        error instanceof LLMCraneDiagnosticError
          ? formatDiagnosticDetail(error.diagnostic)
          : error instanceof Error
            ? error.message
            : 'Unexpected LLM Crane error.';

      postTaskStatus(webview, {
        status: 'error',
        headline,
        detail,
        submittedTask: taskDraft,
      });
    }
    return;
  }

  if (!isRerunTaskPanelInboundMessage(message)) {
    return;
  }

  if (!panelSession.latestResponse) {
    postTaskStatus(webview, {
      status: 'error',
      headline: 'No checkpoint available',
      detail: 'Run task once before stage rerun.',
    });
    return;
  }

  const submittedTask = panelSession.latestSubmittedTask ?? panelSession.latestResponse.checkpoint.taskRequest.task;
  let rerunRequest: RerunTaskRequest;

  try {
    rerunRequest = buildRerunTaskRequest(panelSession.latestResponse, message.targetStageId);
  } catch (error) {
    postTaskStatus(webview, {
      status: 'error',
      headline: 'Stage rerun blocked',
      detail: error instanceof Error ? error.message : 'Invalid stage rerun request.',
      submittedTask,
      resultView: createTaskResultView(panelSession.latestResponse),
    });
    return;
  }

  postTaskStatus(webview, {
    status: 'running',
    headline: 'Starting stage rerun',
    detail: `Reusing checkpointed pipeline context and resuming from ${message.targetStageId}.`,
    submittedTask,
  });

  try {
    const { response, readyMode, processId } = await processManager.rerunTask(rerunRequest);
    const hasFailureDiagnostic = Boolean(response.diagnostic) || response.providerResult.status === 'failed';

    panelSession.latestResponse = response;
    panelSession.latestSubmittedTask = submittedTask;

    postTaskStatus(webview, {
      status: hasFailureDiagnostic ? 'error' : 'success',
      headline: hasFailureDiagnostic
        ? response.diagnostic?.summary ?? 'Task completed with failure diagnostics'
        : readyMode === 'started'
          ? 'Orchestrator started and responded'
          : 'Orchestrator response received',
      detail: `${formatTaskResponseSummary(response, readyMode, processId)} Retained ${response.runInfo.historyTraceCount} prior trace event(s).`,
      submittedTask,
      requestPreview: JSON.stringify(rerunRequest, null, 2),
      resultView: createTaskResultView(response),
    });
  } catch (error) {
    const headline = error instanceof LLMCraneDiagnosticError ? error.diagnostic.summary : 'Submission blocked';
    const detail =
      error instanceof LLMCraneDiagnosticError
        ? formatDiagnosticDetail(error.diagnostic)
        : error instanceof Error
          ? error.message
          : 'Unexpected LLM Crane error.';

    postTaskStatus(webview, {
      status: 'error',
      headline,
      detail,
      submittedTask,
      resultView: createTaskResultView(panelSession.latestResponse),
    });
  }
}

function isSubmitTaskPanelInboundMessage(message: unknown): message is SubmitTaskPanelInboundMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<SubmitTaskPanelInboundMessage>;
  return (
    candidate.type === 'submitTask' &&
    typeof candidate.value === 'string' &&
    typeof candidate.contextMode === 'string' &&
    typeof candidate.ignoreCache === 'boolean' &&
    typeof candidate.templateId === 'string' &&
    isStringRecord(candidate.templateValues) &&
    typeof candidate.includeSupportingContext === 'boolean' &&
    typeof candidate.modelOverrideMode === 'string' &&
    typeof candidate.overrideModelId === 'string' &&
    isModelOverrideMode(candidate.modelOverrideMode) &&
    isContextCaptureMode(candidate.contextMode)
  );
}

function isModelOverrideMode(value: string): value is ModelOverrideMode {
  return value === 'auto' || value === 'simple-default' || value === 'complex-default' || value === 'specific';
}

function isPreviewContextPanelInboundMessage(message: unknown): message is PreviewContextPanelInboundMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<PreviewContextPanelInboundMessage>;
  return (
    candidate.type === 'previewContext' &&
    typeof candidate.contextMode === 'string' &&
    typeof candidate.templateId === 'string' &&
    typeof candidate.includeSupportingContext === 'boolean' &&
    isContextCaptureMode(candidate.contextMode)
  );
}

function isRerunTaskPanelInboundMessage(message: unknown): message is RerunTaskPanelInboundMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<RerunTaskPanelInboundMessage>;
  return candidate.type === 'rerunTask' && typeof candidate.targetStageId === 'string' && isRerunnableStageId(candidate.targetStageId);
}

function isRerunnableStageId(value: string): value is RerunnableStageId {
  return value === 'structurizer' || value === 'router' || value === 'planner' || value === 'reasoner' || value === 'verifier' || value === 'executor';
}

function isContextCaptureMode(value: string): value is ContextCaptureMode {
  return value === 'template-default' || value === 'selection-first' || value === 'file-first' || value === 'manual-only';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function normalizeTemplateValues(templateValues: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(templateValues)
      .map(([fieldId, value]) => [fieldId, value.trim()])
      .filter(([, value]) => value.length > 0),
  );
}

function buildTemplateTaskText(
  templateDefinition: TaskTemplateDefinition,
  templateValues: Record<string, string>,
  additionalInstructions: string,
): string {
  const lines = [`${templateDefinition.label} task`];

  for (const field of templateDefinition.inputFields) {
    const value = templateValues[field.fieldId];
    if (value) {
      lines.push(`${field.label}: ${value}`);
    }
  }

  if (additionalInstructions.trim().length > 0) {
    lines.push(`Additional instructions: ${additionalInstructions.trim()}`);
  }

  return lines.join('\n');
}

function buildTaskDraftPreview(task: string, templateId: string, templateValues: Record<string, string>): string {
  const trimmedTask = task.trim();

  if (templateId === CUSTOM_TASK_TEMPLATE_ID) {
    return trimmedTask;
  }

  const templateDefinition = getTaskTemplateDefinition(templateId);
  if (!templateDefinition) {
    return trimmedTask;
  }

  return buildTemplateTaskText(templateDefinition, normalizeTemplateValues(templateValues), trimmedTask).trim();
}

function validateTemplateInputs(templateDefinition: TaskTemplateDefinition, templateValues: Record<string, string>): void {
  const missingFields = templateDefinition.inputFields
    .filter((field) => field.required && !templateValues[field.fieldId])
    .map((field) => field.label);

  if (missingFields.length > 0) {
    throw new Error(`Template ${templateDefinition.label} requires: ${missingFields.join(', ')}.`);
  }
}

function resolveTaskTemplateDefinition(templateId: string): TaskTemplateDefinition | undefined {
  if (templateId === CUSTOM_TASK_TEMPLATE_ID) {
    return undefined;
  }

  const templateDefinition = getTaskTemplateDefinition(templateId);
  if (!templateDefinition) {
    throw new Error(`Unknown task template id: ${templateId}.`);
  }

  return templateDefinition;
}

function getEditorContextSnapshot(): EditorContextSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  return {
    uri: getContextUri(editor.document),
    languageId: editor.document.languageId,
    selectionContent: editor.document.getText(editor.selection),
    fileContent: editor.document.getText(),
  };
}

function buildContextCollectionPlan(
  contextMode: ContextCaptureMode,
  templateId: string,
  includeSupportingContext: boolean,
) {
  const templateDefinition = resolveTaskTemplateDefinition(templateId);
  const strategy = resolveContextStrategy(contextMode, templateDefinition?.contextStrategy, includeSupportingContext);
  const plan = planTaskContexts(getEditorContextSnapshot(), strategy);

  return {
    templateDefinition,
    plan,
  };
}

function truncatePreviewText(value: string, length = 180): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function buildContextPreviewMessage(
  contextMode: ContextCaptureMode,
  templateId: string,
  includeSupportingContext: boolean,
): ContextPreviewMessage {
  try {
    const { templateDefinition, plan } = buildContextCollectionPlan(contextMode, templateId, includeSupportingContext);
    const effectiveModeLabel = getContextModeLabel(plan.effectiveStrategy.mode);
    const templatePrefix = templateDefinition ? `${templateDefinition.label} template. ` : 'Freeform task. ';

    return {
      type: 'contextPreview',
      headline: `${effectiveModeLabel} preview`,
      detail: plan.blockingError
        ? `${templatePrefix}${plan.blockingError}`
        : plan.contexts.length === 0
          ? `${templatePrefix}No editor context will be attached.`
          : `${templatePrefix}${plan.contexts.length} context item(s) ready with ${effectiveModeLabel.toLowerCase()} strategy.`,
      warnings: plan.warnings,
      blockingError: plan.blockingError,
      items: plan.contexts.map((context) => ({
        headline: `${context.source} · ${context.priority}`,
        detail: [
          context.languageId ? `language=${context.languageId}` : undefined,
          context.uri ? `uri=${context.uri}` : undefined,
          context.truncated && context.originalLength
            ? `chars=${context.content.length}/${context.originalLength}`
            : `chars=${context.content.length}`,
        ]
          .filter(Boolean)
          .join(' · '),
        preview: truncatePreviewText(context.content),
      })),
    };
  } catch (error) {
    return {
      type: 'contextPreview',
      headline: 'Context preview unavailable',
      detail: error instanceof Error ? error.message : 'Unexpected context preview error.',
      warnings: [],
      items: [],
      blockingError: error instanceof Error ? error.message : 'Unexpected context preview error.',
    };
  }
}

function buildTaskRequest(
  task: string,
  contextMode: ContextCaptureMode,
  ignoreCache: boolean,
  templateId: string,
  templateValues: Record<string, string>,
  includeSupportingContext: boolean,
  modelOverrideMode: ModelOverrideMode,
  overrideModelId: string,
): TaskRequest {
  const normalizedTask = task.trim();
  const normalizedTemplateValues = normalizeTemplateValues(templateValues);
  const { templateDefinition, plan } = buildContextCollectionPlan(contextMode, templateId, includeSupportingContext);
  const policyOverrides = buildModelPolicyOverrides(modelOverrideMode, overrideModelId, loadModelOverrideCatalog());

  if (templateDefinition) {
    validateTemplateInputs(templateDefinition, normalizedTemplateValues);
  }

  const resolvedTask = templateDefinition
    ? buildTemplateTaskText(templateDefinition, normalizedTemplateValues, normalizedTask)
    : normalizedTask;

  if (!resolvedTask.trim()) {
    throw new Error('Enter task text or choose a template with the required inputs before submitting.');
  }

  if (plan.blockingError) {
    throw new Error(plan.blockingError);
  }

  return TaskRequestSchema.parse({
    task: resolvedTask,
    taskType: templateDefinition?.taskType,
    taskTemplate: templateDefinition
      ? {
          templateId: templateDefinition.templateId,
          values: normalizedTemplateValues,
        }
      : undefined,
    constraints: templateDefinition?.defaultConstraints ?? [],
    cacheMode: ignoreCache ? 'bypass' : 'default',
    contexts: plan.contexts,
    policyOverrides,
  });
}

function formatTaskPolicyOverride(policyOverrides: TaskPolicyOverrides | undefined, selectedModelId?: string): string {
  const override = describeTaskModelOverride(policyOverrides, selectedModelId);
  return `${override.summary}. ${override.detail}`;
}

function getSupportedRerunTargets(taskResponse: TaskResponse): RerunnableStageId[] {
  const route = taskResponse.checkpoint.routeDecision?.route ?? taskResponse.checkpoint.pipeline.route;
  return route === 'complex'
    ? ['structurizer', 'router', 'planner', 'reasoner', 'verifier', 'executor']
    : ['structurizer', 'router', 'executor'];
}

function buildRerunTaskRequest(taskResponse: TaskResponse, targetStageId: RerunnableStageId): RerunTaskRequest {
  if (!getSupportedRerunTargets(taskResponse).includes(targetStageId)) {
    throw new Error(`Stage ${targetStageId} is unavailable for current checkpoint route.`);
  }

  return {
    targetStageId,
    checkpoint: taskResponse.checkpoint,
  };
}

function getContextUri(document: vscode.TextDocument): string {
  return document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
}

function formatTaskRequestSummary(taskRequest: TaskRequest, contextMode: ContextCaptureMode): string {
  const templateDefinition = taskRequest.taskTemplate ? getTaskTemplateDefinition(taskRequest.taskTemplate.templateId) : undefined;
  const templatePrefix = templateDefinition
    ? `Template ${templateDefinition.label}. `
    : 'Freeform task. ';
  const overrideSummary = formatTaskPolicyOverride(taskRequest.policyOverrides);

  if (taskRequest.contexts.length === 0) {
    return `${templatePrefix}${getContextModeLabel(contextMode)} mode. Cache ${taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'enabled'}. ${overrideSummary} Manual input only. No editor context attached.`;
  }

  const details = taskRequest.contexts
    .map((context: TaskContext) => {
      const parts: string[] = [context.source, context.priority];
      if (context.languageId) {
        parts.push(context.languageId);
      }
      if (context.uri) {
        parts.push(context.uri);
      }
      if (context.truncated && context.originalLength) {
        parts.push(`truncated=${context.content.length}/${context.originalLength}`);
      }
      return parts.join(' / ');
    })
    .join('; ');

  return `${templatePrefix}${getContextModeLabel(contextMode)} mode. Cache ${taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'enabled'}. ${overrideSummary} Captured ${taskRequest.contexts.length} editor context item(s): ${details}.`;
}

function formatTaskResponseSummary(
  taskResponse: TaskResponse,
  readyMode: OrchestratorReadyMode,
  processId: number | undefined,
): string {
  const processState = readyMode === 'started' ? 'Started local orchestrator' : 'Reused running orchestrator';
  const pidSuffix = processId ? ` pid=${processId}.` : '.';
  const providerStatus = taskResponse.providerResult.status === 'completed' ? 'completed' : 'failed';
  const cacheStatus = taskResponse.cacheInfo?.status ?? 'unknown';
  const diagnosticSuffix = taskResponse.diagnostic
    ? ` Diagnostic: ${taskResponse.diagnostic.category}/${taskResponse.diagnostic.code}.`
    : '';
  const runtimeSuffix = taskResponse.selectedProvider.runtimeId
    ? ` via ${taskResponse.selectedProvider.runtimeId}/${taskResponse.selectedProvider.deploymentMode ?? 'unknown'}`
    : '';
  const pipelineSuffix = ` Pipeline: ${taskResponse.pipeline.graph}/${taskResponse.pipeline.state}.`;
  const plannerSuffix = taskResponse.plannerResult
    ? ` Planner: ${taskResponse.plannerResult.status}/${taskResponse.plannerResult.steps.length} steps.`
    : '';
  const reasonerSuffix = taskResponse.reasonerResult
    ? ` Reasoner: ${taskResponse.reasonerResult.status}/${taskResponse.reasonerResult.decisionSource}.`
    : '';
  const runSuffix = taskResponse.runInfo.mode === 'stage-rerun'
    ? ` Execution: stage rerun from ${taskResponse.runInfo.targetStageId}.`
    : ' Execution: full run.';
  const overrideSummary = describeTaskModelOverride(
    taskResponse.checkpoint.taskRequest.policyOverrides,
    taskResponse.selectedProvider.modelId,
  );
  const overrideSuffix = overrideSummary.summary === 'Automatic routing'
    ? ` Selection: ${overrideSummary.summary}.`
    : ` Selection: ${overrideSummary.summary}. ${overrideSummary.detail}`;

  return `${processState}${pidSuffix} Route: ${taskResponse.routeDecision.route}/${taskResponse.routeDecision.status}. Provider: ${taskResponse.selectedProvider.providerId}/${taskResponse.selectedProvider.modelId}${runtimeSuffix} (${providerStatus}). Cache: ${cacheStatus}.${pipelineSuffix}${plannerSuffix}${reasonerSuffix}${runSuffix}${overrideSuffix}${diagnosticSuffix}`;
}

function formatRunModeSummary(taskResponse: TaskResponse): string {
  return taskResponse.runInfo.mode === 'stage-rerun'
    ? `Stage rerun · ${taskResponse.runInfo.targetStageId}`
    : 'Full run';
}

function formatRunModeDetail(taskResponse: TaskResponse): string {
  const reusedStages = taskResponse.runInfo.reusedCheckpointStages.length > 0
    ? ` reused=${taskResponse.runInfo.reusedCheckpointStages.join(',')}`
    : '';
  const historySuffix = taskResponse.runInfo.historyTraceCount > 0
    ? ` historyTrace=${taskResponse.runInfo.historyTraceCount}`
    : '';

  return `${taskResponse.runInfo.detail}.${reusedStages}${historySuffix}`.trim();
}

function formatRuntimeSummary(selectedProvider: TaskResponse['selectedProvider']): string {
  if (!selectedProvider.runtimeId && !selectedProvider.deploymentMode && !selectedProvider.apiFamily) {
    return 'Hosted provider profile.';
  }

  const parts = [
    selectedProvider.runtimeId ? `runtime=${selectedProvider.runtimeId}` : undefined,
    selectedProvider.deploymentMode ? `deployment=${selectedProvider.deploymentMode}` : undefined,
    selectedProvider.apiFamily ? `apiFamily=${selectedProvider.apiFamily}` : undefined,
  ].filter(Boolean);

  return parts.join(' · ');
}

function formatSelectedModel(selectedProvider: TaskResponse['selectedProvider']): string {
  const base = `${selectedProvider.providerId}/${selectedProvider.modelId}`;
  return selectedProvider.runtimeId ? `${selectedProvider.runtimeId} · ${base}` : base;
}

function formatDiagnosticDetail(diagnostic: TaskResponse['diagnostic']): string {
  if (!diagnostic) {
    return 'No task diagnostic.';
  }

  const parts = [`${diagnostic.category}/${diagnostic.code}`, diagnostic.message];
  if (diagnostic.providerId) {
    parts.push(`provider=${diagnostic.providerId}`);
  }
  if (diagnostic.runtimeId) {
    parts.push(`runtime=${diagnostic.runtimeId}`);
  }
  if (diagnostic.deploymentMode) {
    parts.push(`deployment=${diagnostic.deploymentMode}`);
  }
  if (diagnostic.apiFamily) {
    parts.push(`apiFamily=${diagnostic.apiFamily}`);
  }
  if (diagnostic.retriable !== undefined) {
    parts.push(`retriable=${diagnostic.retriable}`);
  }
  return parts.join(' · ');
}

function formatTaskDiagnostic(taskResponse: TaskResponse): { diagnosticSummary: string; diagnosticDetail: string } {
  if (!taskResponse.diagnostic) {
    return {
      diagnosticSummary: 'No diagnostic',
      diagnosticDetail: 'Task completed without classified failure state.',
    };
  }

  return {
    diagnosticSummary: `${taskResponse.diagnostic.summary} · ${taskResponse.diagnostic.category}`,
    diagnosticDetail: formatDiagnosticDetail(taskResponse.diagnostic),
  };
}

function formatPipelineSummary(taskResponse: TaskResponse): string {
  const stagePath = taskResponse.pipeline.stages.map((stage) => `${stage.stageId}:${stage.state}`).join(' -> ');
  return `${taskResponse.pipeline.graph} · route=${taskResponse.pipeline.route} · state=${taskResponse.pipeline.state}${stagePath ? ` · ${stagePath}` : ''}`;
}

function formatPipelineStageEntries(taskResponse: TaskResponse): string[] {
  return taskResponse.pipeline.stages.map((stage) => {
    const dependencySuffix = stage.dependsOn.length > 0 ? ` · dependsOn=${stage.dependsOn.join(',')}` : '';
    const skippedSuffix = stage.skippedReason ? ` · skipped=${stage.skippedReason}` : '';
    const errorSuffix = stage.error ? ` · error=${stage.error.code}:${stage.error.message}` : '';
    return `pipeline/${stage.stageId} · ${stage.state}${dependencySuffix}${skippedSuffix}${errorSuffix}`;
  });
}

function formatPipelineTransitionEntries(taskResponse: TaskResponse): string[] {
  return taskResponse.pipeline.transitions.map((transition) => {
    const detailSuffix = transition.detail ? ` · ${transition.detail}` : '';
    return `transition/${transition.stageId} · ${transition.fromState} -> ${transition.toState}${detailSuffix}`;
  });
}

function formatPlannerEntries(taskResponse: TaskResponse): string[] {
  if (!taskResponse.plannerResult) {
    return [];
  }

  return [
    `planner/result · ${taskResponse.plannerResult.status} · steps=${taskResponse.plannerResult.steps.length}, decisionPoints=${taskResponse.plannerResult.decisionPoints.length} · ${taskResponse.plannerResult.summary}`,
    ...taskResponse.plannerResult.steps.map((step) => `planner/step/${step.stepId} · ${step.title} · ${step.objective}`),
  ];
}

function formatReasonerEntries(taskResponse: TaskResponse): string[] {
  if (!taskResponse.reasonerResult) {
    return [];
  }

  return [
    `reasoner/result · ${taskResponse.reasonerResult.status} · needReasoning=${taskResponse.reasonerResult.needReasoning} · ${taskResponse.reasonerResult.summary}`,
    ...taskResponse.reasonerResult.keyEvidence.map((evidence, index) => `reasoner/evidence/${index + 1} · ${evidence}`),
    ...(taskResponse.reasonerResult.earlyExitReason ? [`reasoner/early-exit · ${taskResponse.reasonerResult.earlyExitReason}`] : []),
  ];
}

function formatRunModeEntries(taskResponse: TaskResponse): string[] {
  return [
    `run/mode · ${taskResponse.runInfo.mode}${taskResponse.runInfo.targetStageId ? ` · target=${taskResponse.runInfo.targetStageId}` : ''} · ${taskResponse.runInfo.detail}`,
    ...(taskResponse.runInfo.reusedCheckpointStages.length > 0
      ? [`run/reused-stages · ${taskResponse.runInfo.reusedCheckpointStages.join(',')}`]
      : []),
  ];
}

function createTaskResultView(taskResponse: TaskResponse): TaskResultView {
  const routingInsight = buildRoutingInsight(taskResponse);
  const traceEntries = taskResponse.trace.map((traceEvent) => {
    const metadataEntries = Object.entries(traceEvent.metadata);
    const metadataSuffix =
      metadataEntries.length > 0
        ? ` · ${metadataEntries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`
        : '';
    const detailSuffix = traceEvent.detail ? ` · ${traceEvent.detail}` : '';
    const errorSuffix = traceEvent.error ? ` · error=${traceEvent.error.code}:${traceEvent.error.message}` : '';
    return `${traceEvent.stage} · ${traceEvent.status}${metadataSuffix}${detailSuffix}${errorSuffix}`;
  });

  const tokenSummary = formatTokenSummary(taskResponse);
  const latencySummary = formatLatencySummary(taskResponse);
  const { diagnosticSummary, diagnosticDetail } = formatTaskDiagnostic(taskResponse);
  const { cacheSummary, cacheDetail } = formatCacheSummary(taskResponse);
  const { costSummary, costDetail } = formatCostSummary(taskResponse);

  return {
    output: taskResponse.output,
    runModeSummary: formatRunModeSummary(taskResponse),
    runModeDetail: formatRunModeDetail(taskResponse),
    selectedModel: formatSelectedModel(taskResponse.selectedProvider),
    runtimeSummary: formatRuntimeSummary(taskResponse.selectedProvider),
    selectionReason: taskResponse.selectedProvider.reason,
    routeSummary: routingInsight.routeSummary,
    routeDetail: routingInsight.routeDetail,
    routeReason: routingInsight.routeReason,
    overrideSummary: routingInsight.overrideSummary,
    overrideDetail: routingInsight.overrideDetail,
    earlyExitSummary: routingInsight.earlyExitSummary,
    earlyExitDetail: routingInsight.earlyExitDetail,
    executionPathSummary: formatPipelineSummary(taskResponse),
    diagnosticSummary,
    diagnosticDetail,
    cacheSummary,
    cacheDetail,
    tokenSummary,
    latencySummary,
    costSummary,
    costDetail,
    timelineStages: buildPipelineTimeline(taskResponse),
    rerunTargets: getSupportedRerunTargets(taskResponse),
    traceEntries: [
      ...formatRunModeEntries(taskResponse),
      ...formatPlannerEntries(taskResponse),
      ...formatReasonerEntries(taskResponse),
      ...formatPipelineStageEntries(taskResponse),
      ...formatPipelineTransitionEntries(taskResponse),
      ...traceEntries,
    ],
  };
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? '?' : value.toLocaleString('en-US');
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) {
    return 'Unknown';
  }

  if (value < 0.001) {
    return `$${value.toFixed(6)}`;
  }

  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(2)}`;
}

function formatTokenSummary(taskResponse: TaskResponse): string {
  const estimate = taskResponse.costEstimate;
  if (estimate.usageSource === 'unknown') {
    return 'Unknown token usage';
  }

  return `${formatTokenCount(estimate.inputTokens)} in / ${formatTokenCount(estimate.outputTokens)} out / ${formatTokenCount(estimate.totalTokens)} total`;
}

function formatLatencySummary(taskResponse: TaskResponse): string {
  const latencyMs = taskResponse.costEstimate.latencyMs ?? taskResponse.providerResult.latencyMs;
  return latencyMs === undefined ? 'Unknown latency' : `${latencyMs} ms`;
}

function formatCacheSummary(taskResponse: TaskResponse): { cacheSummary: string; cacheDetail: string } {
  const cacheInfo = taskResponse.cacheInfo;
  if (!cacheInfo) {
    return {
      cacheSummary: 'No cache metadata',
      cacheDetail: 'Task response did not include cache annotation.',
    };
  }

  const label = cacheInfo.status === 'hit' ? 'Hit' : cacheInfo.status === 'miss' ? 'Miss' : 'Bypassed';
  const createdAtSuffix = cacheInfo.createdAt ? ` Stored: ${cacheInfo.createdAt}.` : '';

  return {
    cacheSummary: `${label} · ${cacheInfo.storage}`,
    cacheDetail: `${cacheInfo.detail}${createdAtSuffix}`,
  };
}

function formatCostSummary(taskResponse: TaskResponse): { costSummary: string; costDetail: string } {
  const estimate = taskResponse.costEstimate;
  if (estimate.status === 'unknown') {
    if (taskResponse.selectedProvider.deploymentMode === 'local') {
      return {
        costSummary: 'Local cost unknown',
        costDetail: estimate.detail,
      };
    }

    return {
      costSummary: 'Unknown cost',
      costDetail: estimate.detail,
    };
  }

  return {
    costSummary: `${estimate.status === 'exact' ? 'Exact' : 'Estimated'} · ${formatUsd(estimate.totalCostUsd)} USD`,
    costDetail: estimate.detail,
  };
}

function postTaskStatus(webview: vscode.Webview, message: Omit<TaskPanelStatusMessage, 'type'>): void {
  void webview.postMessage({
    type: 'taskStatus',
    ...message,
  });
}

function postContextPreview(webview: vscode.Webview, message: ContextPreviewMessage): void {
  void webview.postMessage(message);
}

function getTaskPanelHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const modelOverrideCatalog = loadModelOverrideCatalog();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <title>LLM Crane Task</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 20px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }

      .shell {
        display: grid;
        gap: 16px;
      }

      .eyebrow {
        margin: 0 0 4px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      .intro {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      .composer {
        display: grid;
        gap: 12px;
      }

      label {
        font-weight: 600;
      }

      input,
      select,
      textarea {
        width: 100%;
        padding: 12px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 6px;
        font: inherit;
      }

      select {
        appearance: none;
      }

      textarea {
        min-height: 180px;
        resize: vertical;
        line-height: 1.5;
      }

      input:focus,
      select:focus,
      textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .field-group {
        display: grid;
        gap: 8px;
      }

      .template-fields {
        display: grid;
        gap: 12px;
      }

      .preview-snippet {
        margin: 0;
        padding: 12px;
        border-radius: 8px;
        background: var(--vscode-textCodeBlock-background);
        color: var(--vscode-textPreformat-foreground);
        white-space: pre-wrap;
        line-height: 1.5;
        max-height: 180px;
        overflow: auto;
      }

      .actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .action-buttons {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      button {
        border: none;
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        font-weight: 600;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        cursor: pointer;
      }

      button:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .secondary-button {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }

      .secondary-button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
      }

      .checkbox-row input {
        margin: 0;
      }

      .status-panel {
        display: grid;
        gap: 8px;
        padding: 14px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-panel-border));
      }

      .status-row {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 78px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }

      .status-idle .status-badge {
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
      }

      .status-running .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconQueued);
      }

      .status-success .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconPassed);
      }

      .status-error .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconFailed);
      }

      .status-detail {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      .submitted-task {
        margin: 0;
        padding: 12px;
        border-radius: 8px;
        background: var(--vscode-textCodeBlock-background);
        color: var(--vscode-textPreformat-foreground);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .preview-label {
        display: inline-block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .request-preview {
        margin: 0;
        padding: 12px;
        border-radius: 8px;
        background: var(--vscode-textCodeBlock-background);
        color: var(--vscode-textPreformat-foreground);
        white-space: pre-wrap;
        line-height: 1.5;
        max-height: 220px;
        overflow: auto;
      }

      .result-panel {
        display: grid;
        gap: 12px;
        padding: 14px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-textBlockQuote-background));
      }

      .result-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .result-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font-size: 12px;
        font-weight: 700;
      }

      .result-output {
        margin: 0;
        padding: 14px;
        border-radius: 8px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        line-height: 1.6;
      }

      .result-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .meta-card {
        display: grid;
        gap: 6px;
        padding: 12px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-panel-border));
      }

      .meta-value {
        margin: 0;
        line-height: 1.5;
      }

      .trace-list {
        display: grid;
        gap: 8px;
        margin: 0;
        padding-left: 18px;
      }

      .timeline-list {
        display: grid;
        gap: 12px;
      }

      .timeline-card {
        display: grid;
        gap: 8px;
        padding: 12px 14px;
        border: 1px solid var(--vscode-panel-border);
        border-left-width: 4px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-panel-border));
      }

      .timeline-pending {
        border-left-color: var(--vscode-disabledForeground);
      }

      .timeline-running {
        border-left-color: var(--vscode-textLink-foreground);
      }

      .timeline-completed {
        border-left-color: var(--vscode-terminal-ansiGreen);
      }

      .timeline-failed {
        border-left-color: var(--vscode-errorForeground);
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-errorForeground));
      }

      .timeline-skipped {
        border-left-color: var(--vscode-disabledForeground);
      }

      .timeline-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .timeline-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .timeline-order {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        min-height: 30px;
        border-radius: 999px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        font-size: 12px;
        font-weight: 700;
      }

      .timeline-stage-meta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .timeline-badge,
      .timeline-duration {
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 12px;
        background: var(--vscode-editor-inactiveSelectionBackground);
      }

      .timeline-summary,
      .timeline-detail,
      .timeline-error {
        margin: 0;
        line-height: 1.5;
      }

      .timeline-detail {
        color: var(--vscode-descriptionForeground);
      }

      .timeline-error {
        color: var(--vscode-errorForeground);
      }

      .trace-list li {
        line-height: 1.5;
      }

      .usage {
        display: grid;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      ol {
        margin: 0;
        padding-left: 18px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <p class="eyebrow">V1-S11</p>
        <h1>LLM Crane Run Task</h1>
        <p class="intro">
          Use Command Palette entry to open panel, choose a task template or freeform mode, preview template-aware context capture,
          then submit from inside VS Code. Current step adds manual model override controls, configured-model validation,
          and clearer rerun guidance while keeping routing explanation, timeline, context preview, diagnostics, cache,
          execution path, trace, token usage, latency, and cost estimate.
        </p>
      </header>

      <section class="composer">
        <div class="field-group">
          <label for="task-template">Task template</label>
          <select id="task-template">
            <option value="${CUSTOM_TASK_TEMPLATE_ID}" selected>Custom freeform task</option>
            ${BUILT_IN_TASK_TEMPLATES.map((template) => `<option value="${template.templateId}">${template.label}</option>`).join('')}
          </select>
          <span class="hint" id="task-template-description">Use freeform text or choose a template with default constraints.</span>
          <span class="hint" id="task-template-constraints"></span>
        </div>

        <div class="field-group">
          <label for="context-mode">Context mode</label>
          <select id="context-mode">
            <option value="template-default" selected>Template default</option>
            <option value="selection-first">Selection first, fallback to file</option>
            <option value="file-first">Current file first, fallback to selection</option>
            <option value="manual-only">Manual only</option>
          </select>
          <span class="hint" id="context-mode-hint">Template default chooses strategy from selected template.</span>
        </div>

        <label class="checkbox-row" for="include-supporting-context">
          <input id="include-supporting-context" type="checkbox" />
          Include supporting context when available
        </label>

        <div class="field-group">
          <label for="model-override-mode">Model override</label>
          <select id="model-override-mode"${modelOverrideCatalog.available ? '' : ' disabled'}>
            <option value="auto" selected>Auto</option>
            <option value="simple-default">Use simple default (${modelOverrideCatalog.defaultSimpleModel})</option>
            <option value="complex-default">Use complex default (${modelOverrideCatalog.defaultComplexModel})</option>
            <option value="specific">Choose specific model</option>
          </select>
          <span class="hint" id="model-override-hint">${modelOverrideCatalog.available
            ? `Auto follows router. Simple default=${modelOverrideCatalog.defaultSimpleModel} · complex default=${modelOverrideCatalog.defaultComplexModel}.`
            : `Model override unavailable. ${modelOverrideCatalog.error ?? 'Runtime configuration missing.'}`}</span>
        </div>

        <div class="field-group" id="specific-model-block" hidden>
          <label for="specific-model">Specific model</label>
          <select id="specific-model"${modelOverrideCatalog.options.length > 0 ? '' : ' disabled'}>
            <option value="">Choose configured model</option>
            ${modelOverrideCatalog.options.map((option) => `<option value="${option.modelId}">${option.label}</option>`).join('')}
          </select>
          <span class="hint" id="specific-model-hint">${modelOverrideCatalog.options.length > 0
            ? 'Configured models only. Unconfigured models are blocked before submit.'
            : 'No configured models available for specific override.'}</span>
        </div>

        <div class="field-group" id="template-fields-block" hidden>
          <label>Template inputs</label>
          <div class="template-fields" id="template-fields"></div>
        </div>

        <div class="field-group">
          <label for="task-input">Additional instructions</label>
          <textarea id="task-input" placeholder="Example: Review current file, explain bug risk, propose small refactor."></textarea>
          <span class="hint">Freeform mode requires task text. Template mode can run from template inputs alone and will append anything typed here.</span>
        </div>

        <label class="checkbox-row" for="ignore-cache">
          <input id="ignore-cache" type="checkbox" />
          Ignore cache and force fresh run
        </label>
      </section>

      <section class="status-panel" id="context-preview-panel" aria-live="polite">
        <div class="status-row">
          <strong id="context-preview-headline">Context preview</strong>
        </div>
        <p class="status-detail" id="context-preview-detail">Refresh preview to inspect editor context before sending.</p>
        <div class="actions">
          <div class="action-buttons">
            <button id="refresh-context-preview" type="button" class="secondary-button">Refresh Context Preview</button>
          </div>
          <span class="hint">Preview shows effective capture strategy, source, priority, and truncation.</span>
        </div>
        <div id="context-preview-warning-block" hidden>
          <span class="preview-label">Context warnings</span>
          <ul class="trace-list" id="context-preview-warnings"></ul>
        </div>
        <div class="result-grid" id="context-preview-list"></div>
      </section>

      <div class="actions">
        <div class="action-buttons">
          <button id="run-task" type="button">Run Task</button>
          <button id="rerun-bypass-cache" type="button" class="secondary-button">Run Without Cache</button>
        </div>
        <span class="hint">Shortcut: Cmd/Ctrl + Enter</span>
      </div>

      <section class="status-panel status-idle" id="status-panel" aria-live="polite">
        <div class="status-row">
          <span class="status-badge" id="status-badge">Idle</span>
          <strong id="status-headline">Task panel ready</strong>
        </div>
        <p class="status-detail" id="status-detail">Describe task and press Run Task.</p>
        <div id="task-preview-block" hidden>
          <span class="preview-label">Latest task</span>
          <pre class="submitted-task" id="submitted-task"></pre>
        </div>
        <div id="request-preview-block" hidden>
          <span class="preview-label">Validated TaskRequest</span>
          <pre class="request-preview" id="request-preview"></pre>
        </div>
      </section>

      <section class="result-panel" id="result-panel" hidden>
        <div class="result-header">
          <h2>Latest result</h2>
          <span class="result-chip" id="result-model-chip"></span>
        </div>
        <pre class="result-output" id="result-output"></pre>
        <div class="result-grid">
          <div class="meta-card">
            <span class="preview-label">Execution mode</span>
            <p class="meta-value" id="result-run-mode"></p>
            <p class="hint" id="result-run-mode-detail"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Selected runtime</span>
            <p class="meta-value" id="result-model"></p>
            <p class="hint" id="result-runtime"></p>
            <p class="hint" id="result-reason"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Routing</span>
            <p class="meta-value" id="result-route"></p>
            <p class="hint" id="result-route-detail"></p>
            <p class="hint" id="result-override"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Route rationale</span>
            <p class="meta-value" id="result-route-reason"></p>
            <p class="hint" id="result-early-exit"></p>
            <p class="hint" id="result-early-exit-detail"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Execution path</span>
            <p class="meta-value" id="result-path"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Override source</span>
            <p class="meta-value" id="result-override-summary"></p>
            <p class="hint" id="result-override-detail"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Diagnostic</span>
            <p class="meta-value" id="result-diagnostic"></p>
            <p class="hint" id="result-diagnostic-detail"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Cache</span>
            <p class="meta-value" id="result-cache"></p>
            <p class="hint" id="result-cache-detail"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Usage and latency</span>
            <p class="meta-value" id="result-usage"></p>
            <p class="hint" id="result-latency"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Cost estimate</span>
            <p class="meta-value" id="result-cost"></p>
            <p class="hint" id="result-cost-detail"></p>
          </div>
        </div>
        <div class="actions">
          <div class="action-buttons">
            <select id="rerun-stage" disabled>
              <option value="">Choose stage rerun target</option>
            </select>
            <button id="rerun-stage-button" type="button" class="secondary-button" disabled>Rerun From Stage</button>
          </div>
          <span class="hint" id="rerun-stage-hint">Run full task once to unlock stage rerun.</span>
        </div>
        <div>
          <span class="preview-label">Pipeline timeline</span>
          <div class="timeline-list" id="timeline-list"></div>
        </div>
        <div>
          <span class="preview-label">Trace</span>
          <ul class="trace-list" id="trace-list"></ul>
        </div>
      </section>

      <section class="usage">
        <h2>How to use</h2>
        <ol>
          <li>Run <strong>LLM Crane: Run Task</strong> from Command Palette.</li>
          <li>Choose freeform, refactor, debug, or architecture-analysis template and fill any required template inputs.</li>
          <li>Choose template default, selection-first, current-file-first, or manual-only mode, then refresh preview if editor state changed.</li>
          <li>Choose automatic model selection, default-model override, or specific configured model before submit.</li>
          <li>Press <strong>Run Task</strong> or <strong>Run Without Cache</strong> and inspect output, diagnostic category, cache state, model choice, path summary, trace, or failure detail.</li>
          <li>After result lands, choose checkpoint stage and press <strong>Rerun From Stage</strong> to resume from Planner, Reasoner, Verifier, or Executor using latest checkpointed override state when available.</li>
        </ol>
      </section>
    </main>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const taskTemplates = ${JSON.stringify(BUILT_IN_TASK_TEMPLATES)};
      const modelOverrideCatalog = ${JSON.stringify(modelOverrideCatalog)};
      const customTaskTemplateId = '${CUSTOM_TASK_TEMPLATE_ID}';
      const statusLabels = {
        idle: 'Idle',
        running: 'Running',
        success: 'Success',
        error: 'Failed',
      };

      const templateSelect = document.getElementById('task-template');
      const templateDescription = document.getElementById('task-template-description');
      const templateConstraints = document.getElementById('task-template-constraints');
      const contextModeInput = document.getElementById('context-mode');
      const contextModeHint = document.getElementById('context-mode-hint');
      const includeSupportingContextInput = document.getElementById('include-supporting-context');
      const modelOverrideModeInput = document.getElementById('model-override-mode');
      const modelOverrideHint = document.getElementById('model-override-hint');
      const specificModelBlock = document.getElementById('specific-model-block');
      const specificModelInput = document.getElementById('specific-model');
      const specificModelHint = document.getElementById('specific-model-hint');
      const templateFieldsBlock = document.getElementById('template-fields-block');
      const templateFields = document.getElementById('template-fields');
      const taskInput = document.getElementById('task-input');
      const ignoreCacheInput = document.getElementById('ignore-cache');
      const refreshContextPreviewButton = document.getElementById('refresh-context-preview');
      const runTaskButton = document.getElementById('run-task');
      const rerunBypassButton = document.getElementById('rerun-bypass-cache');
      const contextPreviewHeadline = document.getElementById('context-preview-headline');
      const contextPreviewDetail = document.getElementById('context-preview-detail');
      const contextPreviewWarningBlock = document.getElementById('context-preview-warning-block');
      const contextPreviewWarnings = document.getElementById('context-preview-warnings');
      const contextPreviewList = document.getElementById('context-preview-list');
      const statusPanel = document.getElementById('status-panel');
      const statusBadge = document.getElementById('status-badge');
      const statusHeadline = document.getElementById('status-headline');
      const statusDetail = document.getElementById('status-detail');
      const taskPreviewBlock = document.getElementById('task-preview-block');
      const submittedTask = document.getElementById('submitted-task');
      const requestPreviewBlock = document.getElementById('request-preview-block');
      const requestPreview = document.getElementById('request-preview');
      const resultPanel = document.getElementById('result-panel');
      const resultModelChip = document.getElementById('result-model-chip');
      const resultOutput = document.getElementById('result-output');
      const resultRunMode = document.getElementById('result-run-mode');
      const resultRunModeDetail = document.getElementById('result-run-mode-detail');
      const resultModel = document.getElementById('result-model');
      const resultRuntime = document.getElementById('result-runtime');
      const resultReason = document.getElementById('result-reason');
      const resultRoute = document.getElementById('result-route');
      const resultRouteDetail = document.getElementById('result-route-detail');
      const resultRouteReason = document.getElementById('result-route-reason');
      const resultOverride = document.getElementById('result-override');
      const resultOverrideSummary = document.getElementById('result-override-summary');
      const resultOverrideDetail = document.getElementById('result-override-detail');
      const resultEarlyExit = document.getElementById('result-early-exit');
      const resultEarlyExitDetail = document.getElementById('result-early-exit-detail');
      const resultPath = document.getElementById('result-path');
      const resultDiagnostic = document.getElementById('result-diagnostic');
      const resultDiagnosticDetail = document.getElementById('result-diagnostic-detail');
      const resultCache = document.getElementById('result-cache');
      const resultCacheDetail = document.getElementById('result-cache-detail');
      const resultUsage = document.getElementById('result-usage');
      const resultLatency = document.getElementById('result-latency');
      const resultCost = document.getElementById('result-cost');
      const resultCostDetail = document.getElementById('result-cost-detail');
      const timelineList = document.getElementById('timeline-list');
      const rerunStageSelect = document.getElementById('rerun-stage');
      const rerunStageButton = document.getElementById('rerun-stage-button');
      const rerunStageHint = document.getElementById('rerun-stage-hint');
      const traceList = document.getElementById('trace-list');
      const templateFieldState = {};

      function getSelectedTemplate() {
        return taskTemplates.find((template) => template.templateId === templateSelect.value);
      }

      function getTemplateDefaultStrategy() {
        const template = getSelectedTemplate();
        return template?.contextStrategy ?? {
          mode: 'selection-first',
          includeSupportingContext: false,
          maxChars: 6000,
        };
      }

      function getTemplateFieldInputId(templateId, fieldId) {
        return 'template-field-' + templateId + '-' + fieldId;
      }

      function collectTemplateValues() {
        const template = getSelectedTemplate();
        if (!template) {
          return {};
        }

        const values = {};
        for (const field of template.inputFields) {
          const input = document.getElementById(getTemplateFieldInputId(template.templateId, field.fieldId));
          if (!input || typeof input.value !== 'string') {
            continue;
          }

          const value = input.value.trim();
          if (value) {
            values[field.fieldId] = value;
          }
        }

        return values;
      }

      function createTemplateField(template, field, currentValue) {
        const fieldGroup = document.createElement('div');
        fieldGroup.className = 'field-group';

        const label = document.createElement('label');
        label.htmlFor = getTemplateFieldInputId(template.templateId, field.fieldId);
        label.textContent = field.required ? field.label + ' *' : field.label;
        fieldGroup.appendChild(label);

        const input = document.createElement(field.kind === 'long-text' ? 'textarea' : 'input');
        input.id = getTemplateFieldInputId(template.templateId, field.fieldId);
        input.dataset.templateFieldId = field.fieldId;
        if (field.kind === 'short-text') {
          input.type = 'text';
        }
        if (field.placeholder) {
          input.placeholder = field.placeholder;
        }
        if (currentValue) {
          input.value = currentValue;
        }
        if (field.required) {
          input.setAttribute('aria-required', 'true');
        }
        fieldGroup.appendChild(input);

        if (field.description) {
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = field.description;
          fieldGroup.appendChild(hint);
        }

        return fieldGroup;
      }

      function renderTemplateFields() {
        const template = getSelectedTemplate();
        if (!template) {
          templateDescription.textContent = 'Use freeform text or choose a template with default constraints.';
          templateConstraints.textContent = '';
          templateFieldsBlock.hidden = true;
          templateFields.replaceChildren();
          taskInput.placeholder = 'Example: Review current file, explain bug risk, propose small refactor.';
          return;
        }

        const savedValues = templateFieldState[template.templateId] ?? {};
        templateDescription.textContent = template.description;
        templateConstraints.textContent = template.defaultConstraints.length > 0
          ? 'Default constraints: ' + template.defaultConstraints.join(' | ')
          : 'No template defaults.';
        templateFieldsBlock.hidden = false;
        templateFields.replaceChildren(
          ...template.inputFields.map((field) => createTemplateField(template, field, savedValues[field.fieldId] ?? '')),
        );
        taskInput.placeholder = 'Optional extra details, desired output shape, or edge cases.';
      }

      function syncContextControls(resetSupportingContext) {
        const strategy = getTemplateDefaultStrategy();
        const selectedMode = contextModeInput.value;
        const effectiveMode = selectedMode === 'template-default' ? strategy.mode : selectedMode;

        if (resetSupportingContext || selectedMode === 'template-default') {
          includeSupportingContextInput.checked = strategy.includeSupportingContext;
        }

        if (effectiveMode === 'manual-only') {
          includeSupportingContextInput.checked = false;
          includeSupportingContextInput.disabled = true;
        } else {
          includeSupportingContextInput.disabled = false;
        }

        const modeDescription = selectedMode === 'template-default'
          ? 'Template default: ' + strategy.mode + ' · max ' + strategy.maxChars.toLocaleString('en-US') + ' chars/context.'
          : 'Override: ' + effectiveMode + ' · max ' + strategy.maxChars.toLocaleString('en-US') + ' chars/context.';
        contextModeHint.textContent = modeDescription;
      }

      function syncModelOverrideControls() {
        if (!modelOverrideCatalog.available) {
          modelOverrideModeInput.value = 'auto';
          modelOverrideModeInput.disabled = true;
          specificModelBlock.hidden = true;
          specificModelInput.disabled = true;
          modelOverrideHint.textContent = 'Model override unavailable. ' + (modelOverrideCatalog.error || 'Runtime configuration missing.');
          specificModelHint.textContent = 'Configure runtime before using manual model override.';
          return;
        }

        modelOverrideModeInput.disabled = false;
        const selectedMode = modelOverrideModeInput.value;
        const isSpecificMode = selectedMode === 'specific';
        specificModelBlock.hidden = !isSpecificMode;
        specificModelInput.disabled = !isSpecificMode || modelOverrideCatalog.options.length === 0;

        if (selectedMode === 'simple-default') {
          modelOverrideHint.textContent = 'Pinned to simple default model ' + modelOverrideCatalog.defaultSimpleModel + '.';
        } else if (selectedMode === 'complex-default') {
          modelOverrideHint.textContent = 'Pinned to complex default model ' + modelOverrideCatalog.defaultComplexModel + '.';
        } else if (selectedMode === 'specific') {
          modelOverrideHint.textContent = 'Pinned to specific configured model. Route still decides pipeline path.';
        } else {
          modelOverrideHint.textContent = 'Auto follows router. Simple default=' + modelOverrideCatalog.defaultSimpleModel + ' · complex default=' + modelOverrideCatalog.defaultComplexModel + '.';
        }

        specificModelHint.textContent = isSpecificMode
          ? 'Only configured models appear here. Invalid combinations are blocked before submit.'
          : 'Choose specific mode to pin execution to one configured model.';
      }

      function renderContextPreview(message) {
        contextPreviewHeadline.textContent = message.headline;
        contextPreviewDetail.textContent = message.detail;

        if (message.warnings && message.warnings.length > 0) {
          contextPreviewWarningBlock.hidden = false;
          contextPreviewWarnings.replaceChildren(
            ...message.warnings.map((warning) => {
              const item = document.createElement('li');
              item.textContent = warning;
              return item;
            }),
          );
        } else {
          contextPreviewWarningBlock.hidden = true;
          contextPreviewWarnings.replaceChildren();
        }

        if (message.items && message.items.length > 0) {
          contextPreviewList.replaceChildren(
            ...message.items.map((item) => {
              const card = document.createElement('div');
              card.className = 'meta-card';

              const label = document.createElement('span');
              label.className = 'preview-label';
              label.textContent = item.headline;
              card.appendChild(label);

              const detail = document.createElement('p');
              detail.className = 'hint';
              detail.textContent = item.detail;
              card.appendChild(detail);

              const preview = document.createElement('pre');
              preview.className = 'preview-snippet';
              preview.textContent = item.preview;
              card.appendChild(preview);

              return card;
            }),
          );
        } else {
          contextPreviewList.replaceChildren(
            (() => {
              const emptyCard = document.createElement('div');
              emptyCard.className = 'meta-card';

              const label = document.createElement('span');
              label.className = 'preview-label';
              label.textContent = message.blockingError ? 'Blocked' : 'No context';
              emptyCard.appendChild(label);

              const detail = document.createElement('p');
              detail.className = 'meta-value';
              detail.textContent = message.blockingError ? message.blockingError : 'No editor context will be attached.';
              emptyCard.appendChild(detail);

              return emptyCard;
            })(),
          );
        }
      }

      function requestContextPreview() {
        vscode.postMessage({
          type: 'previewContext',
          contextMode: contextModeInput.value,
          templateId: templateSelect.value,
          includeSupportingContext: includeSupportingContextInput.checked,
        });
      }

      function renderTimelineStages(stages) {
        if (!stages || stages.length === 0) {
          const emptyCard = document.createElement('div');
          emptyCard.className = 'timeline-card timeline-pending';

          const summary = document.createElement('p');
          summary.className = 'timeline-summary';
          summary.textContent = 'No pipeline stage data available.';
          emptyCard.appendChild(summary);

          const detail = document.createElement('p');
          detail.className = 'timeline-detail';
          detail.textContent = 'Run task again to collect timeline state and stage summaries.';
          emptyCard.appendChild(detail);

          timelineList.replaceChildren(emptyCard);
          return;
        }

        timelineList.replaceChildren(
          ...stages.map((stage, index) => {
            const card = document.createElement('article');
            card.className = 'timeline-card timeline-' + stage.state;

            const header = document.createElement('div');
            header.className = 'timeline-card-header';

            const titleGroup = document.createElement('div');
            titleGroup.className = 'timeline-title-group';

            const order = document.createElement('span');
            order.className = 'timeline-order';
            order.textContent = String(index + 1).padStart(2, '0');
            titleGroup.appendChild(order);

            const title = document.createElement('strong');
            title.textContent = stage.label;
            titleGroup.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'timeline-stage-meta';

            const state = document.createElement('span');
            state.className = 'timeline-badge';
            state.textContent = stage.statusLabel;
            meta.appendChild(state);

            const duration = document.createElement('span');
            duration.className = 'timeline-duration';
            duration.textContent = stage.duration;
            meta.appendChild(duration);

            header.append(titleGroup, meta);
            card.appendChild(header);

            const summary = document.createElement('p');
            summary.className = 'timeline-summary';
            summary.textContent = stage.summary;
            card.appendChild(summary);

            const detail = document.createElement('p');
            detail.className = 'timeline-detail';
            detail.textContent = stage.detail;
            card.appendChild(detail);

            if (stage.error) {
              const error = document.createElement('p');
              error.className = 'timeline-error';
              error.textContent = stage.error;
              card.appendChild(error);
            }

            return card;
          }),
        );
      }

      function setStatus(status, headline, detail, taskText, payloadPreview, resultView) {
        statusPanel.className = 'status-panel status-' + status;
        statusBadge.textContent = statusLabels[status] ?? 'Idle';
        statusHeadline.textContent = headline;
        statusDetail.textContent = detail;

        if (taskText && taskText.trim()) {
          taskPreviewBlock.hidden = false;
          submittedTask.textContent = taskText;
        } else {
          taskPreviewBlock.hidden = true;
          submittedTask.textContent = '';
        }

        if (payloadPreview && payloadPreview.trim()) {
          requestPreviewBlock.hidden = false;
          requestPreview.textContent = payloadPreview;
        } else {
          requestPreviewBlock.hidden = true;
          requestPreview.textContent = '';
        }

        if (resultView) {
          resultPanel.hidden = false;
          resultModelChip.textContent = resultView.selectedModel;
          resultOutput.textContent = resultView.output;
          resultRunMode.textContent = resultView.runModeSummary;
          resultRunModeDetail.textContent = resultView.runModeDetail;
          resultModel.textContent = resultView.selectedModel;
          resultRuntime.textContent = resultView.runtimeSummary;
          resultReason.textContent = resultView.selectionReason;
          resultRoute.textContent = resultView.routeSummary;
          resultRouteDetail.textContent = resultView.routeDetail;
          resultRouteReason.textContent = resultView.routeReason;
          resultOverride.textContent = resultView.overrideSummary;
          resultOverrideSummary.textContent = resultView.overrideSummary;
          resultOverrideDetail.textContent = resultView.overrideDetail;
          resultEarlyExit.textContent = resultView.earlyExitSummary;
          resultEarlyExitDetail.textContent = resultView.earlyExitDetail;
          resultPath.textContent = resultView.executionPathSummary;
          resultDiagnostic.textContent = resultView.diagnosticSummary;
          resultDiagnosticDetail.textContent = resultView.diagnosticDetail;
          resultCache.textContent = resultView.cacheSummary;
          resultCacheDetail.textContent = resultView.cacheDetail;
          resultUsage.textContent = resultView.tokenSummary;
          resultLatency.textContent = resultView.latencySummary;
          resultCost.textContent = resultView.costSummary;
          resultCostDetail.textContent = resultView.costDetail;
          renderTimelineStages(resultView.timelineStages);
          rerunStageSelect.replaceChildren(
            ...[
              (() => {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'Choose stage rerun target';
                return option;
              })(),
              ...resultView.rerunTargets.map((stageId) => {
                const option = document.createElement('option');
                option.value = stageId;
                option.textContent = stageId;
                return option;
              }),
            ],
          );
          rerunStageSelect.disabled = resultView.rerunTargets.length === 0;
          rerunStageButton.disabled = resultView.rerunTargets.length === 0;
          rerunStageHint.textContent = resultView.rerunTargets.length > 0
            ? 'Reuse latest checkpoint, including manual override state, and rerun from selected stage.'
            : 'Run full task once to unlock stage rerun.';
          traceList.replaceChildren(
            ...resultView.traceEntries.map((entry) => {
              const item = document.createElement('li');
              item.textContent = entry;
              return item;
            }),
          );
        } else {
          resultPanel.hidden = true;
          resultModelChip.textContent = '';
          resultOutput.textContent = '';
          resultRunMode.textContent = '';
          resultRunModeDetail.textContent = '';
          resultModel.textContent = '';
          resultRuntime.textContent = '';
          resultReason.textContent = '';
          resultRoute.textContent = '';
          resultRouteDetail.textContent = '';
          resultRouteReason.textContent = '';
          resultOverride.textContent = '';
          resultOverrideSummary.textContent = '';
          resultOverrideDetail.textContent = '';
          resultEarlyExit.textContent = '';
          resultEarlyExitDetail.textContent = '';
          resultPath.textContent = '';
          resultDiagnostic.textContent = '';
          resultDiagnosticDetail.textContent = '';
          resultCache.textContent = '';
          resultCacheDetail.textContent = '';
          resultUsage.textContent = '';
          resultLatency.textContent = '';
          resultCost.textContent = '';
          resultCostDetail.textContent = '';
          timelineList.replaceChildren();
          rerunStageSelect.replaceChildren();
          rerunStageSelect.disabled = true;
          rerunStageButton.disabled = true;
          rerunStageHint.textContent = 'Run full task once to unlock stage rerun.';
          traceList.replaceChildren();
        }
      }

      function submitTask(ignoreCacheOverride) {
        const value = taskInput.value;
        const contextMode = contextModeInput.value;
        const ignoreCache = ignoreCacheOverride ?? ignoreCacheInput.checked;
        const templateId = templateSelect.value;
        const templateValues = collectTemplateValues();
        const includeSupportingContext = includeSupportingContextInput.checked;
        const modelOverrideMode = modelOverrideModeInput.value;
        const overrideModelId = specificModelInput.value;
        const submittedTask = value.trim() || (templateId === customTaskTemplateId ? '' : templateSelect.options[templateSelect.selectedIndex].textContent + ' template');
        setStatus('running', 'Submitting task', 'Sending task and requested context mode to extension host.', submittedTask, '', '');
        vscode.postMessage({
          type: 'submitTask',
          value,
          contextMode,
          ignoreCache,
          templateId,
          templateValues,
          includeSupportingContext,
          modelOverrideMode,
          overrideModelId,
        });
      }

      function submitRerun() {
        const targetStageId = rerunStageSelect.value;
        if (!targetStageId) {
          return;
        }

        setStatus('running', 'Starting stage rerun', 'Sending selected stage rerun request to extension host.', taskInput.value, '', '');
        vscode.postMessage({ type: 'rerunTask', targetStageId });
      }

      runTaskButton.addEventListener('click', () => submitTask());
      rerunBypassButton.addEventListener('click', () => {
        ignoreCacheInput.checked = true;
        submitTask(true);
      });
      rerunStageButton.addEventListener('click', () => submitRerun());
      refreshContextPreviewButton.addEventListener('click', () => requestContextPreview());
      templateSelect.addEventListener('change', () => {
        renderTemplateFields();
        syncContextControls(true);
        requestContextPreview();
      });
      contextModeInput.addEventListener('change', () => {
        syncContextControls(false);
        requestContextPreview();
      });
      includeSupportingContextInput.addEventListener('change', () => requestContextPreview());
      modelOverrideModeInput.addEventListener('change', () => syncModelOverrideControls());
      templateFields.addEventListener('input', () => {
        const template = getSelectedTemplate();
        if (!template) {
          return;
        }

        templateFieldState[template.templateId] = collectTemplateValues();
      });
      taskInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          submitTask();
        }
      });

      renderTemplateFields();
      syncContextControls(true);
  syncModelOverrideControls();
      requestContextPreview();

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'taskStatus') {
          setStatus(message.status, message.headline, message.detail, message.submittedTask, message.requestPreview, message.resultView);
          return;
        }

        if (message?.type === 'contextPreview') {
          renderContextPreview(message);
        }
      });
    </script>
  </body>
</html>`;
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}