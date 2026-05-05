import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig, TaskRequest, TaskResponse } from '@llm-crane/schemas';
import { createTaskCacheKey, SQLiteTaskCache } from '../src/taskCache';

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

    cache.set('cache-key', persistedResponse, '2026-05-05T00:00:00.000Z');
    const record = cache.get('cache-key');
    cache.close();

    expect(record?.storedAt).toBe('2026-05-05T00:00:00.000Z');
    expect(record?.response.output).toBe('cached output');
    expect(record?.response.selectedProvider.modelId).toBe('gpt-4o-mini');
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
});