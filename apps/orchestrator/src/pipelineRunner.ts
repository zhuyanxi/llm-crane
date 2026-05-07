import { createDiagnosticFromError, createProviderDiagnostic } from '@llm-crane/core';
import { estimateModelCost, getProviderIdForModel, type ProviderRegistry } from '@llm-crane/providers';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  CostEstimateSchema,
  TaskResponseSchema,
  type PipelineTraceEvent,
  type PipelineTraceError,
  type PipelineTraceMetadataValue,
  type Diagnostic,
  type ProviderApiFamily,
  type ProviderDeploymentMode,
  type ProviderExecutionResult,
  type ProviderId,
  type RouteDecision,
  type RuntimeConfig,
  type StructurizerResult,
  type TaskRequest,
  type TaskResponse,
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
  EXECUTOR_SYSTEM_PROMPT,
  buildProviderUserPrompt,
  createFailedProviderExecutionResult,
  invokeRoutedProvider,
} from './providerExecution';
import { buildRouterScoreInput, createSafeFallbackRouteDecision, routeTask } from './router';
import { buildStructurizerPrompt, createFallbackStructurizerResult, structurizeTaskRequest } from './structurizer';

type PipelineRunnerDependencies = {
  createTimestamp?: () => string;
  buildStructurizerPrompt?: typeof buildStructurizerPrompt;
  structurizeTaskRequest?: typeof structurizeTaskRequest;
  buildRouterScoreInput?: typeof buildRouterScoreInput;
  routeTask?: typeof routeTask;
  buildProviderUserPrompt?: typeof buildProviderUserPrompt;
  invokeRoutedProvider?: typeof invokeRoutedProvider;
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

type TraceAddOptions = {
  metadata?: TraceMetadata;
  error?: PipelineTraceError;
};

const defaultDependencies: Required<PipelineRunnerDependencies> = {
  createTimestamp: () => new Date().toISOString(),
  buildStructurizerPrompt,
  structurizeTaskRequest,
  buildRouterScoreInput,
  routeTask,
  buildProviderUserPrompt,
  invokeRoutedProvider,
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

function createTraceCollector(createTimestamp: () => string) {
  const trace: PipelineTraceEvent[] = [];

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

function annotateComplexGraphSkips(
  trace: ReturnType<typeof createTraceCollector>,
  pipelineMachine: ReturnType<typeof createPipelineStateMachine>,
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): void {
  if (routeDecision.route !== 'complex') {
    return;
  }

  const plannerDetail = 'Planner stage reserved for V1-S02; complex graph records skipped stage and continues to executor.';
  pipelineMachine.skipStage('planner', plannerDetail, createPlannerStageOutput('skipped', plannerDetail), {
    input: createPlannerStageInput(routeDecision, structurizerResult),
  });
  trace.add('planner.finish', 'skipped', plannerDetail, {
    metadata: compactMetadata({
      route: routeDecision.route,
      taskType: structurizerResult.structuredTask.taskType,
    }),
  });

  const reasonerDetail = 'Reasoner stage reserved for V1-S03; state machine records early exit for V1-S01.';
  pipelineMachine.skipStage('reasoner', reasonerDetail, createReasonerStageOutput('skipped', reasonerDetail, false), {
    input: createReasonerStageInput(taskRequest, routeDecision, false),
  });
  trace.add('reasoner.finish', 'skipped', reasonerDetail, {
    metadata: compactMetadata({
      route: routeDecision.route,
      plannerAvailable: false,
    }),
  });

  const verifierDetail = 'Verifier stage not enabled in V1-S01; state machine keeps graph terminal and serializable.';
  pipelineMachine.skipStage('verifier', verifierDetail, createVerifierStageOutput('skipped', verifierDetail), {
    input: createVerifierStageInput(routeDecision, true),
  });
  trace.add('verifier.finish', 'skipped', verifierDetail, {
    metadata: compactMetadata({
      route: routeDecision.route,
      providerReady: true,
    }),
  });
}

export async function runTaskPipeline(
  config: RuntimeConfig,
  providerRegistry: ProviderRegistry,
  taskRequest: TaskRequest,
  overrides: PipelineRunnerDependencies = {},
): Promise<TaskResponse> {
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  const trace = createTraceCollector(dependencies.createTimestamp);
  const pipelineMachine = createPipelineStateMachine(taskRequest, dependencies.createTimestamp);

  trace.add('pipeline.start', 'running', 'Task pipeline started.', {
    metadata: compactMetadata({
      taskChars: taskRequest.task.length,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
    }),
  });
  pipelineMachine.startStage('request', createRequestStageInput(taskRequest));
  pipelineMachine.completeStage('request', createRequestStageOutput());
  trace.add('request.received', 'completed', 'Task request accepted by orchestrator.', {
    metadata: compactMetadata({
      qualityBar: taskRequest.qualityBar,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
    }),
  });
  trace.add('structurizer.start', 'running', 'Structurizer stage started.', {
    metadata: compactMetadata({
      taskChars: taskRequest.task.length,
      contextCount: taskRequest.contexts.length,
    }),
  });
  pipelineMachine.startStage('structurizer', createStructurizerStageInput(taskRequest));

  let structurizerResult: StructurizerResult;
  try {
    const structurizerPrompt = dependencies.buildStructurizerPrompt(taskRequest);
    trace.add(
      'structurizer.prompt',
      'completed',
      `promptChars=${structurizerPrompt.length}; systemPromptChars=${STRUCTURIZER_SYSTEM_PROMPT.length}`,
      {
        metadata: compactMetadata({
          promptChars: structurizerPrompt.length,
          systemPromptChars: STRUCTURIZER_SYSTEM_PROMPT.length,
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

  trace.add('router.start', 'running', 'Router stage started.', {
    metadata: compactMetadata({
      structurizerStatus: structurizerResult.status,
      warningCount: structurizerResult.warnings.length,
    }),
  });
  pipelineMachine.startStage('router', createRouterStageInput(structurizerResult));

  let routeDecision: RouteDecision;
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

  annotateComplexGraphSkips(trace, pipelineMachine, taskRequest, structurizerResult, routeDecision);

  const modelId = getModelIdForRoute(config, routeDecision);
  const providerTarget = resolveProviderTarget(providerRegistry, modelId);
  const providerId = providerTarget.providerId;
  pipelineMachine.updateContext({
    providerTarget,
  });
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

  try {
    providerPrompt = dependencies.buildProviderUserPrompt(taskRequest, structurizerResult, routeDecision);
    trace.add(
      'executor.prompt',
      'completed',
      `systemChars=${EXECUTOR_SYSTEM_PROMPT.length}; userChars=${providerPrompt.length}`,
      {
        metadata: compactMetadata({
          systemChars: EXECUTOR_SYSTEM_PROMPT.length,
          userChars: providerPrompt.length,
        }),
      },
    );

    providerResult = await dependencies.invokeRoutedProvider(
      providerRegistry,
      modelId,
      taskRequest,
      structurizerResult,
      routeDecision,
    );
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

    if (providerResult.status === 'failed' && providerResult.error?.retriable) {
      trace.add('executor.retry', 'retrying', 'Provider error marked retriable; automatic retry disabled in V0.', {
        metadata: compactMetadata({
          providerId: providerResult.providerId,
          modelId: providerResult.modelId,
          runtimeId: providerTarget.runtimeId,
          deploymentMode: providerTarget.deploymentMode,
          apiFamily: providerTarget.apiFamily,
          retriable: true,
          retryScheduled: false,
        }),
        error: {
          code: providerResult.error.code,
          message: providerResult.error.message,
        },
      });
    }
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

  const output = buildTaskOutput(providerResult);
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

  return TaskResponseSchema.parse({
    output,
    routeDecision,
    selectedProvider: {
      providerId: providerResult.providerId,
      runtimeId: providerTarget.runtimeId,
      deploymentMode: providerTarget.deploymentMode,
      apiFamily: providerTarget.apiFamily,
      modelId,
      reason: routeDecision.reason,
      confidence: routeDecision.confidence,
    },
    providerResult,
    costEstimate,
    diagnostic,
    pipeline: pipelineMachine.serialize(),
    trace: trace.list(),
  });
}