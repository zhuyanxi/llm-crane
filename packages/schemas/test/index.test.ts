import { describe, expect, it } from 'vitest';
import { OrchestratorEventSchema, OrchestratorRequestSchema, RuntimeConfigSchema, TaskRequestSchema } from '../src/index';

describe('TaskRequestSchema', () => {
  it('parses minimal task request', () => {
    const parsed = TaskRequestSchema.parse({
      task: 'Summarize current file',
    });

    expect(parsed.qualityBar).toBe('balanced');
    expect(parsed.contexts).toEqual([]);
  });

  it('rejects empty task', () => {
    expect(() => TaskRequestSchema.parse({ task: '' })).toThrow();
  });
});

describe('RuntimeConfigSchema', () => {
  it('requires known transport', () => {
    expect(() =>
      RuntimeConfigSchema.parse({
        defaultSimpleModel: 'gpt-4o-mini',
        defaultComplexModel: 'claude-3-5-sonnet-latest',
        transport: 'http',
        logLevel: 'info',
        providerKeys: {},
      }),
    ).toThrow();
  });
});

describe('Orchestrator protocol schemas', () => {
  it('parses runTask request envelope', () => {
    const parsed = OrchestratorRequestSchema.parse({
      id: 'req-1',
      type: 'runTask',
      request: {
        task: 'Review selection',
        contexts: [
          {
            source: 'selection',
            content: 'const value = 1;',
            languageId: 'typescript',
          },
        ],
      },
    });

    expect(parsed.type).toBe('runTask');
  });

  it('parses taskResult event envelope', () => {
    const parsed = OrchestratorEventSchema.parse({
      id: 'req-1',
      type: 'taskResult',
      response: {
        output: 'Task received.',
        routeDecision: {
          status: 'routed',
          route: 'simple',
          reason: 'Narrow selection with low ambiguity.',
          confidence: 0.82,
          complexityScore: 2,
          scoreBreakdown: [
            {
              factor: 'target-scope',
              score: 0,
              detail: 'Selection target keeps task narrow.',
            },
          ],
          strategy: 'rules-v1',
        },
        selectedProvider: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          reason: 'Lifecycle probe.',
        },
        providerResult: {
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: 'Task received.',
          latencyMs: 120,
        },
        costEstimate: {
          status: 'exact',
          currency: 'USD',
          pricingUnit: 'usd-per-1m-tokens',
          modelId: 'gpt-4o-mini',
          usageSource: 'provider',
          pricingSource: 'catalog',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          inputCostUsd: 0.000015,
          outputCostUsd: 0.00003,
          totalCostUsd: 0.000045,
          latencyMs: 120,
          detail: 'Estimated from provider-reported token usage and local price catalog.',
        },
        trace: [
          {
            stage: 'bootstrap',
            status: 'completed',
            timestamp: '2026-05-05T00:00:00.000Z',
            metadata: {
              requestId: 'req-1',
              contextCount: 1,
            },
          },
          {
            stage: 'executor.retry',
            status: 'retrying',
            timestamp: '2026-05-05T00:00:01.000Z',
            detail: 'Provider error marked retriable; automatic retry disabled in V0.',
            metadata: {
              retriable: true,
            },
            error: {
              code: 'rate_limit',
              message: 'Rate limit exceeded',
            },
          },
        ],
      },
    });

    expect(parsed.type).toBe('taskResult');
  });
});