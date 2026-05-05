import { getProviderIdForModel, ProviderInvocationError, type ProviderInvocationRequest } from '@llm-crane/providers';
import {
  ProviderExecutionResultSchema,
  type ProviderError,
  type ProviderExecutionResult,
  type RouteDecision,
  type StructurizerResult,
  type TaskContext,
  type TaskRequest,
} from '@llm-crane/schemas';

type ProviderInvoker = {
  invoke(request: ProviderInvocationRequest): Promise<{
    providerId: string;
    modelId: string;
    outputText: string;
    stopReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    latencyMs: number;
  }>;
};

const SIMPLE_MAX_OUTPUT_TOKENS = 1200;
const COMPLEX_MAX_OUTPUT_TOKENS = 2400;

export const EXECUTOR_SYSTEM_PROMPT = [
  'You are LLM Crane executor.',
  'Complete user task using structured task object, route decision, and attached contexts.',
  'Respect explicit constraints.',
  'If information is missing, say what is missing instead of inventing facts.',
  'Return plain text only.',
].join(' ');

function formatContext(context: TaskContext, index: number): string {
  const headerParts = [`Context ${index + 1}`, `source=${context.source}`];
  if (context.languageId) {
    headerParts.push(`language=${context.languageId}`);
  }
  if (context.uri) {
    headerParts.push(`uri=${context.uri}`);
  }

  return [headerParts.join(' | '), context.content].join('\n');
}

export function buildProviderUserPrompt(
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): string {
  return [
    `Original task:\n${taskRequest.task}`,
    `Structured task:\n${JSON.stringify(structurizerResult.structuredTask, null, 2)}`,
    `Route decision:\n${JSON.stringify(routeDecision, null, 2)}`,
    `Contexts:\n${taskRequest.contexts.length > 0 ? taskRequest.contexts.map(formatContext).join('\n\n---\n\n') : 'No editor context attached.'}`,
  ].join('\n\n');
}

function toProviderError(modelId: string, error: unknown): ProviderError {
  const providerId = getProviderIdForModel(modelId) ?? 'openai';

  if (error instanceof ProviderInvocationError) {
    return {
      providerId: error.providerId,
      code: error.code,
      message: error.message,
      retriable: error.retriable,
      statusCode: error.statusCode,
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown provider failure.';
  return {
    providerId,
    code: 'unknown',
    message,
    retriable: false,
  };
}

function getMaxOutputTokens(routeDecision: RouteDecision): number {
  return routeDecision.route === 'simple' ? SIMPLE_MAX_OUTPUT_TOKENS : COMPLEX_MAX_OUTPUT_TOKENS;
}

export async function invokeRoutedProvider(
  providerInvoker: ProviderInvoker,
  modelId: string,
  taskRequest: TaskRequest,
  structurizerResult: StructurizerResult,
  routeDecision: RouteDecision,
): Promise<ProviderExecutionResult> {
  try {
    const result = await providerInvoker.invoke({
      modelId,
      prompt: buildProviderUserPrompt(taskRequest, structurizerResult, routeDecision),
      systemPrompt: EXECUTOR_SYSTEM_PROMPT,
      temperature: routeDecision.route === 'simple' ? 0.1 : 0.2,
      maxOutputTokens: getMaxOutputTokens(routeDecision),
      timeoutMs: routeDecision.route === 'simple' ? 20_000 : 35_000,
      metadata: {
        route: routeDecision.route,
        taskType: structurizerResult.structuredTask.taskType,
      },
    });

    return ProviderExecutionResultSchema.parse({
      status: 'completed',
      providerId: result.providerId,
      modelId: result.modelId,
      outputText: result.outputText,
      stopReason: result.stopReason,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    const providerError = toProviderError(modelId, error);
    return ProviderExecutionResultSchema.parse({
      status: 'failed',
      providerId: providerError.providerId,
      modelId,
      outputText: '',
      error: providerError,
    });
  }
}