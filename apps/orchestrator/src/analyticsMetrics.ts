import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskMetricsRecord } from '@llm-crane/schemas';

export type MetricsAggregationDimension = 'request' | 'day' | 'week';

export type AggregatedMetricsRow = {
  period: string;
  totalRequests: number;
  simpleRouteCount: number;
  complexRouteCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheBypassCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  verifierPassCount: number;
  verifierFailCount: number;
  verifierWarningCount: number;
};

export type AggregatedMetricsResult = {
  dimension: MetricsAggregationDimension;
  rows: AggregatedMetricsRow[];
};

export interface AnalyticsMetricsStore {
  record(metrics: TaskMetricsRecord): void;
  aggregate(dimension: MetricsAggregationDimension, limit?: number): AggregatedMetricsResult;
  close(): void;
}

function ensureMetricsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      task_chars INTEGER NOT NULL,
      route TEXT NOT NULL,
      cache_status TEXT,
      provider_id TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      latency_ms INTEGER,
      total_cost_usd REAL,
      cost_status TEXT,
      verifier_verdict TEXT NOT NULL DEFAULT 'none',
      strategy TEXT,
      budget_preference TEXT,
      prompt_version TEXT
    )
  `);
}

function periodExpression(dimension: MetricsAggregationDimension): string {
  switch (dimension) {
    case 'day':
      return "DATE(timestamp)";
    case 'week':
      return "strftime('%Y-W%W', timestamp)";
    default:
      return "timestamp";
  }
}

function buildAggregationQuery(dimension: MetricsAggregationDimension, limit: number): string {
  const periodExpr = periodExpression(dimension);
  return `
    SELECT
      ${periodExpr} AS period,
      COUNT(*) AS total_requests,
      SUM(CASE WHEN route = 'simple' THEN 1 ELSE 0 END) AS simple_route_count,
      SUM(CASE WHEN route = 'complex' THEN 1 ELSE 0 END) AS complex_route_count,
      SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) AS cache_hit_count,
      SUM(CASE WHEN cache_status = 'miss' THEN 1 ELSE 0 END) AS cache_miss_count,
      SUM(CASE WHEN cache_status = 'bypass' THEN 1 ELSE 0 END) AS cache_bypass_count,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
      SUM(CASE WHEN verifier_verdict = 'pass' THEN 1 ELSE 0 END) AS verifier_pass_count,
      SUM(CASE WHEN verifier_verdict = 'fail' THEN 1 ELSE 0 END) AS verifier_fail_count,
      SUM(CASE WHEN verifier_verdict = 'warning' THEN 1 ELSE 0 END) AS verifier_warning_count
    FROM task_metrics
    GROUP BY period
    ORDER BY period DESC
    LIMIT ?
  `;
}

export class SQLiteAnalyticsMetricsStore implements AnalyticsMetricsStore {
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.database = new DatabaseSync(dbPath);
    ensureMetricsTable(this.database);

    this.insertStatement = this.database.prepare(`
      INSERT INTO task_metrics (
        timestamp, task_chars, route, cache_status, provider_id, model_id,
        input_tokens, output_tokens, total_tokens, latency_ms, total_cost_usd,
        cost_status, verifier_verdict, strategy, budget_preference, prompt_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  record(metrics: TaskMetricsRecord): void {
    try {
      this.insertStatement.run(
        metrics.timestamp,
        metrics.taskChars,
        metrics.route,
        metrics.cacheStatus ?? null,
        metrics.providerId ?? null,
        metrics.modelId ?? null,
        metrics.inputTokens ?? null,
        metrics.outputTokens ?? null,
        metrics.totalTokens ?? null,
        metrics.latencyMs ?? null,
        metrics.totalCostUsd ?? null,
        metrics.costStatus ?? null,
        metrics.verifierVerdict,
        metrics.strategy ?? null,
        metrics.budgetPreference ?? null,
        metrics.promptVersion ?? null,
      );
    } catch {
      // Metrics recording is best-effort; never block the main pipeline
    }
  }

  aggregate(dimension: MetricsAggregationDimension, limit = 30): AggregatedMetricsResult {
    const query = buildAggregationQuery(dimension, limit);
    const statement = this.database.prepare(query);
    const rows = statement.all(limit) as Record<string, unknown>[];
    // Normalize field names from SQL column aliases
    const mapped: AggregatedMetricsRow[] = rows.map((row) => ({
      period: String(row.period ?? ''),
      totalRequests: Number(row.total_requests ?? 0),
      simpleRouteCount: Number(row.simple_route_count ?? 0),
      complexRouteCount: Number(row.complex_route_count ?? 0),
      cacheHitCount: Number(row.cache_hit_count ?? 0),
      cacheMissCount: Number(row.cache_miss_count ?? 0),
      cacheBypassCount: Number(row.cache_bypass_count ?? 0),
      totalInputTokens: Number(row.total_input_tokens ?? 0),
      totalOutputTokens: Number(row.total_output_tokens ?? 0),
      avgLatencyMs: Number(row.avg_latency_ms ?? 0),
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      verifierPassCount: Number(row.verifier_pass_count ?? 0),
      verifierFailCount: Number(row.verifier_fail_count ?? 0),
      verifierWarningCount: Number(row.verifier_warning_count ?? 0),
    }));

    return { dimension, rows: mapped };
  }

  close(): void {
    this.database.close();
  }
}
