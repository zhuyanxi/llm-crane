import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig, TaskRequest } from '@llm-crane/schemas';
import { runTaskPipeline } from '../src/pipelineRunner';

const runtimeConfig: RuntimeConfig = {
  defaultSimpleModel: 'gpt-4o-mini',
  defaultComplexModel: 'claude-3-5-sonnet-latest',
  transport: 'stdio',
  logLevel: 'info',
  providerKeys: {
    openai: 'sk-openai',
    anthropic: 'sk-anthropic',
  },
  runtimeProfiles: [],
};

function createProviderRegistryStub(outputText: string) {
  return {
    invoke: vi.fn().mockResolvedValue({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      latencyMs: 120,
    }),
  };
}

describe('runTaskPipeline', () => {
  it('runs simple path end to end with simple model', async () => {
    const providerRegistry = createProviderRegistryStub('simple result');
    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    expect(response.selectedProvider.modelId).toBe('gpt-4o-mini');
    expect(response.providerResult.status).toBe('completed');
    expect(response.costEstimate.status).toBe('exact');
    expect(response.diagnostic).toBeUndefined();
    expect(response.costEstimate.totalCostUsd).toBeGreaterThan(0);
    expect(response.output).toBe('simple result');
    expect(response.trace.some((event) => event.stage === 'request.received' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'response.cost' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'response.output' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'pipeline.finish' && event.status === 'completed')).toBe(true);
  });

  it('runs complex path end to end with complex model', async () => {
    const providerRegistry = {
      invoke: vi.fn().mockResolvedValue({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
        outputText: 'complex result',
        latencyMs: 220,
      }),
    };

    const taskRequest: TaskRequest = {
      task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
      qualityBar: 'high',
      constraints: ['Keep public API stable', 'Avoid schema churn'],
      contexts: [
        {
          source: 'workspace',
          uri: '/workspace',
          content: 'workspace snapshot',
        },
        {
          source: 'file',
          uri: '/workspace/src/server.ts',
          languageId: 'typescript',
          content: 'export function start() {}',
        },
      ],
    };

    const response = await runTaskPipeline(runtimeConfig, providerRegistry as never, taskRequest);

    expect(response.selectedProvider.modelId).toBe('claude-3-5-sonnet-latest');
    expect(response.routeDecision.route).toBe('complex');
    expect(response.providerResult.status).toBe('completed');
    expect(response.costEstimate.status).toBe('estimated');
    expect(response.diagnostic).toBeUndefined();
    expect(response.costEstimate.totalTokens).toBeGreaterThan(0);
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'completed')).toBe(true);
  });

  it('returns unified failed task response when executor stage crashes', async () => {
    const providerRegistry = createProviderRegistryStub('unused');

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to remove duplication.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
      {
        buildProviderUserPrompt: () => {
          throw new Error('prompt exploded');
        },
      },
    );

    expect(response.providerResult.status).toBe('failed');
    expect(response.costEstimate.status).toBe('unknown');
    expect(response.diagnostic?.category).toBe('internal');
    expect(response.diagnostic?.code).toBe('internal.executor_prompt_crash');
    expect(response.output).toContain('Task execution failed');
    expect(response.trace.some((event) => event.stage === 'executor.prompt' && event.status === 'failed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'skipped')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'pipeline.finish' && event.status === 'failed')).toBe(true);
  });

  it('records retrying trace state for retriable provider failure', async () => {
    const providerRegistry = createProviderRegistryStub('unused');

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
      {
        invokeRoutedProvider: async () => ({
          status: 'failed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: '',
          error: {
            providerId: 'openai',
            code: 'rate_limit',
            message: 'Rate limit exceeded',
            retriable: true,
            statusCode: 429,
          },
        }),
      },
    );

    const retryEvent = response.trace.find((event) => event.stage === 'executor.retry');

    expect(retryEvent?.status).toBe('retrying');
    expect(retryEvent?.error?.code).toBe('rate_limit');
    expect(retryEvent?.metadata.retriable).toBe(true);
    expect(response.diagnostic?.category).toBe('provider');
    expect(response.diagnostic?.code).toBe('provider.rate_limit');
    expect(response.costEstimate.status).toBe('unknown');
  });
});