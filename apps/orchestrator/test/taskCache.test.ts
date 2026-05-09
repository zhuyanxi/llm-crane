import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig, TaskRequest, TaskResponse } from '@llm-crane/schemas';
import { createTaskCacheKey, createTaskCacheMetadata, SQLiteTaskCache, validateCachedTaskRecord } from '../src/taskCache';

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
  task: 'Summarize current file.',
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

const persistedResponse: Pick<TaskResponse, 'output' | 'routeDecision' | 'selectedProvider' | 'providerResult' | 'costEstimate'> = {
  output: 'cached output',
  routeDecision: {
    status: 'routed',
    route: 'simple',
    reason: 'Narrow task.',
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
    outputText: 'cached output',
    latencyMs: 120,
  },
  costEstimate: {
    status: 'estimated',
    currency: 'USD',
    pricingUnit: 'usd-per-1m-tokens',
    modelId: 'gpt-4o-mini',
    usageSource: 'estimated',
    pricingSource: 'catalog',
    inputTokens: 50,
    outputTokens: 20,
    totalTokens: 70,
    inputCostUsd: 0.0000075,
    outputCostUsd: 0.000012,
    totalCostUsd: 0.0000195,
    latencyMs: 120,
    detail: 'Estimated from text length fallback and local price catalog.',
  },
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLiteTaskCache', () => {
  it('stores and returns persisted task response payload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-crane-cache-'));
    tempDirectories.push(directory);
    const cache = new SQLiteTaskCache(path.join(directory, 'task-cache.sqlite'));

    cache.set('cache-key', persistedResponse, '2026-05-05T00:00:00.000Z', createTaskCacheMetadata(runtimeConfig));
    const record = cache.get('cache-key');
    cache.close();

    expect(record?.storedAt).toBe('2026-05-05T00:00:00.000Z');
    expect(record?.response.output).toBe('cached output');
    expect(record?.response.selectedProvider.modelId).toBe('gpt-4o-mini');
    expect(record?.metadata?.schemaVersion).toBeDefined();
    expect(record?.metadata?.promptVersion).toBeDefined();
  });
});

describe('createTaskCacheKey', () => {
  it('keeps cache fingerprint stable when only cacheMode changes', () => {
    const defaultKey = createTaskCacheKey(runtimeConfig, baseTaskRequest);
    const bypassKey = createTaskCacheKey(runtimeConfig, {
      ...baseTaskRequest,
      cacheMode: 'bypass',
    });

    expect(defaultKey).toBe(bypassKey);
  });

  it('keeps cache fingerprint stable when only ttl policy changes', () => {
    const defaultKey = createTaskCacheKey(runtimeConfig, baseTaskRequest);
    const stricterKey = createTaskCacheKey(
      {
        ...runtimeConfig,
        cachePolicy: {
          ttlMs: 1_000,
        },
      },
      baseTaskRequest,
    );

    expect(defaultKey).toBe(stricterKey);
  });
});

describe('validateCachedTaskRecord', () => {
  it('invalidates when template version changed', () => {
    const validation = validateCachedTaskRecord(
      runtimeConfig,
      {
        key: 'cache-key',
        storedAt: '2026-05-05T00:00:00.000Z',
        response: persistedResponse,
        metadata: {
          ...createTaskCacheMetadata(runtimeConfig),
          templateVersion: 'stale-template-version',
        },
      },
      '2026-05-05T00:00:10.000Z',
    );

    expect(validation.status).toBe('invalid');
    if (validation.status === 'invalid') {
      expect(validation.reason).toBe('template-version');
      expect(validation.detail).toContain('task template definitions changed');
    }
  });
});