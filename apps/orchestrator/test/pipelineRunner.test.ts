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
};

function createProviderRegistryStub(outputText: string) {
  return {
    invoke: vi.fn().mockResolvedValue({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText,
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
    expect(response.output).toBe('simple result');
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
    expect(response.output).toContain('Task execution failed');
    expect(response.trace.some((event) => event.stage === 'executor.prompt' && event.status === 'failed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'skipped')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'pipeline.finish' && event.status === 'failed')).toBe(true);
  });
});