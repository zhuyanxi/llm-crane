import type { ProviderRegistry } from '@llm-crane/providers';
import {
  CacheInfoSchema,
  TaskResponseSchema,
  type PipelineTraceEvent,
  type PipelineTraceMetadataValue,
  type RuntimeConfig,
  type TaskRequest,
  type TaskResponse,
} from '@llm-crane/schemas';
import { buildCachedPipelineState } from './pipelineStateMachine';
import { runTaskPipeline } from './pipelineRunner';
import { createTaskCheckpoint } from './taskCheckpoint';
import { createTaskCacheKey, toPersistedTaskResponse, type CachedTaskRecord, type TaskCacheStore } from './taskCache';

type TraceMetadata = Record<string, PipelineTraceMetadataValue>;

type CachedTaskRunnerDependencies = {
  createTimestamp?: () => string;
  runTaskPipeline?: typeof runTaskPipeline;
};

const defaultDependencies: Required<CachedTaskRunnerDependencies> = {
  createTimestamp: () => new Date().toISOString(),
  runTaskPipeline,
};

function createTraceEvent(
  createTimestamp: () => string,
  stage: string,
  status: PipelineTraceEvent['status'],
  detail: string,
  metadata: TraceMetadata = {},
): PipelineTraceEvent {
  return {
    stage,
    status,
    timestamp: createTimestamp(),
    detail,
    metadata,
  };
}

function createRequestMetadata(taskRequest: TaskRequest): TraceMetadata {
  return {
    qualityBar: taskRequest.qualityBar,
    contextCount: taskRequest.contexts.length,
    constraintCount: taskRequest.constraints.length,
    cacheMode: taskRequest.cacheMode,
  };
}

