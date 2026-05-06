import { describe, expect, it } from 'vitest';
import { OrchestratorEventSchema, OrchestratorRequestSchema, RuntimeConfigSchema, TaskRequestSchema } from '../src/index';

describe('TaskRequestSchema', () => {
  it('parses minimal task request', () => {
    const parsed = TaskRequestSchema.parse({
      task: 'Summarize current file',
    });

    expect(parsed.qualityBar).toBe('balanced');
    expect(parsed.cacheMode).toBe('default');
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

  it('parses local runtime profile descriptors', () => {
    const parsed = RuntimeConfigSchema.parse({
      defaultSimpleModel: 'local-qwen2.5-coder',
      defaultComplexModel: 'claude-3-5-sonnet-latest',
      transport: 'stdio',
      logLevel: 'info',
      providerKeys: {
        anthropic: 'sk-anthropic',
      },
      runtimeProfiles: [
        {
          runtimeId: 'lmstudio-local',
          providerId: 'openai',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234/v1',
          models: ['local-qwen2.5-coder'],
          authMode: 'header',
          authToken: 'lmstudio-secret',
          authHeaderName: 'X-LM-Studio-Key',
          headers: {
            'X-Client': 'llm-crane',
          },
          timeoutMs: 45000,
        },
        {
          runtimeId: 'ollama-local',
          providerId: 'ollama',
          deploymentMode: 'local',
          apiFamily: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['qwen2.5-coder:7b'],
          authMode: 'none',
          timeoutMs: 30000,
        },
      ],
    });

    expect(parsed.runtimeProfiles[0]?.runtimeId).toBe('lmstudio-local');
    expect(parsed.runtimeProfiles[0]?.deploymentMode).toBe('local');
    expect(parsed.runtimeProfiles[0]?.apiFamily).toBe('openai-compatible');
    expect(parsed.runtimeProfiles[0]?.authMode).toBe('header');
    expect(parsed.runtimeProfiles[0]?.authHeaderName).toBe('X-LM-Studio-Key');
    expect(parsed.runtimeProfiles[0]?.headers).toEqual({ 'X-Client': 'llm-crane' });
    expect(parsed.runtimeProfiles[1]?.providerId).toBe('ollama');
    expect(parsed.runtimeProfiles[1]?.apiFamily).toBe('ollama');
  });
});

describe('Orchestrator protocol schemas', () => {
  it('parses runTask request envelope', () => {
    const parsed = OrchestratorRequestSchema.parse({
      id: 'req-1',
      type: 'runTask',
      request: {
        task: 'Review selection',
        cacheMode: 'bypass',
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
    if (parsed.type !== 'runTask') {
      throw new Error('Expected runTask envelope');
    }

    expect(parsed.request.cacheMode).toBe('bypass');
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
        cacheInfo: {
          status: 'hit',
          key: 'cache-key',
          storage: 'sqlite',
          createdAt: '2026-05-05T00:00:00.000Z',
          detail: 'Cache hit; reused prior task response from SQLite store.',
        },
        diagnostic: {
          category: 'provider',
          code: 'provider.rate_limit',
          summary: 'Provider rate limit hit',
          message: 'Rate limit exceeded',
          retriable: true,
          providerId: 'openai',
          stage: 'executor.invoke',
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

  it('parses error event envelope with diagnostic payload', () => {
    const parsed = OrchestratorEventSchema.parse({
      type: 'error',
      id: 'req-2',
      message: 'Payload failed schema validation at request.task: Too small: expected string to have >=1 characters',
      diagnostic: {
        category: 'schema',
        code: 'schema.invalid_payload',
        summary: 'Schema validation failed',
        message: 'Payload failed schema validation at request.task: Too small: expected string to have >=1 characters',
        stage: 'orchestrator.protocol',
      },
    });

    expect(parsed.type).toBe('error');
  });
});