import * as vscode from 'vscode';
import { LLMCraneDiagnosticError } from '@llm-crane/core';
import { TaskRequestSchema, type TaskContext, type TaskRequest, type TaskResponse } from '@llm-crane/schemas';
import {
  OrchestratorProcessManager,
  type OrchestratorReadyMode,
} from './orchestratorProcessManager';

const RUN_TASK_COMMAND = 'llmCrane.runTask';
const TASK_PANEL_VIEW_TYPE = 'llmCrane.taskPanel';

type ContextCaptureMode = 'manual' | 'selection' | 'file' | 'auto';

type TaskPanelInboundMessage = {
  type: 'submitTask';
  value: string;
  contextMode: ContextCaptureMode;
  ignoreCache: boolean;
};

type TaskPanelStatus = 'idle' | 'running' | 'success' | 'error';

type TaskResultView = {
  output: string;
  selectedModel: string;
  selectionReason: string;
  executionPathSummary: string;
  diagnosticSummary: string;
  diagnosticDetail: string;
  cacheSummary: string;
  cacheDetail: string;
  tokenSummary: string;
  latencySummary: string;
  costSummary: string;
  costDetail: string;
  traceEntries: string[];
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

    panel.webview.html = getTaskPanelHtml(panel.webview);
    postTaskStatus(panel.webview, {
      status: 'idle',
      headline: 'Task panel ready',
      detail: 'Choose context mode, then submit task. Current panel shows output, selected model, cache state, execution path, trace, token usage, latency, and cost.',
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

        await handleTaskPanelMessage(panel.webview, message, orchestratorManager);
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
): Promise<void> {
  if (!isTaskPanelInboundMessage(message)) {
    return;
  }

  const taskText = message.value.trim();
  if (!taskText) {
    postTaskStatus(webview, {
      status: 'error',
      headline: 'Task description required',
      detail: 'Enter task text before submitting.',
    });
    return;
  }

  postTaskStatus(webview, {
    status: 'running',
    headline: 'Submitting task',
    detail: `Collecting ${getContextModeLabel(message.contextMode).toLowerCase()} context, then starting or reusing local orchestrator process${message.ignoreCache ? ' with cache bypass enabled' : ''}.`,
    submittedTask: taskText,
  });

  try {
    const taskRequest = buildTaskRequest(taskText, message.contextMode, message.ignoreCache);
    const { response, readyMode, processId } = await processManager.runTask(taskRequest);
    const hasFailureDiagnostic = Boolean(response.diagnostic) || response.providerResult.status === 'failed';

    postTaskStatus(webview, {
      status: hasFailureDiagnostic ? 'error' : 'success',
      headline: hasFailureDiagnostic
        ? response.diagnostic?.summary ?? 'Task completed with failure diagnostics'
        : readyMode === 'started'
          ? 'Orchestrator started and responded'
          : 'Orchestrator response received',
      detail: `${formatTaskRequestSummary(taskRequest, message.contextMode)} ${formatTaskResponseSummary(response, readyMode, processId)}`,
      submittedTask: taskText,
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
      submittedTask: taskText,
    });
  }
}

function isTaskPanelInboundMessage(message: unknown): message is TaskPanelInboundMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<TaskPanelInboundMessage>;
  return (
    candidate.type === 'submitTask' &&
    typeof candidate.value === 'string' &&
    typeof candidate.contextMode === 'string' &&
    typeof candidate.ignoreCache === 'boolean' &&
    isContextCaptureMode(candidate.contextMode)
  );
}

function isContextCaptureMode(value: string): value is ContextCaptureMode {
  return value === 'manual' || value === 'selection' || value === 'file' || value === 'auto';
}

function buildTaskRequest(task: string, contextMode: ContextCaptureMode, ignoreCache: boolean): TaskRequest {
  return TaskRequestSchema.parse({
    task,
    cacheMode: ignoreCache ? 'bypass' : 'default',
    contexts: collectTaskContexts(contextMode),
  });
}

function collectTaskContexts(contextMode: ContextCaptureMode): TaskContext[] {
  if (contextMode === 'manual') {
    return [];
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('Open file in editor before sending selection or file context.');
  }

  const selectionText = editor.document.getText(editor.selection);

  if (contextMode === 'selection') {
    return [createSelectionContext(editor, selectionText)];
  }

  if (contextMode === 'file') {
    return [createFileContext(editor)];
  }

  if (selectionText.trim().length > 0) {
    return [createSelectionContext(editor, selectionText)];
  }

  return [createFileContext(editor)];
}

function createSelectionContext(editor: vscode.TextEditor, selectionText: string): TaskContext {
  if (selectionText.trim().length === 0) {
    throw new Error('Selection mode requires non-empty editor selection.');
  }

  return {
    source: 'selection',
    uri: getContextUri(editor.document),
    languageId: editor.document.languageId,
    content: selectionText,
  };
}

function createFileContext(editor: vscode.TextEditor): TaskContext {
  const content = editor.document.getText();
  if (content.trim().length === 0) {
    throw new Error('Current file is empty. Use manual mode or add file content first.');
  }

  return {
    source: 'file',
    uri: getContextUri(editor.document),
    languageId: editor.document.languageId,
    content,
  };
}

function getContextUri(document: vscode.TextDocument): string {
  return document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
}

function getContextModeLabel(contextMode: ContextCaptureMode): string {
  switch (contextMode) {
    case 'manual':
      return 'Manual only';
    case 'selection':
      return 'Current selection';
    case 'file':
      return 'Current file';
    case 'auto':
      return 'Auto selection/file';
  }
}

function formatTaskRequestSummary(taskRequest: TaskRequest, contextMode: ContextCaptureMode): string {
  if (taskRequest.contexts.length === 0) {
    return `${getContextModeLabel(contextMode)} mode. Cache ${taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'enabled'}. Manual input only. No editor context attached.`;
  }

  const details = taskRequest.contexts
    .map((context: TaskContext) => {
      const parts: string[] = [context.source];
      if (context.languageId) {
        parts.push(context.languageId);
      }
      if (context.uri) {
        parts.push(context.uri);
      }
      return parts.join(' / ');
    })
    .join('; ');

  return `${getContextModeLabel(contextMode)} mode. Cache ${taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'enabled'}. Captured ${taskRequest.contexts.length} editor context item(s): ${details}.`;
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

  return `${processState}${pidSuffix} Route: ${taskResponse.routeDecision.route}/${taskResponse.routeDecision.status}. Provider: ${taskResponse.selectedProvider.providerId}/${taskResponse.selectedProvider.modelId} (${providerStatus}). Cache: ${cacheStatus}.${diagnosticSuffix}`;
}

function formatDiagnosticDetail(diagnostic: TaskResponse['diagnostic']): string {
  if (!diagnostic) {
    return 'No task diagnostic.';
  }

  const parts = [`${diagnostic.category}/${diagnostic.code}`, diagnostic.message];
  if (diagnostic.providerId) {
    parts.push(`provider=${diagnostic.providerId}`);
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

function createTaskResultView(taskResponse: TaskResponse): TaskResultView {
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
    selectedModel: `${taskResponse.selectedProvider.providerId}/${taskResponse.selectedProvider.modelId}`,
    selectionReason: taskResponse.selectedProvider.reason,
    executionPathSummary:
      taskResponse.trace.length > 0
        ? taskResponse.trace.map((traceEvent) => `${traceEvent.stage}:${traceEvent.status}`).join(' -> ')
        : 'No trace events returned.',
    diagnosticSummary,
    diagnosticDetail,
    cacheSummary,
    cacheDetail,
    tokenSummary,
    latencySummary,
    costSummary,
    costDetail,
    traceEntries,
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

function getTaskPanelHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

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

      select:focus,
      textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .field-group {
        display: grid;
        gap: 8px;
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
        <p class="eyebrow">V0-S16</p>
        <h1>LLM Crane Run Task</h1>
        <p class="intro">
          Use Command Palette entry to open panel, describe task, choose context mode, then submit from inside VS Code. Current
          step covers output text, selected model, diagnostic state, cache state, execution path, readable trace, token usage, latency, and cost estimate.
        </p>
      </header>

      <section class="composer">
        <div class="field-group">
          <label for="context-mode">Context mode</label>
          <select id="context-mode">
            <option value="auto" selected>Auto: use selection, else current file</option>
            <option value="manual">Manual only</option>
            <option value="selection">Attach current selection</option>
            <option value="file">Attach current file</option>
          </select>
          <span class="hint">Manual only prevents sending editor content. Auto prefers selection when available.</span>
        </div>

        <div class="field-group">
          <label for="task-input">Task description</label>
          <textarea id="task-input" placeholder="Example: Review current file, explain bug risk, propose small refactor."></textarea>
        </div>

        <label class="checkbox-row" for="ignore-cache">
          <input id="ignore-cache" type="checkbox" />
          Ignore cache and force fresh run
        </label>
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
            <span class="preview-label">Selected model</span>
            <p class="meta-value" id="result-model"></p>
            <p class="hint" id="result-reason"></p>
          </div>
          <div class="meta-card">
            <span class="preview-label">Execution path</span>
            <p class="meta-value" id="result-path"></p>
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
        <div>
          <span class="preview-label">Trace</span>
          <ul class="trace-list" id="trace-list"></ul>
        </div>
      </section>

      <section class="usage">
        <h2>How to use</h2>
        <ol>
          <li>Run <strong>LLM Crane: Run Task</strong> from Command Palette.</li>
          <li>Choose manual-only, selection, file, or auto mode.</li>
          <li>Press <strong>Run Task</strong> or <strong>Run Without Cache</strong> and inspect output, diagnostic category, cache state, model choice, path summary, trace, or failure detail.</li>
        </ol>
      </section>
    </main>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const statusLabels = {
        idle: 'Idle',
        running: 'Running',
        success: 'Success',
        error: 'Failed',
      };

      const contextModeInput = document.getElementById('context-mode');
      const taskInput = document.getElementById('task-input');
      const ignoreCacheInput = document.getElementById('ignore-cache');
      const runTaskButton = document.getElementById('run-task');
      const rerunBypassButton = document.getElementById('rerun-bypass-cache');
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
      const resultModel = document.getElementById('result-model');
      const resultReason = document.getElementById('result-reason');
      const resultPath = document.getElementById('result-path');
      const resultDiagnostic = document.getElementById('result-diagnostic');
      const resultDiagnosticDetail = document.getElementById('result-diagnostic-detail');
      const resultCache = document.getElementById('result-cache');
      const resultCacheDetail = document.getElementById('result-cache-detail');
      const resultUsage = document.getElementById('result-usage');
      const resultLatency = document.getElementById('result-latency');
      const resultCost = document.getElementById('result-cost');
      const resultCostDetail = document.getElementById('result-cost-detail');
      const traceList = document.getElementById('trace-list');

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
          resultModel.textContent = resultView.selectedModel;
          resultReason.textContent = resultView.selectionReason;
          resultPath.textContent = resultView.executionPathSummary;
          resultDiagnostic.textContent = resultView.diagnosticSummary;
          resultDiagnosticDetail.textContent = resultView.diagnosticDetail;
          resultCache.textContent = resultView.cacheSummary;
          resultCacheDetail.textContent = resultView.cacheDetail;
          resultUsage.textContent = resultView.tokenSummary;
          resultLatency.textContent = resultView.latencySummary;
          resultCost.textContent = resultView.costSummary;
          resultCostDetail.textContent = resultView.costDetail;
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
          resultModel.textContent = '';
          resultReason.textContent = '';
          resultPath.textContent = '';
          resultDiagnostic.textContent = '';
          resultDiagnosticDetail.textContent = '';
          resultCache.textContent = '';
          resultCacheDetail.textContent = '';
          resultUsage.textContent = '';
          resultLatency.textContent = '';
          resultCost.textContent = '';
          resultCostDetail.textContent = '';
          traceList.replaceChildren();
        }
      }

      function submitTask(ignoreCacheOverride) {
        const value = taskInput.value;
        const contextMode = contextModeInput.value;
        const ignoreCache = ignoreCacheOverride ?? ignoreCacheInput.checked;
        setStatus('running', 'Submitting task', 'Sending task and requested context mode to extension host.', value, '', '');
        vscode.postMessage({ type: 'submitTask', value, contextMode, ignoreCache });
      }

      runTaskButton.addEventListener('click', () => submitTask());
      rerunBypassButton.addEventListener('click', () => {
        ignoreCacheInput.checked = true;
        submitTask(true);
      });
      taskInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          submitTask();
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type !== 'taskStatus') {
          return;
        }

        setStatus(message.status, message.headline, message.detail, message.submittedTask, message.requestPreview, message.resultView);
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