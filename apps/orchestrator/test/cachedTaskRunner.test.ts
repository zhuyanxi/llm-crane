import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig, TaskRequest, TaskResponse } from '@llm-crane/schemas';
import { runTaskWithCache } from '../src/cachedTaskRunner';
import { createTaskCacheKey, createTaskCacheMetadata, type CachedTaskRecord, type TaskCacheStore } from '../src/taskCache';

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
  const pipeline: TaskResponse['pipeline'] = {
    version: 'v1',
    graph: 'simple-v1',
    route: 'simple',
    state: 'completed',
    stages: [
      {
        stageId: 'request',
        label: 'Request Intake',
        state: 'completed',
        dependsOn: [],
        input: {
          stageId: 'request',
          taskChars: baseTaskRequest.task.length,
          contextCount: baseTaskRequest.contexts.length,
          constraintCount: baseTaskRequest.constraints.length,
          qualityBar: baseTaskRequest.qualityBar,
        },
        output: {
          stageId: 'request',
          accepted: true,
        },
        startedAt: '2026-05-05T00:00:00.000Z',
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      {
        stageId: 'structurizer',
        label: 'Structurizer',
        state: 'completed',
        dependsOn: ['request'],
        input: {
          stageId: 'structurizer',
          taskChars: baseTaskRequest.task.length,
          contextCount: baseTaskRequest.contexts.length,
        },
        output: {
          stageId: 'structurizer',
          status: 'structured',
          taskType: 'analysis',
          targetKind: 'file',
          warningCount: 0,
        },
        startedAt: '2026-05-05T00:00:00.000Z',
        completedAt: '2026-05-05T00:00:01.000Z',
      },
      {
        stageId: 'router',
        label: 'Router',
        state: 'completed',
        dependsOn: ['structurizer'],
        input: {
          stageId: 'router',
          structurizerStatus: 'structured',
          taskType: 'analysis',
          openQuestions: 0,
          warningCount: 0,
        },
        output: {
          stageId: 'router',
          status: 'routed',
          route: 'simple',
          complexityScore: 2,
          confidence: 0.8,
        },
        startedAt: '2026-05-05T00:00:01.000Z',
        completedAt: '2026-05-05T00:00:01.000Z',
      },
      {
        stageId: 'executor',
        label: 'Executor',
        state: 'completed',
        dependsOn: ['router'],
        input: {
          stageId: 'executor',
          route: 'simple',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
        },
        output: {
          stageId: 'executor',
          status: 'completed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          latencyMs: 120,
        },
        startedAt: '2026-05-05T00:00:01.000Z',
        completedAt: '2026-05-05T00:00:02.000Z',
      },
      {
        stageId: 'response',
        label: 'Response Assembly',
        state: 'completed',
        dependsOn: ['executor'],
        input: {
          stageId: 'response',
          providerStatus: 'completed',
          costStatus: 'exact',
          diagnosticPresent: false,
        },
        output: {
          stageId: 'response',
          outputChars: output.length,
          providerStatus: 'completed',
          costStatus: 'exact',
        },
        startedAt: '2026-05-05T00:00:02.000Z',
        completedAt: '2026-05-05T00:00:03.000Z',
      },
    ],
    transitions: [
      {
        stageId: 'request',
        fromState: 'pending',
        toState: 'running',
        timestamp: '2026-05-05T00:00:00.000Z',
      },
      {
        stageId: 'request',
        fromState: 'running',
        toState: 'completed',
        timestamp: '2026-05-05T00:00:00.000Z',
      },
    ],
  };

  const trace: TaskResponse['trace'] = [
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
  ];

  return {
    output,
    runInfo: {
      mode: 'full',
      reusedCheckpointStages: [],
      historyTraceCount: 0,
      historyTransitionCount: 0,
      detail: 'Full pipeline run.',
    },
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
    pipeline,
    trace,
    checkpoint: {
      taskRequest: baseTaskRequest,
      routeDecision: {
        status: 'routed',
        route: 'simple',
        reason: 'Narrow file task.',
        confidence: 0.8,
        complexityScore: 2,
        scoreBreakdown: [],
        strategy: 'rules-v1',
      },
      pipeline,
      trace,
      capturedAt: '2026-05-05T00:00:03.000Z',
    },
  };
}

