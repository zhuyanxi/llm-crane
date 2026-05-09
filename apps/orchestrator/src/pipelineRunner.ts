import { createDiagnosticFromError, createProviderDiagnostic } from '@llm-crane/core';
import { estimateModelCost, getProviderIdForModel, type ProviderRegistry } from '@llm-crane/providers';
import { PLANNER_SYSTEM_PROMPT, buildExecutorSystemPrompt, buildStructurizerSystemPrompt } from '@llm-crane/prompts';
import {
  CostEstimateSchema,
  TaskResponseSchema,
  type PlannerResult,
  type PipelineCheckpoint,
  type PipelineTraceEvent,
  type PipelineTraceError,
  type PipelineTraceMetadataValue,
  type Diagnostic,
  type ProviderApiFamily,
  type ProviderDeploymentMode,
  type ProviderExecutionResult,
  type ProviderId,
  type ReasonerInput,
  type ReasonerResult,
  type RerunTaskRequest,
  type RerunnableStageId,
  type RouteDecision,
  type RuntimeConfig,
  type StructurizerResult,
  type TaskRequest,
  type TaskResponse,
  type VerificationResult,
} from '@llm-crane/schemas';
import {
  createExecutorStageInput,
  createExecutorStageOutput,
  createPipelineStateMachine,
  createPlannerStageInput,
  createPlannerStageOutput,
  createReasonerStageInput,
  createReasonerStageOutput,
  createRequestStageInput,
  createRequestStageOutput,
  createResponseStageInput,
  createResponseStageOutput,
  createRouterStageInput,
  createRouterStageOutput,
  createStructurizerStageInput,
  createStructurizerStageOutput,
  createVerifierStageInput,
  createVerifierStageOutput,
} from './pipelineStateMachine';
import {
  buildProviderUserPrompt,
  createFailedProviderExecutionResult,
  invokeRoutedProvider,
} from './providerExecution';
import {
  buildPlannerPrompt,
  createFallbackPlannerResult,
  planTask,
} from './planner';
import {
  buildReasonerInput as buildReasonerInputBase,
  createFallbackReasonerResult as createFallbackReasonerResultBase,
  createSkippedReasonerResult,
  reasonTask as reasonTaskBase,
} from './reasoner';
import { buildRouterScoreInput, createSafeFallbackRouteDecision, routeTask } from './router';
import { buildStructurizerPrompt, createFallbackStructurizerResult, structurizeTaskRequest } from './structurizer';
import { createTaskCheckpoint } from './taskCheckpoint';
import { createVerifierFailureResult, mergeVerificationResults, runRuleVerifiers, verifyTaskWithModel } from './verifier';

type PipelineRunnerDependencies = {
  createTimestamp?: () => string;
  buildStructurizerPrompt?: typeof buildStructurizerPrompt;
  structurizeTaskRequest?: typeof structurizeTaskRequest;
  buildRouterScoreInput?: typeof buildRouterScoreInput;
  routeTask?: typeof routeTask;
  buildPlannerPrompt?: typeof buildPlannerPrompt;
  planTask?: typeof planTask;
  buildReasonerInput?: typeof buildReasonerInputBase;
  reasonTask?: typeof reasonTaskBase;
  createFallbackReasonerResult?: typeof createFallbackReasonerResultBase;
  buildProviderUserPrompt?: typeof buildProviderUserPrompt;
  invokeRoutedProvider?: typeof invokeRoutedProvider;
  verifyTaskOutput?: typeof verifyTaskWithModel;
  runRuleVerifiers?: typeof runRuleVerifiers;
  mergeVerificationResults?: typeof mergeVerificationResults;
};

type TraceStatus = PipelineTraceEvent['status'];
type TraceMetadata = Record<string, PipelineTraceMetadataValue>;

type ResolvedProviderTarget = {
  providerId: ProviderId;
  modelId: string;
  runtimeId?: string;
  deploymentMode?: ProviderDeploymentMode;
  apiFamily?: ProviderApiFamily;
};

type ModelSelectionTier = 'simple' | 'complex' | 'specific';

type ResolvedModelSelection = {
  modelId: string;
  selectionTier: ModelSelectionTier;
  overrideMode?: 'simple-default' | 'complex-default' | 'specific';
  reason: string;
};

type TraceAddOptions = {
  metadata?: TraceMetadata;
  error?: PipelineTraceError;
};

type PipelineRunMode =
  | { mode: 'full' }
  | {
      mode: 'stage-rerun';
      rerun: RerunTaskRequest;
    };

const FULL_RUN_MODE: PipelineRunMode = { mode: 'full' };

const RERUN_STAGE_ORDER: readonly RerunnableStageId[] = ['structurizer', 'router', 'planner', 'reasoner', 'executor', 'verifier'];

const SIMPLE_RERUN_TARGETS = new Set<RerunnableStageId>(['structurizer', 'router', 'executor']);

function getRerunStageIndex(stageId: RerunnableStageId): number {
  return RERUN_STAGE_ORDER.indexOf(stageId);
}

function shouldReuseCheckpointStage(runMode: PipelineRunMode, stageId: RerunnableStageId): boolean {
  if (runMode.mode !== 'stage-rerun') {
    return false;
  }

  return getRerunStageIndex(stageId) < getRerunStageIndex(runMode.rerun.targetStageId);
}

function getCheckpointStage(checkpoint: PipelineCheckpoint, stageId: string) {
  return checkpoint.pipeline.stages.find((stage) => stage.stageId === stageId);
}

function assertRerunRequestSupported(rerun: RerunTaskRequest): void {
  const route = rerun.checkpoint.routeDecision?.route ?? rerun.checkpoint.pipeline.route;
  const targetStageId = rerun.targetStageId;

  if (route === 'simple' && !SIMPLE_RERUN_TARGETS.has(targetStageId)) {
    throw new Error(`Stage rerun target ${targetStageId} is unsupported for simple pipeline checkpoint.`);
  }

  if (shouldReuseCheckpointStage({ mode: 'stage-rerun', rerun }, 'structurizer') && !rerun.checkpoint.structurizerResult) {
    throw new Error('Stage rerun requires structurizer checkpoint before selected target stage.');
  }

  if (shouldReuseCheckpointStage({ mode: 'stage-rerun', rerun }, 'router') && !rerun.checkpoint.routeDecision) {
    throw new Error('Stage rerun requires route checkpoint before selected target stage.');
  }

  if (route === 'complex' && shouldReuseCheckpointStage({ mode: 'stage-rerun', rerun }, 'planner') && !rerun.checkpoint.plannerResult) {
    throw new Error('Stage rerun requires planner checkpoint before selected target stage.');
  }

  if (route === 'complex' && shouldReuseCheckpointStage({ mode: 'stage-rerun', rerun }, 'reasoner') && !rerun.checkpoint.reasonerResult) {
    throw new Error('Stage rerun requires reasoner checkpoint before selected target stage.');
  }

  if (route === 'complex' && shouldReuseCheckpointStage({ mode: 'stage-rerun', rerun }, 'executor') && !rerun.checkpoint.providerResult) {
    throw new Error('Stage rerun requires executor checkpoint before selected target stage.');
  }
}

