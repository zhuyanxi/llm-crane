import { getProviderIdForModel, type ProviderRegistry } from '@llm-crane/providers';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  TaskResponseSchema,
  type PipelineTraceEvent,
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

function createTraceCollector(createTimestamp: () => string) {
  const trace: PipelineTraceEvent[] = [];

  return {
    add(stage: string, status: TraceStatus, detail: string): void {
      trace.push({
        stage,
        status,
        timestamp: createTimestamp(),
        detail,
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

  trace.add('pipeline.start', 'running', 'Task pipeline started.');
  trace.add('structurizer.start', 'running', `taskChars=${taskRequest.task.length}`);

  let structurizerResult: StructurizerResult;
  try {
    const structurizerPrompt = dependencies.buildStructurizerPrompt(taskRequest);
    trace.add(
      'structurizer.prompt',
      'completed',
      `promptChars=${structurizerPrompt.length}; systemPromptChars=${STRUCTURIZER_SYSTEM_PROMPT.length}`,
    );
    structurizerResult = dependencies.structurizeTaskRequest(taskRequest);
    trace.add(
      'structurizer.finish',
      structurizerResult.status === 'structured' ? 'completed' : 'failed',
      `status=${structurizerResult.status}; taskType=${structurizerResult.structuredTask.taskType}; openQuestions=${structurizerResult.structuredTask.openQuestions.length}`,
    );
  } catch (error) {
    const reason = `Structurizer stage crashed: ${toErrorMessage(error)}`;
    structurizerResult = createFallbackStructurizerResult(taskRequest, reason);
    trace.add('structurizer.finish', 'failed', reason);
  }

  trace.add('router.start', 'running', `structurizerStatus=${structurizerResult.status}`);

  let routeDecision: RouteDecision;
  try {
    const routerScoreInput = dependencies.buildRouterScoreInput(structurizerResult);
    trace.add('router.score-input', 'completed', `chars=${routerScoreInput.length}`);
    routeDecision = dependencies.routeTask(structurizerResult);
    trace.add(
      'router.finish',
      routeDecision.status === 'routed' ? 'completed' : 'failed',
      `route=${routeDecision.route}; score=${routeDecision.complexityScore}; confidence=${routeDecision.confidence}`,
    );
  } catch (error) {
    const reason = `Router stage crashed: ${toErrorMessage(error)}`;
    routeDecision = createSafeFallbackRouteDecision(reason);
    trace.add('router.finish', 'failed', reason);
  }

  const modelId = getModelIdForRoute(config, routeDecision);
  const providerId = getProviderIdForModel(modelId) ?? 'openai';
  trace.add('executor.start', 'running', `provider=${providerId}; model=${modelId}`);

  let providerResult: ProviderExecutionResult;

  try {
    const providerPrompt = dependencies.buildProviderUserPrompt(taskRequest, structurizerResult, routeDecision);
    trace.add(
      'executor.prompt',
      'completed',
      `systemChars=${EXECUTOR_SYSTEM_PROMPT.length}; userChars=${providerPrompt.length}`,
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
    );
  } catch (error) {
    const reason = `Executor stage crashed: ${toErrorMessage(error)}`;
    providerResult = createFailedProviderExecutionResult(modelId, new Error(reason));
    trace.add('executor.prompt', 'failed', reason);
    trace.add('executor.invoke', 'skipped', 'Executor invoke skipped after prompt failure.');
  }

  trace.add(
    'pipeline.finish',
    providerResult.status === 'completed' ? 'completed' : 'failed',
    providerResult.status === 'completed' ? 'Pipeline completed.' : providerResult.error?.message ?? 'Pipeline failed.',
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
    trace: trace.list(),
  });
}