function createCacheMetadata(key: string, status: 'hit' | 'miss' | 'bypassed'): TraceMetadata {
  return {
    cacheStatus: status,
    storage: 'sqlite',
    cacheKeyPrefix: key.slice(0, 12),
  };
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

function updateTraceCount(trace: PipelineTraceEvent[]): void {
  const responseOutputEvent = trace.find((event) => event.stage === 'response.output');
  if (!responseOutputEvent) {
    return;
  }

  responseOutputEvent.metadata = {
    ...responseOutputEvent.metadata,
    traceCount: trace.length,
  };
}

function insertAfterRequestReceived(trace: PipelineTraceEvent[], event: PipelineTraceEvent): void {
  const requestIndex = trace.findIndex((traceEvent) => traceEvent.stage === 'request.received');
  if (requestIndex === -1) {
    trace.unshift(event);
    return;
  }

  trace.splice(requestIndex + 1, 0, event);
}

function insertBeforePipelineFinish(trace: PipelineTraceEvent[], event: PipelineTraceEvent): void {
  const finishIndex = trace.findIndex((traceEvent) => traceEvent.stage === 'pipeline.finish');
  if (finishIndex === -1) {
    trace.push(event);
    return;
  }

  trace.splice(finishIndex, 0, event);
}

function buildHitTrace(createTimestamp: () => string, taskRequest: TaskRequest, cachedRecord: CachedTaskRecord): PipelineTraceEvent[] {
  const trace: PipelineTraceEvent[] = [
    createTraceEvent(createTimestamp, 'pipeline.start', 'running', 'Task pipeline started from cache path.', {
      taskChars: taskRequest.task.length,
      contextCount: taskRequest.contexts.length,
      constraintCount: taskRequest.constraints.length,
    }),
    createTraceEvent(createTimestamp, 'request.received', 'completed', 'Task request accepted by orchestrator.', createRequestMetadata(taskRequest)),
    createTraceEvent(createTimestamp, 'cache.lookup', 'completed', 'Cache lookup completed with hit.', createCacheMetadata(cachedRecord.key, 'hit')),
    createTraceEvent(
      createTimestamp,
      'cache.hit',
      'completed',
      'Reused cached task response and skipped structurizer, router, and executor.',
      {
        ...createCacheMetadata(cachedRecord.key, 'hit'),
        route: cachedRecord.response.routeDecision.route,
        modelId: cachedRecord.response.selectedProvider.modelId,
      },
    ),
    createTraceEvent(
      createTimestamp,
      'response.cost',
      'completed',
      cachedRecord.response.costEstimate.detail,
      compactMetadata({
        costStatus: cachedRecord.response.costEstimate.status,
        usageSource: cachedRecord.response.costEstimate.usageSource,
        totalTokens: cachedRecord.response.costEstimate.totalTokens,
        totalCostUsd: cachedRecord.response.costEstimate.totalCostUsd,
        latencyMs: cachedRecord.response.costEstimate.latencyMs ?? cachedRecord.response.providerResult.latencyMs,
        cacheStatus: 'hit',
      }),
    ),
    createTraceEvent(createTimestamp, 'response.output', 'completed', 'Task response loaded from cache.', {
      outputChars: cachedRecord.response.output.length,
      providerStatus: cachedRecord.response.providerResult.status,
      costStatus: cachedRecord.response.costEstimate.status,
      cacheStatus: 'hit',
      traceCount: 0,
    }),
    createTraceEvent(createTimestamp, 'pipeline.finish', 'completed', 'Pipeline completed from cache.', {
      route: cachedRecord.response.routeDecision.route,
      providerStatus: cachedRecord.response.providerResult.status,
      cacheStatus: 'hit',
    }),
  ];

  updateTraceCount(trace);
  return trace;
}

function buildCacheInfo(
  status: 'hit' | 'miss' | 'bypassed',
  key: string,
  detail: string,
  createdAt?: string,
) {
  return CacheInfoSchema.parse({
    status,
    key,
    storage: 'sqlite',
    createdAt,
    detail,
  });
}

function buildCachedTaskResponse(
  createTimestamp: () => string,
  taskRequest: TaskRequest,
  cachedRecord: CachedTaskRecord,
): TaskResponse {
  const pipeline = buildCachedPipelineState(
    taskRequest,
    {
      ...cachedRecord.response,
      diagnostic: undefined,
    },
    createTimestamp,
  );

  const trace = buildHitTrace(createTimestamp, taskRequest, cachedRecord);
  const checkpoint = cachedRecord.response.checkpoint ?? createTaskCheckpoint({
    taskRequest,
    routeDecision: cachedRecord.response.routeDecision,
    plannerResult: cachedRecord.response.plannerResult,
    reasonerResult: cachedRecord.response.reasonerResult,
    pipeline,
    trace,
    capturedAt: cachedRecord.storedAt,
  });

  return TaskResponseSchema.parse({
    ...cachedRecord.response,
    runInfo: {
      mode: 'full',
      reusedCheckpointStages: [],
      historyTraceCount: 0,
      historyTransitionCount: 0,
      detail: 'Cache replay of prior full pipeline run.',
    },
    cacheInfo: buildCacheInfo('hit', cachedRecord.key, 'Cache hit; reused prior task response from SQLite store.', cachedRecord.storedAt),
    pipeline,
    trace,
    checkpoint,
  });
}

function annotateLiveResponse(
  taskRequest: TaskRequest,
  cacheKey: string,
  taskResponse: TaskResponse,
  cacheLookupEvent: PipelineTraceEvent,
  cacheInfoDetail: string,
  cacheInfoStatus: 'miss' | 'bypassed',
  cachedAt?: string,
  cacheWriteEvent?: PipelineTraceEvent,
): TaskResponse {
  const trace = [...taskResponse.trace];
  insertAfterRequestReceived(trace, cacheLookupEvent);

  if (cacheWriteEvent) {
    insertBeforePipelineFinish(trace, cacheWriteEvent);
  }

  updateTraceCount(trace);

  const checkpoint = taskResponse.checkpoint ?? createTaskCheckpoint({
    taskRequest,
    routeDecision: taskResponse.routeDecision,
    plannerResult: taskResponse.plannerResult,
    reasonerResult: taskResponse.reasonerResult,
    pipeline: taskResponse.pipeline,
    trace,
    capturedAt: taskResponse.trace.at(-1)?.timestamp ?? new Date().toISOString(),
  });

  return TaskResponseSchema.parse({
    ...taskResponse,
    runInfo: taskResponse.runInfo ?? {
      mode: 'full',
      reusedCheckpointStages: [],
      historyTraceCount: 0,
      historyTransitionCount: 0,
      detail: 'Full pipeline run.',
    },
    cacheInfo: buildCacheInfo(cacheInfoStatus, cacheKey, cacheInfoDetail, cachedAt),
    trace,
    checkpoint: {
      ...checkpoint,
      trace,
    },
  });
}

function createCacheWriteEvent(
  createTimestamp: () => string,
  key: string,
  cacheStatus: 'miss' | 'bypassed',
  status: PipelineTraceEvent['status'],
  detail: string,
  storedAt?: string,
): PipelineTraceEvent {
  return createTraceEvent(
    createTimestamp,
    'cache.write',
    status,
    detail,
    compactMetadata({
      ...createCacheMetadata(key, cacheStatus),
      storedAt,
    }),
  );
}

export async function runTaskWithCache(
  config: RuntimeConfig,
  providerRegistry: ProviderRegistry,
  taskRequest: TaskRequest,
  taskCache: TaskCacheStore,
  overrides: CachedTaskRunnerDependencies = {},
): Promise<TaskResponse> {
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  const cacheKey = createTaskCacheKey(config, taskRequest);

  if (taskRequest.cacheMode !== 'bypass') {
    try {
      const cachedRecord = taskCache.get(cacheKey);
      if (cachedRecord) {
        return buildCachedTaskResponse(dependencies.createTimestamp, taskRequest, cachedRecord);
      }
    } catch (error) {
      const taskResponse = await dependencies.runTaskPipeline(config, providerRegistry, taskRequest, {
        createTimestamp: dependencies.createTimestamp,
      });
      const message = error instanceof Error ? error.message : 'unknown cache lookup error';

      return annotateLiveResponse(
        taskRequest,
        cacheKey,
        taskResponse,
        createTraceEvent(
          dependencies.createTimestamp,
          'cache.lookup',
          'failed',
          `Cache lookup failed; executing pipeline. ${message}`,
          createCacheMetadata(cacheKey, 'miss'),
        ),
        `Cache lookup failed; live pipeline response returned. ${message}`,
        'miss',
      );
    }
  }

  const taskResponse = await dependencies.runTaskPipeline(config, providerRegistry, taskRequest, {
    createTimestamp: dependencies.createTimestamp,
  });

  const lookupEvent =
    taskRequest.cacheMode === 'bypass'
      ? createTraceEvent(
          dependencies.createTimestamp,
          'cache.lookup',
          'skipped',
          'Cache bypassed by request; executing pipeline.',
          createCacheMetadata(cacheKey, 'bypassed'),
        )
      : createTraceEvent(
          dependencies.createTimestamp,
          'cache.lookup',
          'completed',
          'Cache miss; executing pipeline.',
          createCacheMetadata(cacheKey, 'miss'),
        );

  let cacheWriteEvent: PipelineTraceEvent | undefined;
  let cacheInfoDetail =
    taskRequest.cacheMode === 'bypass'
      ? 'Cache bypassed; executed live pipeline response.'
      : 'Cache miss; executed live pipeline response.';
  let cachedAt: string | undefined;

  if (taskResponse.providerResult.status === 'completed') {
    const storedAt = dependencies.createTimestamp();

    try {
      taskCache.set(cacheKey, toPersistedTaskResponse(taskResponse), storedAt);
      cachedAt = storedAt;
      cacheWriteEvent = createCacheWriteEvent(
        dependencies.createTimestamp,
        cacheKey,
        taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'miss',
        'completed',
        'Stored fresh completed task response in SQLite cache.',
        storedAt,
      );
      cacheInfoDetail =
        taskRequest.cacheMode === 'bypass'
          ? 'Cache bypassed; executed live pipeline and refreshed SQLite cache.'
          : 'Cache miss; executed live pipeline and stored fresh SQLite cache entry.';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown cache write error';
      cacheWriteEvent = createCacheWriteEvent(
        dependencies.createTimestamp,
        cacheKey,
        taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'miss',
        'failed',
        `SQLite cache write failed; primary response kept. ${message}`,
      );
      cacheInfoDetail =
        taskRequest.cacheMode === 'bypass'
          ? `Cache bypassed; executed live pipeline but SQLite write failed. ${message}`
          : `Cache miss; executed live pipeline but SQLite write failed. ${message}`;
    }
  } else {
    cacheWriteEvent = createCacheWriteEvent(
      dependencies.createTimestamp,
      cacheKey,
      taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'miss',
      'skipped',
      'Provider execution failed; cache store skipped.',
    );
    cacheInfoDetail =
      taskRequest.cacheMode === 'bypass'
        ? 'Cache bypassed; provider execution failed, so response was not cached.'
        : 'Cache miss; provider execution failed, so response was not cached.';
  }

  return annotateLiveResponse(
    taskRequest,
    cacheKey,
    taskResponse,
    lookupEvent,
    cacheInfoDetail,
    taskRequest.cacheMode === 'bypass' ? 'bypassed' : 'miss',
    cachedAt,
    cacheWriteEvent,
  );
}