function createCheckpointReuseDetail(stageId: RerunnableStageId): string {
  return `Stage rerun reused ${stageId} checkpoint from previous run.`;
}

const defaultDependencies: Required<PipelineRunnerDependencies> = {
  createTimestamp: () => new Date().toISOString(),
  buildStructurizerPrompt,
  structurizeTaskRequest,
  buildRouterScoreInput,
  routeTask,
  buildPlannerPrompt,
  planTask,
  buildReasonerInput: buildReasonerInputBase,
  reasonTask: reasonTaskBase,
  createFallbackReasonerResult: createFallbackReasonerResultBase,
  buildProviderUserPrompt,
  invokeRoutedProvider,
  verifyTaskOutput: verifyTaskWithModel,
  runRuleVerifiers,
  mergeVerificationResults,
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactMetadata(metadata: Record<string, PipelineTraceMetadataValue | undefined>): TraceMetadata {
  const compact: TraceMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }

  return compact;
}

function createTraceCollector(createTimestamp: () => string, initialTrace: PipelineTraceEvent[] = []) {
  const trace: PipelineTraceEvent[] = initialTrace.map((event) => ({
    ...event,
    metadata: { ...event.metadata },
    error: event.error ? { ...event.error } : undefined,
  }));

  return {
    add(stage: string, status: TraceStatus, detail: string, options: TraceAddOptions = {}): void {
      trace.push({
        stage,
        status,
        timestamp: createTimestamp(),
        detail,
        metadata: options.metadata ?? {},
        error: options.error,
      });
    },
    list(): PipelineTraceEvent[] {
      return trace;
    },
  };
}

function getModelIdForRoute(config: RuntimeConfig, routeDecision: RouteDecision): string {
  return routeDecision.route === 'simple' ? config.defaultSimpleModel : config.defaultComplexModel;
}

function resolveModelSelection(config: RuntimeConfig, taskRequest: TaskRequest, routeDecision: RouteDecision): ResolvedModelSelection {
  const override = taskRequest.policyOverrides?.modelOverride;
  if (!override) {
    return {
      modelId: getModelIdForRoute(config, routeDecision),
      selectionTier: routeDecision.route,
      reason: routeDecision.reason,
    };
  }

  switch (override.mode) {
    case 'simple-default':
      return {
        modelId: config.defaultSimpleModel,
        selectionTier: 'simple',
        overrideMode: override.mode,
        reason: `Manual override pinned execution to simple default model ${config.defaultSimpleModel} while route remained ${routeDecision.route}. Route reason: ${routeDecision.reason}`,
      };
    case 'complex-default':
      return {
        modelId: config.defaultComplexModel,
        selectionTier: 'complex',
        overrideMode: override.mode,
        reason: `Manual override pinned execution to complex default model ${config.defaultComplexModel} while route remained ${routeDecision.route}. Route reason: ${routeDecision.reason}`,
      };
    case 'specific':
      return {
        modelId: override.modelId,
        selectionTier: 'specific',
        overrideMode: override.mode,
        reason: `Manual override pinned execution to specific model ${override.modelId} while route remained ${routeDecision.route}. Route reason: ${routeDecision.reason}`,
      };
  }
}

function resolveFallbackCandidates(config: RuntimeConfig, modelSelection: ResolvedModelSelection): string[] {
  const fallbackPolicy = config.providerFallback;
  if (!fallbackPolicy?.enabled || modelSelection.selectionTier === 'specific') {
    return [];
  }

  const configuredCandidates = modelSelection.selectionTier === 'simple'
    ? fallbackPolicy.simple
    : fallbackPolicy.complex;

  return [...new Set(configuredCandidates.filter((candidate) => candidate !== modelSelection.modelId))];
}

function resolveFallbackCandidatesForRequest(
  config: RuntimeConfig,
  taskRequest: TaskRequest,
  modelSelection: ResolvedModelSelection,
): string[] {
  if (taskRequest.policyOverrides?.fallbackEnabled === false) {
    return [];
  }

  return resolveFallbackCandidates(config, modelSelection);
}

function applyVerificationPolicyOverrides(taskRequest: TaskRequest, verifierResult: VerificationResult): VerificationResult {
  if (
    taskRequest.policyOverrides?.verificationUpgradeAllowed === false
    && verifierResult.suggestedAction === 'upgrade-model'
  ) {
    return {
      ...verifierResult,
      suggestedAction: 'manual-confirm',
      reasons: [...verifierResult.reasons, 'User policy disabled verification-triggered model upgrade for this request.'],
    };
  }

  return verifierResult;
}

function hasRequestPolicyOverride(taskRequest: TaskRequest, modelSelection: ResolvedModelSelection): boolean {
  return Boolean(
    modelSelection.overrideMode
      || taskRequest.policyOverrides?.fallbackEnabled === false
      || taskRequest.policyOverrides?.verificationUpgradeAllowed === false,
  );
}

function buildPolicyOverrideDetail(taskRequest: TaskRequest, modelSelection: ResolvedModelSelection, modelId: string, route: string): string {
  const detailParts = [
    modelSelection.overrideMode ? `mode=${modelSelection.overrideMode}` : 'mode=auto',
    `model=${modelId}`,
    `route=${route}`,
  ];

  if (taskRequest.policyOverrides?.fallbackEnabled === false) {
    detailParts.push('fallback=disabled');
  }

  if (taskRequest.policyOverrides?.verificationUpgradeAllowed === false) {
    detailParts.push('verificationUpgrade=disabled');
  }

  return detailParts.join('; ');
}

function isFallbackEligibleProviderError(providerResult: ProviderExecutionResult): boolean {
  if (providerResult.status !== 'failed' || !providerResult.error) {
    return false;
  }

  switch (providerResult.error.code) {
    case 'rate_limit':
    case 'timeout':
    case 'network':
    case 'upstream':
    case 'unsupported_model':
    case 'provider_not_configured':
      return true;
    default:
      return false;
  }
}

function buildFallbackSelectionReason(
  currentReason: string,
  fromModelId: string,
  toModelId: string,
  providerResult: ProviderExecutionResult,
): string {
  return `${currentReason} Automatic fallback switched execution from ${fromModelId} to ${toModelId} after ${providerResult.error?.code ?? 'unknown'}: ${providerResult.error?.message ?? 'Unknown provider failure.'}`;
}

function resolveProviderTarget(providerRegistry: ProviderRegistry, modelId: string): ResolvedProviderTarget {
  const descriptor = providerRegistry.describeModel?.(modelId);
  if (descriptor) {
    return descriptor;
  }

  return {
    providerId: getProviderIdForModel(modelId) ?? 'openai',
    modelId,
  };
}

