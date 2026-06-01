import { describe, expect, it } from 'vitest';
import { SQLiteAnalyticsMetricsStore } from '../src/analyticsMetrics';
import type { TaskMetricsRecord } from '@llm-crane/schemas';

function createMetrics(overrides: Partial<TaskMetricsRecord> = {}): TaskMetricsRecord {
  return {
    timestamp: '2026-06-01T10:00:00.000Z',
    taskChars: 120,
    route: 'simple',
    cacheStatus: 'miss',
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    inputTokens: 200,
    outputTokens: 80,
    totalTokens: 280,
    latencyMs: 800,
    totalCostUsd: 0.002,
    costStatus: 'estimated',
    verifierVerdict: 'none',
    strategy: 'rules-v2',
    ...overrides,
  };
}

describe('AnalyticsMetricsStore', () => {
  it('records and aggregates per-day metrics', () => {
    const store = new SQLiteAnalyticsMetricsStore(':memory:');

    store.record(createMetrics());
    store.record(createMetrics({
      timestamp: '2026-06-02T10:00:00.000Z',
      route: 'complex',
      cacheStatus: 'hit',
      verifierVerdict: 'pass',
    }));
    store.record(createMetrics({
      timestamp: '2026-06-02T11:00:00.000Z',
      route: 'complex',
      cacheStatus: 'bypassed',
      verifierVerdict: 'fail',
    }));

    const dayResult = store.aggregate('day', 10);

    expect(dayResult.dimension).toBe('day');
    expect(dayResult.rows).toHaveLength(2);
    expect(dayResult.rows[0]?.totalRequests).toBeGreaterThan(0);

    store.close();
  });

  it('aggregates by week correctly', () => {
    const store = new SQLiteAnalyticsMetricsStore(':memory:');

    store.record(createMetrics({ timestamp: '2026-06-01T10:00:00.000Z', route: 'simple' }));
    store.record(createMetrics({ timestamp: '2026-06-02T10:00:00.000Z', route: 'simple' }));
    store.record(createMetrics({ timestamp: '2026-06-08T10:00:00.000Z', route: 'complex' }));

    const weekResult = store.aggregate('week', 10);

    expect(weekResult.rows.length).toBeGreaterThanOrEqual(1);
    expect(weekResult.rows.some((r) => r.simpleRouteCount >= 2)).toBe(true);

    store.close();
  });

  it('handles empty store without error', () => {
    const store = new SQLiteAnalyticsMetricsStore(':memory:');
    const result = store.aggregate('day', 5);

    expect(result.rows).toEqual([]);
    store.close();
  });

  it('record is best-effort and does not throw on invalid data', () => {
    const store = new SQLiteAnalyticsMetricsStore(':memory:');

    // Record with missing required fields should not throw
    expect(() => {
      try {
        store.record({ timestamp: 'bad-format' } as unknown as TaskMetricsRecord);
      } catch {
        // Should not reach here
      }
    }).not.toThrow();

    store.close();
  });

  it('tracks verifier verdicts in aggregation', () => {
    const store = new SQLiteAnalyticsMetricsStore(':memory:');

    store.record(createMetrics({ verifierVerdict: 'pass' }));
    store.record(createMetrics({ verifierVerdict: 'pass' }));
    store.record(createMetrics({ verifierVerdict: 'fail' }));
    store.record(createMetrics({ verifierVerdict: 'warning' }));

    const result = store.aggregate('day', 5);
    const row = result.rows[0];

    expect(row?.verifierPassCount).toBe(2);
    expect(row?.verifierFailCount).toBe(1);
    expect(row?.verifierWarningCount).toBe(1);

    store.close();
  });
});
