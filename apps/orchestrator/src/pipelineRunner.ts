import { estimateModelCost, getProviderIdForModel, type ProviderRegistry } from '@llm-crane/providers';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  CostEstimateSchema,
  TaskResponseSchema,
  type PipelineTraceEvent,
  type PipelineTraceError,
  type PipelineTraceMetadataValue,
  type ProviderExecutionResult,
  type RouteDecision,
  type RuntimeConfig,
  type StructurizerResult,
  type TaskRequest,
  type TaskResponse,
} from '@llm-crane/schemas';
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

  trace.add('pipeline.start', 'running', 'Task pipeline started.', {
    metadata: compactMetadata({
      taskChars: taskRequest.task.length,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
    }),
  });
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

  let routeDecision: RouteDecision;
  try {
    const routerScoreInput = dependencies.buildRouterScoreInput(structurizerResult);
    trace.add('router.score-input', 'completed', `chars=${routerScoreInput.length}`, {
      metadata: compactMetadata({
        inputChars: routerScoreInput.length,
      }),
    });
    routeDecision = dependencies.routeTask(structurizerResult);
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
    trace.add('router.finish', 'failed', reason, {
      error: {
        code: 'router_crash',
        message: reason,
      },
    });
  }

  const modelId = getModelIdForRoute(config, routeDecision);
  const providerId = getProviderIdForModel(modelId) ?? 'openai';
  trace.add('executor.start', 'running', 'Executor stage started.', {
    metadata: compactMetadata({
      providerId,
      modelId,
      route: routeDecision.route,
    }),
  });

  let providerResult: ProviderExecutionResult;
  let providerPrompt: string | undefined;

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
    providerResult = createFailedProviderExecutionResult(modelId, new Error(reason));
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
      }),
    });
  }

  const costEstimate = CostEstimateSchema.parse(
    estimateModelCost({
      modelId,
      usage: providerResult.usage,
      promptText: providerPrompt,
      outputText: providerResult.outputText,
      latencyMs: providerResult.latencyMs,
      executionStatus: providerResult.status,
    }),
  );

  trace.add('response.cost', 'completed', buildCostDetail(costEstimate), {
    metadata: compactMetadata({
      costStatus: costEstimate.status,
      usageSource: costEstimate.usageSource,
      totalTokens: costEstimate.totalTokens,
      totalCostUsd: costEstimate.totalCostUsd,
      latencyMs: costEstimate.latencyMs,
    }),
  });

  trace.add('response.output', 'completed', 'Task response prepared for extension.', {
    metadata: compactMetadata({
      outputChars: buildTaskOutput(providerResult).length,
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
    output: buildTaskOutput(providerResult),
    routeDecision,
    selectedProvider: {
      providerId,
      modelId,
      reason: routeDecision.reason,
      confidence: routeDecision.confidence,
    },
    providerResult,
    costEstimate,
    trace: trace.list(),
  });
}