function createTaskCacheStore(): TaskCacheStore & {
  records: Map<string, CachedTaskRecord>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  const records = new Map<string, CachedTaskRecord>();

  return {
    records,
    get: vi.fn((key: string) => records.get(key)),
    set: vi.fn((key: string, response, storedAt: string, metadata) => {
      records.set(key, {
        key,
        storedAt,
        response,
        metadata,
      });
    }),
    delete: vi.fn((key: string) => {
      records.delete(key);
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
      metadata: createTaskCacheMetadata(runtimeConfig),
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
    expect(response.pipeline.graph).toBe('simple-v1');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'executor')?.state).toBe('skipped');
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
    expect(response.pipeline.state).toBe('completed');
    expect(response.trace.some((event) => event.stage === 'cache.lookup' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'cache.write' && event.status === 'completed')).toBe(true);
    expect(taskCache.set).toHaveBeenCalledTimes(1);
  });

  it('invalidates stale cache entries when ttl expired', async () => {
    const taskCache = createTaskCacheStore();
    const cacheKey = createTaskCacheKey(
      {
        ...runtimeConfig,
        cachePolicy: {
          ttlMs: 1_000,
        },
      },
      baseTaskRequest,
    );
    const cachedResponse = createTaskResponse('stale output');
    taskCache.records.set(cacheKey, {
      key: cacheKey,
      storedAt: '2026-05-05T00:00:00.000Z',
      metadata: createTaskCacheMetadata({
        ...runtimeConfig,
        cachePolicy: {
          ttlMs: 1_000,
        },
      }),
      response: {
        output: cachedResponse.output,
        routeDecision: cachedResponse.routeDecision,
        selectedProvider: cachedResponse.selectedProvider,
        providerResult: cachedResponse.providerResult,
        costEstimate: cachedResponse.costEstimate,
      },
    });

    const pipelineSpy = vi.fn().mockResolvedValue(createTaskResponse('fresh after ttl'));

    const response = await runTaskWithCache(
      {
        ...runtimeConfig,
        cachePolicy: {
          ttlMs: 1_000,
        },
      },
      {} as never,
      baseTaskRequest,
      taskCache,
      {
        createTimestamp: () => '2026-05-05T00:00:02.000Z',
        runTaskPipeline: pipelineSpy as never,
      },
    );

    expect(response.output).toBe('fresh after ttl');
    expect(response.cacheInfo?.status).toBe('miss');
    expect(response.cacheInfo?.detail).toContain('ttl expired');
    expect(response.trace.some((event) => event.stage === 'cache.invalidate' && event.status === 'completed')).toBe(true);
    expect(taskCache.delete).toHaveBeenCalledWith(cacheKey);
    expect(taskCache.set).toHaveBeenCalledTimes(1);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates cache entries when prompt assets changed', async () => {
    const taskCache = createTaskCacheStore();
    const cacheKey = createTaskCacheKey(runtimeConfig, baseTaskRequest);
    const cachedResponse = createTaskResponse('stale prompt output');

    taskCache.records.set(cacheKey, {
      key: cacheKey,
      storedAt: '2026-05-05T00:00:10.000Z',
      metadata: {
        ...createTaskCacheMetadata(runtimeConfig),
        promptVersion: 'stale-prompt-version',
      },
      response: {
        output: cachedResponse.output,
        routeDecision: cachedResponse.routeDecision,
        selectedProvider: cachedResponse.selectedProvider,
        providerResult: cachedResponse.providerResult,
        costEstimate: cachedResponse.costEstimate,
      },
    });

    const pipelineSpy = vi.fn().mockResolvedValue(createTaskResponse('fresh prompt output'));

    const response = await runTaskWithCache(runtimeConfig, {} as never, baseTaskRequest, taskCache, {
      createTimestamp: () => '2026-05-05T00:00:30.000Z',
      runTaskPipeline: pipelineSpy as never,
    });

    expect(response.output).toBe('fresh prompt output');
    expect(response.cacheInfo?.detail).toContain('prompt assets changed');
    expect(
      response.trace.some(
        (event) => event.stage === 'cache.invalidate' && event.metadata?.invalidationReason === 'prompt-version',
      ),
    ).toBe(true);
    expect(taskCache.delete).toHaveBeenCalledWith(cacheKey);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
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