function buildTaskOutput(providerResult: ProviderExecutionResult): string {
  if (providerResult.status === 'completed') {
    return providerResult.outputText;
  }

  return `Task execution failed (${providerResult.error?.code ?? 'unknown'}): ${providerResult.error?.message ?? 'Unknown error.'}`;
}

function buildCostDetail(costEstimate: { totalCostUsd?: number; detail: string }): string {
  if (costEstimate.totalCostUsd === undefined) {
    return costEstimate.detail;
  }

  return `${costEstimate.detail} totalUsd=${costEstimate.totalCostUsd}`;
}

function createStructurizerStageError(structurizerResult: StructurizerResult): PipelineTraceError | undefined {
  return structurizerResult.fallbackReason
    ? {
        code: 'structurizer_fallback',
        message: structurizerResult.fallbackReason,
      }
    : undefined;
}

function createRouterStageError(routeDecision: RouteDecision): PipelineTraceError | undefined {
  return routeDecision.fallbackReason
    ? {
        code: 'router_fallback',
        message: routeDecision.fallbackReason,
      }
    : undefined;
}

function createPlannerStageError(plannerResult: PlannerResult): PipelineTraceError | undefined {
  return plannerResult.fallbackReason
    ? {
        code: 'planner_fallback',
        message: plannerResult.fallbackReason,
      }
    : undefined;
}

function createReasonerStageError(reasonerResult: ReasonerResult): PipelineTraceError | undefined {
  return reasonerResult.fallbackReason
    ? {
        code: 'reasoner_fallback',
        message: reasonerResult.fallbackReason,
      }
    : undefined;
}

function createVerifierStageError(verifierResult: VerificationResult): PipelineTraceError | undefined {
  if (verifierResult.verdict !== 'fail') {
    return undefined;
  }

  const criticalFinding = verifierResult.findings.find((finding) => finding.severity === 'fail') ?? verifierResult.findings[0];

  return {
    code: criticalFinding?.code ?? 'verifier_failed',
    message: criticalFinding?.summary ?? verifierResult.summary,
  };
}

function annotateVerifierSkip(
  trace: ReturnType<typeof createTraceCollector>,
  pipelineMachine: ReturnType<typeof createPipelineStateMachine>,
  routeDecision: RouteDecision,
  plannerResult: PlannerResult,
  providerResult: ProviderExecutionResult,
  output: string,
  detail: string,
  verifierResult: VerificationResult,
): VerificationResult {
  if (routeDecision.route !== 'complex') {
    throw new Error('Verifier skip annotation only applies to complex route.');
  }

  pipelineMachine.updateContext({
    verifierResult,
  });
  pipelineMachine.skipStage('verifier', detail, createVerifierStageOutput('skipped', detail, verifierResult), {
    input: createVerifierStageInput(
      routeDecision,
      providerResult.status,
      plannerResult.status,
      plannerResult.steps.length,
      pipelineMachine.context.taskRequest.constraints.length,
      plannerResult.downstreamHints.verifierChecks.length,
      output.length,
    ),
  });
  trace.add('verifier.finish', 'skipped', detail, {
    metadata: compactMetadata({
      route: routeDecision.route,
      executorStatus: providerResult.status,
      plannerStatus: plannerResult.status,
      planStepCount: plannerResult.steps.length,
      constraintCount: pipelineMachine.context.taskRequest.constraints.length,
      verifierCheckCount: plannerResult.downstreamHints.verifierChecks.length,
      outputChars: output.length,
      verifierVerdict: verifierResult.verdict,
      suggestedAction: verifierResult.suggestedAction,
    }),
  });
  return verifierResult;
}

