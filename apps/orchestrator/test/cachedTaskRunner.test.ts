import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig, TaskRequest, TaskResponse } from '@llm-crane/schemas';
import { runTaskWithCache } from '../src/cachedTaskRunner';
import { createTaskCacheKey, type CachedTaskRecord, type TaskCacheStore } from '../src/taskCache';

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

const baseTaskRequest: TaskRequest = {
  task: 'Review current file for cache behavior.',
  qualityBar: 'balanced',
  cacheMode: 'default',
  constraints: [],
  contexts: [
    {
      source: 'file',
      uri: '/workspace/src/app.ts',
      languageId: 'typescript',
      content: 'export const value = 1;',
    },
  ],
};

function createTaskResponse(output: string): TaskResponse {
  return {
    output,
    routeDecision: {
      status: 'routed',
      route: 'simple',
      reason: 'Narrow file task.',
      confidence: 0.8,
      complexityScore: 2,
      scoreBreakdown: [],
      strategy: 'rules-v1',
    },
    selectedProvider: {
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      reason: 'Fast path.',
      confidence: 0.8,
    },
    providerResult: {
      status: 'completed',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText: output,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
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
        stage: 'pipeline.start',
        status: 'running',
        timestamp: '2026-05-05T00:00:00.000Z',
        detail: 'Task pipeline started.',
        metadata: {
          taskChars: baseTaskRequest.task.length,
          contextCount: baseTaskRequest.contexts.length,
          constraintCount: baseTaskRequest.constraints.length,
        },
      },
      {
        stage: 'request.received',
        status: 'completed',
        timestamp: '2026-05-05T00:00:01.000Z',
        detail: 'Task request accepted by orchestrator.',
        metadata: {
          qualityBar: baseTaskRequest.qualityBar,
          contextCount: baseTaskRequest.contexts.length,
          constraintCount: baseTaskRequest.constraints.length,
        },
      },
      {
        stage: 'response.output',
        status: 'completed',
        timestamp: '2026-05-05T00:00:02.000Z',
        detail: 'Task response prepared for extension.',
        metadata: {
          outputChars: output.length,
          traceCount: 4,
          providerStatus: 'completed',
          costStatus: 'exact',
        },
      },
      {
        stage: 'pipeline.finish',
        status: 'completed',
        timestamp: '2026-05-05T00:00:03.000Z',
        detail: 'Pipeline completed.',
        metadata: {
          providerStatus: 'completed',
          route: 'simple',
        },
      },
    ],
  };
}

function createTaskCacheStore(): TaskCacheStore & {
  records: Map<string, CachedTaskRecord>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const records = new Map<string, CachedTaskRecord>();

  return {
    records,
    get: vi.fn((key: string) => records.get(key)),
    set: vi.fn((key: string, response, storedAt: string) => {
      records.set(key, {
        key,
        storedAt,
        response,
      });
    }),
    close: vi.fn(),
  };
}

describe('runTaskWithCache', () => {
  it('returns cached response on cache hit without invoking pipeline', async () => {
    const taskCache = createTaskCacheStore();
    const cacheKey = createTaskCacheKey(runtimeConfig, baseTaskRequest);
    const cachedResponse = createTaskResponse('cached output');

    taskCache.records.set(cacheKey, {
      key: cacheKey,
      storedAt: '2026-05-05T00:00:10.000Z',
      response: {
        output: cachedResponse.output,
        routeDecision: cachedResponse.routeDecision,
        selectedProvider: cachedResponse.selectedProvider,
        providerResult: cachedResponse.providerResult,
        costEstimate: cachedResponse.costEstimate,
      },
    });

    const pipelineSpy = vi.fn();
    const response = await runTaskWithCache(runtimeConfig, {} as never, baseTaskRequest, taskCache, {
      createTimestamp: () => '2026-05-05T00:01:00.000Z',
      runTaskPipeline: pipelineSpy as never,
    });

    expect(response.output).toBe('cached output');
    expect(response.cacheInfo?.status).toBe('hit');
    expect(response.trace.some((event) => event.stage === 'cache.hit' && event.status === 'completed')).toBe(true);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('stores completed live response after cache miss', async () => {
    const taskCache = createTaskCacheStore();
    const liveResponse = createTaskResponse('live output');
    const pipelineSpy = vi.fn().mockResolvedValue(liveResponse);

    const response = await runTaskWithCache(runtimeConfig, {} as never, baseTaskRequest, taskCache, {
      createTimestamp: () => '2026-05-05T00:02:00.000Z',
      runTaskPipeline: pipelineSpy as never,
    });

    expect(response.output).toBe('live output');
    expect(response.cacheInfo?.status).toBe('miss');
    expect(response.cacheInfo?.createdAt).toBe('2026-05-05T00:02:00.000Z');
    expect(response.trace.some((event) => event.stage === 'cache.lookup' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'cache.write' && event.status === 'completed')).toBe(true);
    expect(taskCache.set).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache lookup when request asks for fresh run', async () => {
    const taskCache = createTaskCacheStore();
    const pipelineSpy = vi.fn().mockResolvedValue(createTaskResponse('fresh output'));

    const response = await runTaskWithCache(
      runtimeConfig,
      {} as never,
      {
        ...baseTaskRequest,
        cacheMode: 'bypass',
      },
      taskCache,
      {
        createTimestamp: () => '2026-05-05T00:03:00.000Z',
        runTaskPipeline: pipelineSpy as never,
      },
    );

    expect(response.output).toBe('fresh output');
    expect(response.cacheInfo?.status).toBe('bypassed');
    expect(response.trace.some((event) => event.stage === 'cache.lookup' && event.status === 'skipped')).toBe(true);
    expect(taskCache.get).not.toHaveBeenCalled();
    expect(taskCache.set).toHaveBeenCalledTimes(1);
  });

  it('skips cache write when live provider response failed', async () => {
    const taskCache = createTaskCacheStore();
    const failedResponse = createTaskResponse('Task execution failed');
    failedResponse.providerResult = {
      status: 'failed',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText: '',
      error: {
        providerId: 'openai',
        code: 'upstream',
        message: 'Provider failed',
        retriable: false,
      },
    };
    const pipelineSpy = vi.fn().mockResolvedValue(failedResponse);

    const response = await runTaskWithCache(runtimeConfig, {} as never, baseTaskRequest, taskCache, {
      createTimestamp: () => '2026-05-05T00:04:00.000Z',
      runTaskPipeline: pipelineSpy as never,
    });

    expect(response.cacheInfo?.status).toBe('miss');
    expect(response.cacheInfo?.createdAt).toBeUndefined();
    expect(response.trace.some((event) => event.stage === 'cache.write' && event.status === 'skipped')).toBe(true);
    expect(taskCache.set).not.toHaveBeenCalled();
  });
});