export async function runTaskPipeline(
  config: RuntimeConfig,
  providerRegistry: ProviderRegistry,
  taskRequest: TaskRequest,
  overrides: PipelineRunnerDependencies = {},
  runMode: PipelineRunMode = FULL_RUN_MODE,
): Promise<TaskResponse> {
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  if (runMode.mode === 'stage-rerun') {
    assertRerunRequestSupported(runMode.rerun);
  }

  const rerunRequest = runMode.mode === 'stage-rerun' ? runMode.rerun : undefined;
  const historyTrace = rerunRequest?.checkpoint.trace ?? [];
  const reusedCheckpointStages: RerunnableStageId[] = [];
  const trace = createTraceCollector(dependencies.createTimestamp, historyTrace);
  const pipelineMachine = createPipelineStateMachine(taskRequest, dependencies.createTimestamp);

  trace.add('pipeline.start', 'running', runMode.mode === 'stage-rerun' ? `Stage rerun started from ${runMode.rerun.targetStageId}.` : 'Task pipeline started.', {
    metadata: compactMetadata({
      taskChars: taskRequest.task.length,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
      runMode: runMode.mode,
      targetStageId: runMode.mode === 'stage-rerun' ? runMode.rerun.targetStageId : undefined,
    }),
  });
  if (rerunRequest) {
    trace.add('rerun.resume', 'completed', `Retained ${historyTrace.length} trace event(s) and resumed from ${rerunRequest.targetStageId}.`, {
      metadata: compactMetadata({
        targetStageId: rerunRequest.targetStageId,
        historyTraceCount: historyTrace.length,
        historyTransitionCount: rerunRequest.checkpoint.pipeline.transitions.length,
      }),
    });
  }
  pipelineMachine.startStage('request', createRequestStageInput(taskRequest));
  pipelineMachine.completeStage('request', createRequestStageOutput());
  trace.add('request.received', 'completed', runMode.mode === 'stage-rerun' ? 'Stage rerun request accepted by orchestrator.' : 'Task request accepted by orchestrator.', {
    metadata: compactMetadata({
      qualityBar: taskRequest.qualityBar,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
    }),
  });
  let structurizerResult: StructurizerResult;
  if (shouldReuseCheckpointStage(runMode, 'structurizer')) {
    structurizerResult = rerunRequest?.checkpoint.structurizerResult as StructurizerResult;
    reusedCheckpointStages.push('structurizer');
    pipelineMachine.updateContext({
      structurizerResult,
    });
    pipelineMachine.skipStage(
      'structurizer',
      createCheckpointReuseDetail('structurizer'),
      createStructurizerStageOutput(structurizerResult),
      {
        input: getCheckpointStage(rerunRequest?.checkpoint as PipelineCheckpoint, 'structurizer')?.input ?? createStructurizerStageInput(taskRequest),
      },
    );
    trace.add('structurizer.reuse', 'skipped', createCheckpointReuseDetail('structurizer'), {
      metadata: compactMetadata({
        taskType: structurizerResult.structuredTask.taskType,
        targetStageId: rerunRequest?.targetStageId,
      }),
    });
  } else {
    trace.add('structurizer.start', 'running', 'Structurizer stage started.', {
      metadata: compactMetadata({
        taskChars: taskRequest.task.length,
        contextCount: taskRequest.contexts.length,
      }),
    });
    pipelineMachine.startStage('structurizer', createStructurizerStageInput(taskRequest));

    try {
      const structurizerPrompt = dependencies.buildStructurizerPrompt(taskRequest);
      const structurizerSystemPrompt = buildStructurizerSystemPrompt(taskRequest.taskTemplate?.templateId);
      trace.add(
        'structurizer.prompt',
        'completed',
        `promptChars=${structurizerPrompt.length}; systemPromptChars=${structurizerSystemPrompt.length}`,
        {
          metadata: compactMetadata({
            promptChars: structurizerPrompt.length,
            systemPromptChars: structurizerSystemPrompt.length,
          }),
        },
      );
      structurizerResult = dependencies.structurizeTaskRequest(taskRequest);
      pipelineMachine.updateContext({
        structurizerResult,
      });
      pipelineMachine.completeStage('structurizer', createStructurizerStageOutput(structurizerResult), {
        error: createStructurizerStageError(structurizerResult),
      });
      trace.add(
        'structurizer.finish',
        structurizerResult.status === 'structured' ? 'completed' : 'failed',
        `status=${structurizerResult.status}; taskType=${structurizerResult.structuredTask.taskType}; openQuestions=${structurizerResult.structuredTask.openQuestions.length}`,
        {
          metadata: compactMetadata({
            taskType: structurizerResult.structuredTask.taskType,
            openQuestions: structurizerResult.structuredTask.openQuestions.length,
            uncertaintyCount: structurizerResult.structuredTask.uncertaintyReasons.length,
          }),
          error: structurizerResult.fallbackReason
            ? {
                code: 'structurizer_fallback',
                message: structurizerResult.fallbackReason,
              }
            : undefined,
        },
      );
    } catch (error) {
      const reason = `Structurizer stage crashed: ${toErrorMessage(error)}`;
      structurizerResult = createFallbackStructurizerResult(taskRequest, reason);
      pipelineMachine.updateContext({
        structurizerResult,
      });
      pipelineMachine.completeStage('structurizer', createStructurizerStageOutput(structurizerResult), {
        detail: reason,
        error: {
          code: 'structurizer_crash',
          message: reason,
        },
      });
      trace.add('structurizer.finish', 'failed', reason, {
        error: {
          code: 'structurizer_crash',
          message: reason,
        },
      });
    }
  }

  let routeDecision: RouteDecision;
  if (shouldReuseCheckpointStage(runMode, 'router')) {
    routeDecision = rerunRequest?.checkpoint.routeDecision as RouteDecision;
    reusedCheckpointStages.push('router');
    pipelineMachine.updateContext({
      routeDecision,
    });
    pipelineMachine.setGraph(routeDecision.route);
    pipelineMachine.skipStage('router', createCheckpointReuseDetail('router'), createRouterStageOutput(routeDecision), {
      input: getCheckpointStage(rerunRequest?.checkpoint as PipelineCheckpoint, 'router')?.input ?? createRouterStageInput(structurizerResult),
    });
    trace.add('router.reuse', 'skipped', createCheckpointReuseDetail('router'), {
      metadata: compactMetadata({
        route: routeDecision.route,
        complexityScore: routeDecision.complexityScore,
        targetStageId: rerunRequest?.targetStageId,
      }),
    });
  } else {
    trace.add('router.start', 'running', 'Router stage started.', {
      metadata: compactMetadata({
        structurizerStatus: structurizerResult.status,
        warningCount: structurizerResult.warnings.length,
      }),
    });
    pipelineMachine.startStage('router', createRouterStageInput(structurizerResult));

    try {
      const routerScoreInput = dependencies.buildRouterScoreInput(structurizerResult);
      trace.add('router.score-input', 'completed', `chars=${routerScoreInput.length}`, {
        metadata: compactMetadata({
          inputChars: routerScoreInput.length,
        }),
      });
      routeDecision = dependencies.routeTask(structurizerResult);
      pipelineMachine.updateContext({
        routeDecision,
      });
      pipelineMachine.setGraph(routeDecision.route);
      pipelineMachine.completeStage('router', createRouterStageOutput(routeDecision), {
        error: createRouterStageError(routeDecision),
      });
      trace.add(
        'router.finish',
        routeDecision.status === 'routed' ? 'completed' : 'failed',
        `route=${routeDecision.route}; score=${routeDecision.complexityScore}; confidence=${routeDecision.confidence}`,
        {
          metadata: compactMetadata({
            route: routeDecision.route,
            complexityScore: routeDecision.complexityScore,
            confidence: routeDecision.confidence,
            scoreFactors: routeDecision.scoreBreakdown.length,
          }),
          error: routeDecision.fallbackReason
            ? {
                code: 'router_fallback',
                message: routeDecision.fallbackReason,
              }
            : undefined,
        },
      );
    } catch (error) {
      const reason = `Router stage crashed: ${toErrorMessage(error)}`;
      routeDecision = createSafeFallbackRouteDecision(reason);
      pipelineMachine.updateContext({
        routeDecision,
      });
      pipelineMachine.setGraph(routeDecision.route);
      pipelineMachine.completeStage('router', createRouterStageOutput(routeDecision), {
        detail: reason,
        error: {
          code: 'router_crash',
          message: reason,
        },
      });
      trace.add('router.finish', 'failed', reason, {
        error: {
          code: 'router_crash',
          message: reason,
        },
      });
    }
  }

  let plannerResult: PlannerResult | undefined;
  let reasonerResult: ReasonerResult | undefined;
  let verifierResult: VerificationResult | undefined;

  if (routeDecision.route === 'complex') {
    if (shouldReuseCheckpointStage(runMode, 'planner')) {
      plannerResult = rerunRequest?.checkpoint.plannerResult as PlannerResult;
      reusedCheckpointStages.push('planner');
      pipelineMachine.updateContext({
        plannerResult,
      });
      pipelineMachine.skipStage('planner', createCheckpointReuseDetail('planner'), createPlannerStageOutput(plannerResult), {
        input: getCheckpointStage(rerunRequest?.checkpoint as PipelineCheckpoint, 'planner')?.input ?? createPlannerStageInput(routeDecision, structurizerResult),
      });
      trace.add('planner.reuse', 'skipped', createCheckpointReuseDetail('planner'), {
        metadata: compactMetadata({
          plannerStatus: plannerResult.status,
          planStepCount: plannerResult.steps.length,
          targetStageId: rerunRequest?.targetStageId,
        }),
      });
    } else {
      trace.add('planner.start', 'running', 'Planner stage started.', {
        metadata: compactMetadata({
          route: routeDecision.route,
          taskType: structurizerResult.structuredTask.taskType,
          openQuestions: structurizerResult.structuredTask.openQuestions.length,
        }),
      });
      pipelineMachine.startStage('planner', createPlannerStageInput(routeDecision, structurizerResult));

      try {
        const plannerPrompt = dependencies.buildPlannerPrompt(taskRequest, structurizerResult, routeDecision);
        trace.add(
          'planner.prompt',
          'completed',
          `promptChars=${plannerPrompt.length}; systemPromptChars=${PLANNER_SYSTEM_PROMPT.length}`,
          {
            metadata: compactMetadata({
              promptChars: plannerPrompt.length,
              systemPromptChars: PLANNER_SYSTEM_PROMPT.length,
            }),
          },
        );

        plannerResult = dependencies.planTask(taskRequest, structurizerResult, routeDecision);
        pipelineMachine.updateContext({
          plannerResult,
        });
        pipelineMachine.completeStage('planner', createPlannerStageOutput(plannerResult), {
          error: createPlannerStageError(plannerResult),
        });
        trace.add(
          'planner.finish',
          plannerResult.status === 'planned' ? 'completed' : 'failed',
          `status=${plannerResult.status}; steps=${plannerResult.steps.length}; decisionPoints=${plannerResult.decisionPoints.length}`,
          {
            metadata: compactMetadata({
              plannerStatus: plannerResult.status,
              planStepCount: plannerResult.steps.length,
              decisionPointCount: plannerResult.decisionPoints.length,
              openQuestionCount: plannerResult.openQuestions.length,
            }),
            error: createPlannerStageError(plannerResult),
          },
        );
      } catch (error) {
        const reason = `Planner stage crashed: ${toErrorMessage(error)}`;
        plannerResult = createFallbackPlannerResult(taskRequest, structurizerResult, routeDecision, reason);
        pipelineMachine.updateContext({
          plannerResult,
        });
        pipelineMachine.completeStage('planner', createPlannerStageOutput(plannerResult), {
          detail: reason,
          error: {
            code: 'planner_crash',
            message: reason,
          },
        });
        trace.add('planner.finish', 'failed', reason, {
          metadata: compactMetadata({
            plannerStatus: plannerResult.status,
            planStepCount: plannerResult.steps.length,
            decisionPointCount: plannerResult.decisionPoints.length,
            openQuestionCount: plannerResult.openQuestions.length,
          }),
          error: {
            code: 'planner_crash',
            message: reason,
          },
        });
      }
    }
  }

  if (routeDecision.route === 'simple') {
    const reasonerInput = dependencies.buildReasonerInput(taskRequest, structurizerResult, routeDecision, plannerResult);
    reasonerResult = createSkippedReasonerResult(reasonerInput);
    pipelineMachine.updateContext({
      reasonerResult,
    });
    trace.add('reasoner.finish', 'skipped', reasonerResult.earlyExitReason ?? reasonerResult.summary, {
      metadata: compactMetadata({
        route: routeDecision.route,
        needReasoning: reasonerResult.needReasoning,
        decisionSource: reasonerResult.decisionSource,
        earlyExit: true,
      }),
    });
  } else if (plannerResult) {
    if (shouldReuseCheckpointStage(runMode, 'reasoner')) {
      reasonerResult = rerunRequest?.checkpoint.reasonerResult as ReasonerResult;
      reusedCheckpointStages.push('reasoner');
      pipelineMachine.updateContext({
        reasonerResult,
      });
      pipelineMachine.skipStage('reasoner', createCheckpointReuseDetail('reasoner'), createReasonerStageOutput(reasonerResult, createCheckpointReuseDetail('reasoner')), {
        input:
          getCheckpointStage(rerunRequest?.checkpoint as PipelineCheckpoint, 'reasoner')?.input ??
          createReasonerStageInput(
            taskRequest,
            routeDecision,
            true,
            plannerResult.status,
            plannerResult.steps.length,
            dependencies.buildReasonerInput(taskRequest, structurizerResult, routeDecision, plannerResult),
          ),
      });
      trace.add('reasoner.reuse', 'skipped', createCheckpointReuseDetail('reasoner'), {
        metadata: compactMetadata({
          route: routeDecision.route,
          reasonerStatus: reasonerResult.status,
          targetStageId: rerunRequest?.targetStageId,
        }),
      });
    } else {
      let reasonerInput: ReasonerInput | undefined;

      try {
        reasonerInput = dependencies.buildReasonerInput(taskRequest, structurizerResult, routeDecision, plannerResult);
        trace.add('reasoner.input', 'completed', `keyContext=${reasonerInput.keyContext.length}; focus=${reasonerInput.plannerFocus.length}`, {
          metadata: compactMetadata({
            route: routeDecision.route,
            needReasoning: reasonerInput.needReasoning,
            decisionSource: reasonerInput.decisionSource,
            keyContextCount: reasonerInput.keyContext.length,
            decisionPointCount: reasonerInput.decisionPoints.length,
            plannerFocusCount: reasonerInput.plannerFocus.length,
          }),
        });

        if (!reasonerInput.needReasoning) {
          reasonerResult = createSkippedReasonerResult(reasonerInput);
          pipelineMachine.updateContext({
            reasonerResult,
          });
          pipelineMachine.skipStage(
            'reasoner',
            reasonerResult.earlyExitReason ?? reasonerResult.summary,
            createReasonerStageOutput(reasonerResult),
            {
              input: createReasonerStageInput(
                taskRequest,
                routeDecision,
                true,
                plannerResult.status,
                plannerResult.steps.length,
                reasonerInput,
              ),
            },
          );
          trace.add('reasoner.finish', 'skipped', reasonerResult.earlyExitReason ?? reasonerResult.summary, {
            metadata: compactMetadata({
              route: routeDecision.route,
              needReasoning: false,
              decisionSource: reasonerResult.decisionSource,
              plannerStatus: plannerResult.status,
              earlyExit: true,
            }),
          });
        } else {
          trace.add('reasoner.start', 'running', 'Reasoner stage started.', {
            metadata: compactMetadata({
              route: routeDecision.route,
              plannerStatus: plannerResult.status,
              decisionSource: reasonerInput.decisionSource,
              escalationReason: reasonerInput.escalationReason,
            }),
          });
          pipelineMachine.startStage(
            'reasoner',
            createReasonerStageInput(
              taskRequest,
              routeDecision,
              true,
              plannerResult.status,
              plannerResult.steps.length,
              reasonerInput,
            ),
          );
          reasonerResult = dependencies.reasonTask(reasonerInput);
          pipelineMachine.updateContext({
            reasonerResult,
          });
          pipelineMachine.completeStage('reasoner', createReasonerStageOutput(reasonerResult), {
            error: createReasonerStageError(reasonerResult),
          });
          trace.add(
            'reasoner.finish',
            reasonerResult.status === 'reasoned' ? 'completed' : 'failed',
            reasonerResult.summary,
            {
              metadata: compactMetadata({
                route: routeDecision.route,
                reasonerStatus: reasonerResult.status,
                needReasoning: reasonerResult.needReasoning,
                decisionSource: reasonerResult.decisionSource,
                evidenceCount: reasonerResult.keyEvidence.length,
              }),
              error: createReasonerStageError(reasonerResult),
            },
          );
        }
      } catch (error) {
        const fallbackInput = reasonerInput ?? buildReasonerInputBase(taskRequest, structurizerResult, routeDecision, plannerResult);
        const reason = `Reasoner stage crashed: ${toErrorMessage(error)}`;

        if (pipelineMachine.serialize().stages.some((stage) => stage.stageId === 'reasoner' && stage.state === 'pending')) {
          pipelineMachine.startStage(
            'reasoner',
            createReasonerStageInput(
              taskRequest,
              routeDecision,
              true,
              plannerResult.status,
              plannerResult.steps.length,
              fallbackInput,
            ),
          );
        }

        reasonerResult = dependencies.createFallbackReasonerResult(fallbackInput, reason);
        pipelineMachine.updateContext({
          reasonerResult,
        });
        pipelineMachine.completeStage('reasoner', createReasonerStageOutput(reasonerResult), {
          detail: reason,
          error: createReasonerStageError(reasonerResult) ?? {
            code: 'reasoner_crash',
            message: reason,
          },
        });
        trace.add('reasoner.finish', 'failed', reason, {
          metadata: compactMetadata({
            route: routeDecision.route,
            plannerStatus: plannerResult.status,
            needReasoning: fallbackInput.needReasoning,
            decisionSource: fallbackInput.decisionSource,
          }),
          error: {
            code: 'reasoner_crash',
            message: reason,
          },
        });
      }
    }

  }

  const modelSelection = resolveModelSelection(config, taskRequest, routeDecision);
  const fallbackCandidates = resolveFallbackCandidatesForRequest(config, taskRequest, modelSelection);
  const reusedExecutorResult = shouldReuseCheckpointStage(runMode, 'executor') ? rerunRequest?.checkpoint.providerResult : undefined;
  let modelId = reusedExecutorResult?.modelId ?? modelSelection.modelId;
  let providerTarget = resolveProviderTarget(providerRegistry, modelId);
  let selectedProviderReason = modelSelection.reason;
  const providerId = providerTarget.providerId;
  pipelineMachine.updateContext({
    providerTarget,
  });
  if (hasRequestPolicyOverride(taskRequest, modelSelection)) {
    trace.add('policy.override', 'completed', buildPolicyOverrideDetail(taskRequest, modelSelection, modelId, routeDecision.route), {
      metadata: compactMetadata({
        mode: modelSelection.overrideMode,
        modelId,
        providerId,
        route: routeDecision.route,
        routeDefaultModel: getModelIdForRoute(config, routeDecision),
        fallbackEnabled: taskRequest.policyOverrides?.fallbackEnabled,
        verificationUpgradeAllowed: taskRequest.policyOverrides?.verificationUpgradeAllowed,
      }),
    });
  }
  pipelineMachine.startStage('executor', createExecutorStageInput(routeDecision, providerTarget));
  trace.add('executor.start', 'running', 'Executor stage started.', {
    metadata: compactMetadata({
      providerId,
      modelId,
      runtimeId: providerTarget.runtimeId,
      deploymentMode: providerTarget.deploymentMode,
      apiFamily: providerTarget.apiFamily,
      route: routeDecision.route,
    }),
  });

  let providerResult: ProviderExecutionResult;
  let providerPrompt: string | undefined;
  let diagnostic: Diagnostic | undefined;

  if (shouldReuseCheckpointStage(runMode, 'executor')) {
    providerResult = rerunRequest?.checkpoint.providerResult as ProviderExecutionResult;
    diagnostic = rerunRequest?.checkpoint.diagnostic;
    reusedCheckpointStages.push('executor');
    const executorDetail = createCheckpointReuseDetail('executor');
    const executorCheckpointStage = getCheckpointStage(rerunRequest?.checkpoint as PipelineCheckpoint, 'executor');
    pipelineMachine.updateContext({
      providerResult,
      diagnostic,
    });
    pipelineMachine.skipStage(
      'executor',
      executorDetail,
      executorCheckpointStage?.output ?? createExecutorStageOutput(providerResult),
      {
        input: executorCheckpointStage?.input ?? createExecutorStageInput(routeDecision, providerTarget),
      },
    );
    trace.add('executor.reuse', 'skipped', executorDetail, {
      metadata: compactMetadata({
        providerId: providerResult.providerId,
        modelId: providerResult.modelId,
        targetStageId: rerunRequest?.targetStageId,
      }),
      error: providerResult.error
        ? {
            code: providerResult.error.code,
            message: providerResult.error.message,
          }
        : undefined,
    });
  } else {
    try {
      providerPrompt = dependencies.buildProviderUserPrompt(taskRequest, structurizerResult, routeDecision, plannerResult, reasonerResult);
      const executorSystemPrompt = buildExecutorSystemPrompt(structurizerResult.structuredTask.template?.templateId);
      trace.add(
        'executor.prompt',
        'completed',
        `systemChars=${executorSystemPrompt.length}; userChars=${providerPrompt.length}`,
        {
          metadata: compactMetadata({
            systemChars: executorSystemPrompt.length,
            userChars: providerPrompt.length,
          }),
        },
      );

      const invokeSelectedModel = async (): Promise<ProviderExecutionResult> => dependencies.invokeRoutedProvider(
        providerRegistry,
        modelId,
        taskRequest,
        structurizerResult,
        routeDecision,
        plannerResult,
        reasonerResult,
        {
          retryPolicy: config.providerRetry,
          onRetryAttempt: async (attemptInfo) => {
            trace.add(
              'executor.retry',
              'retrying',
              `attempt=${attemptInfo.attempt}; nextAttempt=${attemptInfo.nextAttempt}; delayMs=${attemptInfo.delayMs}; error=${attemptInfo.error.code}`,
              {
                metadata: compactMetadata({
                  providerId: attemptInfo.providerId,
                  modelId: attemptInfo.modelId,
                  runtimeId: providerTarget.runtimeId,
                  deploymentMode: providerTarget.deploymentMode,
                  apiFamily: providerTarget.apiFamily,
                  retriable: true,
                  attempt: attemptInfo.attempt,
                  nextAttempt: attemptInfo.nextAttempt,
                  maxRetries: attemptInfo.maxRetries,
                  backoffStrategy: attemptInfo.backoffStrategy,
                  delayMs: attemptInfo.delayMs,
                  retryScheduled: true,
                }),
                error: {
                  code: attemptInfo.error.code,
                  message: attemptInfo.error.message,
                },
              },
            );
          },
        },
      );

      providerResult = await invokeSelectedModel();

      let fallbackAttempt = 0;
      const pendingFallbackCandidates = [...fallbackCandidates];
      while (providerResult.status === 'failed' && isFallbackEligibleProviderError(providerResult) && pendingFallbackCandidates.length > 0) {
        const failedModelId = modelId;
        const nextModelId = pendingFallbackCandidates.shift() as string;
        fallbackAttempt += 1;
        trace.add(
          'executor.fallback',
          'retrying',
          `attempt=${fallbackAttempt}; from=${failedModelId}; to=${nextModelId}; error=${providerResult.error?.code ?? 'unknown'}`,
          {
            metadata: compactMetadata({
              attempt: fallbackAttempt,
              fromModelId: failedModelId,
              toModelId: nextModelId,
              route: routeDecision.route,
              providerId: providerResult.providerId,
              errorCode: providerResult.error?.code ?? 'unknown',
              fallbackEnabled: config.providerFallback?.enabled ?? false,
            }),
            error: providerResult.error
              ? {
                  code: providerResult.error.code,
                  message: providerResult.error.message,
                }
              : undefined,
          },
        );
        modelId = nextModelId;
        providerTarget = resolveProviderTarget(providerRegistry, modelId);
        selectedProviderReason = buildFallbackSelectionReason(selectedProviderReason, failedModelId, nextModelId, providerResult);
        providerResult = await invokeSelectedModel();
      }

      pipelineMachine.updateContext({
        providerResult,
      });
      if (providerResult.status === 'completed') {
        pipelineMachine.completeStage('executor', createExecutorStageOutput(providerResult));
      } else {
        pipelineMachine.failStage(
          'executor',
          {
            code: providerResult.error?.code ?? 'unknown',
            message: providerResult.error?.message ?? 'Provider invocation failed.',
          },
          createExecutorStageOutput(providerResult),
        );
      }

      trace.add(
        'executor.invoke',
        providerResult.status === 'completed' ? 'completed' : 'failed',
        providerResult.status === 'completed'
          ? `provider=${providerResult.providerId}; model=${providerResult.modelId}; latencyMs=${providerResult.latencyMs ?? -1}`
          : `provider=${providerResult.providerId}; model=${providerResult.modelId}; error=${providerResult.error?.code ?? 'unknown'}`,
        {
          metadata: compactMetadata({
            providerId: providerResult.providerId,
            modelId: providerResult.modelId,
            runtimeId: providerTarget.runtimeId,
            deploymentMode: providerTarget.deploymentMode,
            apiFamily: providerTarget.apiFamily,
            latencyMs: providerResult.latencyMs,
            retriable: providerResult.error?.retriable,
          }),
          error: providerResult.error
            ? {
                code: providerResult.error.code,
                message: providerResult.error.message,
              }
            : undefined,
        },
      );
    } catch (error) {
      const reason = `Executor stage crashed: ${toErrorMessage(error)}`;
      providerResult = createFailedProviderExecutionResult(modelId, new Error(reason), providerId);
      diagnostic = createDiagnosticFromError(error, {
        category: 'internal',
        code: 'internal.executor_prompt_crash',
        summary: 'Executor stage failed',
        message: 'LLM Crane failed before provider call completed.',
        stage: 'executor.prompt',
      });
      pipelineMachine.updateContext({
        providerResult,
        diagnostic,
      });
      pipelineMachine.failStage(
        'executor',
        {
          code: 'executor_prompt_crash',
          message: reason,
        },
        createExecutorStageOutput(providerResult),
        {
          detail: reason,
        },
      );
      trace.add('executor.prompt', 'failed', reason, {
        error: {
          code: 'executor_prompt_crash',
          message: reason,
        },
      });
      trace.add('executor.invoke', 'skipped', 'Executor invoke skipped after prompt failure.', {
        metadata: compactMetadata({
          providerId,
          modelId,
          runtimeId: providerTarget.runtimeId,
          deploymentMode: providerTarget.deploymentMode,
          apiFamily: providerTarget.apiFamily,
        }),
      });
    }
  }

  const output = shouldReuseCheckpointStage(runMode, 'executor')
    ? rerunRequest?.checkpoint.output ?? buildTaskOutput(providerResult)
    : buildTaskOutput(providerResult);
  const costEstimate = CostEstimateSchema.parse(
    estimateModelCost({
      modelId,
      usage: providerResult.usage,
      promptText: providerPrompt,
      outputText: providerResult.outputText,
      latencyMs: providerResult.latencyMs,
      executionStatus: providerResult.status,
      runtimeId: providerTarget.runtimeId,
      deploymentMode: providerTarget.deploymentMode,
      apiFamily: providerTarget.apiFamily,
    }),
  );
  diagnostic = diagnostic ?? (providerResult.status === 'failed' && providerResult.error
    ? createProviderDiagnostic(providerResult.error, 'executor.invoke', {
        runtimeId: providerTarget.runtimeId,
        deploymentMode: providerTarget.deploymentMode,
        apiFamily: providerTarget.apiFamily,
      })
    : undefined);
  pipelineMachine.updateContext({
    providerResult,
    costEstimate,
    diagnostic,
    output,
  });

  if (routeDecision.route === 'complex') {
    const verifierModelId = config.defaultSimpleModel;
    const verifierTarget = resolveProviderTarget(providerRegistry, verifierModelId);
    const verifierInput = createVerifierStageInput(
      routeDecision,
      providerResult.status,
      plannerResult?.status,
      plannerResult?.steps.length ?? 0,
      taskRequest.constraints.length,
      plannerResult?.downstreamHints.verifierChecks.length ?? 0,
      output.length,
    );

    pipelineMachine.startStage('verifier', verifierInput);

    if (providerResult.status !== 'completed') {
      verifierResult = annotateVerifierSkip(
        trace,
        pipelineMachine,
        routeDecision,
        plannerResult as PlannerResult,
        providerResult,
        output,
        'Verifier skipped because executor did not produce completed output.',
        createVerifierFailureResult(
          'Verifier skipped because executor did not complete successfully.',
          [providerResult.error?.message ?? 'Executor output unavailable for verification.'],
          {
            suggestedAction: 'retry',
          },
        ),
      );
    } else {
      trace.add('verifier.start', 'running', 'Verifier stage started.', {
        metadata: compactMetadata({
          route: routeDecision.route,
          verifierModelId,
          verifierProviderId: verifierTarget.providerId,
          outputChars: output.length,
          constraintCount: taskRequest.constraints.length,
          verifierCheckCount: plannerResult?.downstreamHints.verifierChecks.length ?? 0,
        }),
      });

      try {
        const verifierContext = {
          taskRequest,
          structurizerResult,
          routeDecision,
          plannerResult,
          reasonerResult,
          providerResult,
          output,
        };
        const modelVerifierResult = await dependencies.verifyTaskOutput(providerRegistry, verifierModelId, verifierContext);
        trace.add(
          'verifier.model.finish',
          modelVerifierResult.verdict === 'fail' ? 'failed' : 'completed',
          modelVerifierResult.summary,
          {
            metadata: compactMetadata({
              verifierId: modelVerifierResult.verifierId,
              verifierKind: modelVerifierResult.verifierKind,
              verifierVerdict: modelVerifierResult.verdict,
              suggestedAction: modelVerifierResult.suggestedAction,
              findingCount: modelVerifierResult.findings.length,
            }),
            error: createVerifierStageError(modelVerifierResult),
          },
        );

        const ruleVerifierResults = await dependencies.runRuleVerifiers(verifierContext);
        for (const ruleVerifierResult of ruleVerifierResults) {
          trace.add(
            'verifier.rule.finish',
            ruleVerifierResult.verdict === 'fail' ? 'failed' : 'completed',
            ruleVerifierResult.summary,
            {
              metadata: compactMetadata({
                verifierId: ruleVerifierResult.verifierId,
                verifierKind: ruleVerifierResult.verifierKind,
                verifierVerdict: ruleVerifierResult.verdict,
                suggestedAction: ruleVerifierResult.suggestedAction,
                findingCount: ruleVerifierResult.findings.length,
              }),
              error: createVerifierStageError(ruleVerifierResult),
            },
          );
        }

        verifierResult = applyVerificationPolicyOverrides(
          taskRequest,
          dependencies.mergeVerificationResults([modelVerifierResult, ...ruleVerifierResults]),
        );

        pipelineMachine.updateContext({
          verifierResult,
        });
        pipelineMachine.completeStage('verifier', createVerifierStageOutput('completed', verifierResult.summary, verifierResult), {
          error: createVerifierStageError(verifierResult),
        });
        trace.add(
          'verifier.finish',
          verifierResult.verdict === 'fail' ? 'failed' : 'completed',
          verifierResult.summary,
          {
            metadata: compactMetadata({
              route: routeDecision.route,
              verifierModelId,
              verifierProviderId: verifierTarget.providerId,
              verifierKind: verifierResult.verifierKind,
              verifierVerdict: verifierResult.verdict,
              suggestedAction: verifierResult.suggestedAction,
              findingCount: verifierResult.findings.length,
              subVerifierCount: 1 + ruleVerifierResults.length,
              ruleVerifierCount: ruleVerifierResults.length,
            }),
            error: createVerifierStageError(verifierResult),
          },
        );
      } catch (error) {
        const reason = `Verifier stage crashed: ${toErrorMessage(error)}`;
        verifierResult = applyVerificationPolicyOverrides(taskRequest, createVerifierFailureResult('Verifier stage failed safely.', [reason], {
          verifierId: 'verifier-stage-v1',
          verifierKind: 'composite',
          suggestedAction: 'manual-confirm',
          codePrefix: 'verifier_stage_crash',
        }));
        pipelineMachine.updateContext({
          verifierResult,
        });
        pipelineMachine.completeStage('verifier', createVerifierStageOutput('completed', verifierResult.summary, verifierResult), {
          error: {
            code: 'verifier_crash',
            message: reason,
          },
        });
        trace.add('verifier.finish', 'failed', reason, {
          metadata: compactMetadata({
            route: routeDecision.route,
            verifierModelId,
            verifierProviderId: verifierTarget.providerId,
            verifierVerdict: verifierResult.verdict,
            suggestedAction: verifierResult.suggestedAction,
          }),
          error: {
            code: 'verifier_crash',
            message: reason,
          },
        });
      }
    }
  }

  pipelineMachine.startStage('response', createResponseStageInput(providerResult, costEstimate, diagnostic));

  trace.add('response.cost', 'completed', buildCostDetail(costEstimate), {
    metadata: compactMetadata({
      costStatus: costEstimate.status,
      usageSource: costEstimate.usageSource,
      pricingSource: costEstimate.pricingSource,
      totalTokens: costEstimate.totalTokens,
      totalCostUsd: costEstimate.totalCostUsd,
      latencyMs: costEstimate.latencyMs,
      runtimeId: providerTarget.runtimeId,
      deploymentMode: providerTarget.deploymentMode,
      apiFamily: providerTarget.apiFamily,
    }),
  });

  trace.add('response.output', 'completed', 'Task response prepared for extension.', {
    metadata: compactMetadata({
      outputChars: output.length,
      traceCount: trace.list().length + 2,
      providerStatus: providerResult.status,
      costStatus: costEstimate.status,
    }),
    error: providerResult.error
      ? {
          code: providerResult.error.code,
          message: providerResult.error.message,
        }
      : undefined,
  });
  pipelineMachine.completeStage('response', createResponseStageOutput(output, providerResult, costEstimate, diagnostic));

  trace.add(
    'pipeline.finish',
    providerResult.status === 'completed' ? 'completed' : 'failed',
    providerResult.status === 'completed' ? 'Pipeline completed.' : providerResult.error?.message ?? 'Pipeline failed.',
    {
      metadata: compactMetadata({
        providerStatus: providerResult.status,
        route: routeDecision.route,
      }),
      error: providerResult.error
        ? {
            code: providerResult.error.code,
            message: providerResult.error.message,
          }
        : undefined,
    },
  );

  const pipeline = pipelineMachine.serialize();
  const traceEntries = trace.list();
  const checkpoint = createTaskCheckpoint({
    taskRequest,
    structurizerResult,
    routeDecision,
    plannerResult,
    reasonerResult,
    verifierResult,
    output,
    providerResult,
    costEstimate,
    diagnostic,
    pipeline,
    trace: traceEntries,
    capturedAt: dependencies.createTimestamp(),
  });

  return TaskResponseSchema.parse({
    output,
    runInfo: {
      mode: runMode.mode,
      targetStageId: runMode.mode === 'stage-rerun' ? runMode.rerun.targetStageId : undefined,
      reusedCheckpointStages,
      historyTraceCount: historyTrace.length,
      historyTransitionCount: runMode.mode === 'stage-rerun' ? runMode.rerun.checkpoint.pipeline.transitions.length : 0,
      detail:
        rerunRequest
          ? `Stage rerun resumed from ${rerunRequest.targetStageId}.`
          : 'Full pipeline run.',
    },
    routeDecision,
    plannerResult,
    reasonerResult,
    verifierResult,
    selectedProvider: {
      providerId: providerResult.providerId,
      runtimeId: providerTarget.runtimeId,
      deploymentMode: providerTarget.deploymentMode,
      apiFamily: providerTarget.apiFamily,
      modelId,
        reason: selectedProviderReason,
      confidence: routeDecision.confidence,
    },
    providerResult,
    costEstimate,
    diagnostic,
    pipeline,
    trace: traceEntries,
    checkpoint,
  });
}