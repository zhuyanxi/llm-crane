import * as readline from 'node:readline';
import {
  ConfigurationError,
  createDiagnosticError,
  formatDiagnosticLog,
  loadRuntimeConfig,
} from '@llm-crane/core';
import { createProviderRegistry, type ProviderRegistry } from '@llm-crane/providers';
import { buildStructurizerSystemPrompt } from '@llm-crane/prompts';
import {
  OrchestratorEventSchema,
  OrchestratorRequestSchema,
  TaskRequestSchema,
  type OrchestratorEvent,
  type OrchestratorRequest,
  type RuntimeConfig,
} from '@llm-crane/schemas';
import { runTaskWithCache } from './cachedTaskRunner';
import { runTaskPipeline } from './pipelineRunner';
import { resolveTaskCachePath, SQLiteTaskCache, type TaskCacheStore } from './taskCache';
import { SQLiteAnalyticsMetricsStore, type AnalyticsMetricsStore } from './analyticsMetrics';

function logOrchestrator(message: string): void {
  console.error(`[llm-crane] ${message}`);
}

function writeProtocolEvent(event: OrchestratorEvent): void {
  const serialized = JSON.stringify(OrchestratorEventSchema.parse(event));
  process.stdout.write(`${serialized}\n`);
}

function writeProtocolError(id: string | undefined, error: unknown, fallback: Parameters<typeof createDiagnosticError>[1]): void {
  const diagnosticError = createDiagnosticError(error, fallback);

  logOrchestrator(`[diagnostic] ${formatDiagnosticLog(diagnosticError.diagnostic)}`);
  writeProtocolEvent({
    type: 'error',
    id,
    message: diagnosticError.diagnostic.message,
    diagnostic: diagnosticError.diagnostic,
  });
}

function createTimestamp(): string {
  return new Date().toISOString();
}

async function handleRequest(
  config: RuntimeConfig,
  providerRegistry: ProviderRegistry,
  taskCache: TaskCacheStore,
  metricsStore: AnalyticsMetricsStore,
  request: OrchestratorRequest,
): Promise<void> {
  switch (request.type) {
    case 'health':
      writeProtocolEvent({
        id: request.id,
        type: 'healthResult',
        status: 'ok',
        detail: 'Orchestrator healthy.',
      });
      return;
    case 'runTask':
      try {
        const taskRequest = TaskRequestSchema.parse(request.request);

        writeProtocolEvent({
          id: request.id,
          type: 'taskResult',
          response: await runTaskWithCache(config, providerRegistry, taskRequest, taskCache, {
            createTimestamp,
          }, metricsStore),
        });
      } catch (error) {
        writeProtocolError(request.id, error, {
          category: 'internal',
          code: 'internal.task_request_failed',
          summary: 'Task request failed',
          message: 'LLM Crane failed while handling task request.',
          stage: 'orchestrator.runTask',
        });
      }
      return;
    case 'analyticsQuery':
      try {
        const dayResult = metricsStore.aggregate('day', request.days);
        const totalRequests = dayResult.rows.reduce((sum, r) => sum + r.totalRequests, 0);
        const totalSimple = dayResult.rows.reduce((sum, r) => sum + r.simpleRouteCount, 0);
        const totalComplex = dayResult.rows.reduce((sum, r) => sum + r.complexRouteCount, 0);
        const totalCost = dayResult.rows.reduce((sum, r) => sum + r.totalCostUsd, 0);
        const totalCacheHits = dayResult.rows.reduce((sum, r) => sum + r.cacheHitCount, 0);
        const totalCacheAll = dayResult.rows.reduce((sum, r) => sum + r.cacheHitCount + r.cacheMissCount + r.cacheBypassCount, 0);
        const totalVerifierPass = dayResult.rows.reduce((sum, r) => sum + r.verifierPassCount, 0);
        const totalVerifierAll = dayResult.rows.reduce((sum, r) => sum + r.verifierPassCount + r.verifierFailCount + r.verifierWarningCount, 0);
        const avgLatency = dayResult.rows.reduce((sum, r) => sum + r.avgLatencyMs, 0) / Math.max(1, dayResult.rows.length);

        // Savings vs all-complex baseline
        const complexRows = dayResult.rows.filter((r) => r.complexRouteCount > 0);
        const avgComplexCost = complexRows.length > 0
          ? complexRows.reduce((sum, r) => sum + r.totalCostUsd, 0) / complexRows.reduce((sum, r) => sum + r.complexRouteCount, 0)
          : 0.01; // estimated fallback
        const baselineCostUsd = totalRequests * avgComplexCost;
        const savingsUsd = Math.max(0, baselineCostUsd - totalCost);
        const savingsRatio = baselineCostUsd > 0 ? Math.round(savingsUsd / baselineCostUsd * 100) / 100 : 0;
        const savings = {
          actualCostUsd: Math.round(totalCost * 10000) / 10000,
          baselineCostUsd: Math.round(baselineCostUsd * 10000) / 10000,
          savingsUsd: Math.round(savingsUsd * 10000) / 10000,
          savingsRatio,
          assumption: totalComplex > 0
            ? `Baseline assumes all ${totalRequests} requests used complex model at avg complex cost $${avgComplexCost.toFixed(4)}. Actual mixed routing saved $${savingsUsd.toFixed(4)}.`
            : `No complex route data available. Baseline estimated from typical complex model cost. Savings approximate.`,
        };

        writeProtocolEvent({
          id: request.id,
          type: 'analyticsResult',
          dashboard: {
            totalRequests,
            avgCostUsd: totalRequests > 0 ? Math.round(totalCost / totalRequests * 10000) / 10000 : 0,
            cacheHitRate: totalCacheAll > 0 ? Math.round(totalCacheHits / totalCacheAll * 100) / 100 : 0,
            complexRouteRatio: totalRequests > 0 ? Math.round(totalComplex / totalRequests * 100) / 100 : 0,
            verifierPassRate: totalVerifierAll > 0 ? Math.round(totalVerifierPass / totalVerifierAll * 100) / 100 : undefined,
            simpleRouteCount: totalSimple,
            complexRouteCount: totalComplex,
            totalCostUsd: Math.round(totalCost * 10000) / 10000,
            avgLatencyMs: Math.round(avgLatency),
            days: request.days,
          },
          savings,
          daily: dayResult.rows.map((r) => ({
            period: r.period,
            requests: r.totalRequests,
            simpleCount: r.simpleRouteCount,
            complexCount: r.complexRouteCount,
            costUsd: Math.round(r.totalCostUsd * 10000) / 10000,
          })),
        });
      } catch (error) {
        writeProtocolError(request.id, error, {
          category: 'internal',
          code: 'internal.analytics_query_failed',
          summary: 'Analytics query failed',
          message: 'LLM Crane failed while querying analytics metrics.',
          stage: 'orchestrator.analyticsQuery',
        });
      }
      return;
    case 'rerunTask':
      try {
        writeProtocolEvent({
          id: request.id,
          type: 'taskResult',
          response: await runTaskPipeline(
            config,
            providerRegistry,
            request.rerun.checkpoint.taskRequest,
            {
              createTimestamp,
            },
            {
              mode: 'stage-rerun',
              rerun: request.rerun,
            },
            metricsStore,
          ),
        });
      } catch (error) {
        writeProtocolError(request.id, error, {
          category: 'internal',
          code: 'internal.rerun_task_failed',
          summary: 'Stage rerun failed',
          message: 'LLM Crane failed while handling stage rerun request.',
          stage: 'orchestrator.rerunTask',
        });
      }
      return;
  }
}

function attachStdioProtocol(config: RuntimeConfig, providerRegistry: ProviderRegistry, taskCache: TaskCacheStore, metricsStore: AnalyticsMetricsStore): void {
  const reader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const request = OrchestratorRequestSchema.parse(JSON.parse(trimmed));
      void handleRequest(config, providerRegistry, taskCache, metricsStore, request);
    } catch (error) {
      writeProtocolError(undefined, error, {
        category: 'schema',
        code: 'schema.invalid_orchestrator_request',
        summary: 'Invalid orchestrator request',
        message: 'Incoming orchestrator protocol payload was invalid.',
        stage: 'orchestrator.protocol',
      });
    }
  });

  reader.on('close', () => {
    taskCache.close();
    metricsStore.close();
    logOrchestrator('stdin closed; shutting down orchestrator process.');
    process.exit(0);
  });
}

export function startOrchestrator(): void {
  try {
    const config = loadRuntimeConfig(process.env);
    const providerRegistry = createProviderRegistry({
      apiKeys: config.providerKeys,
      runtimeProfiles: config.runtimeProfiles,
    });
    const cachePath = resolveTaskCachePath();
    const taskCache = new SQLiteTaskCache(cachePath);
    const metricsStore = new SQLiteAnalyticsMetricsStore(cachePath);

    logOrchestrator('orchestrator ready');
    logOrchestrator(`simple=${config.defaultSimpleModel} complex=${config.defaultComplexModel}`);
    logOrchestrator(`structurizer prompt chars=${buildStructurizerSystemPrompt().length}`);
    logOrchestrator(`sqlite cache=${cachePath}`);

    attachStdioProtocol(config, providerRegistry, taskCache, metricsStore);
    writeProtocolEvent({
      type: 'ready',
      transport: 'stdio',
      detail: 'Orchestrator stdio transport online.',
    });
  } catch (error) {
    writeProtocolError(undefined, error, {
      category: error instanceof ConfigurationError ? 'configuration' : 'internal',
      code: error instanceof ConfigurationError ? 'configuration.bootstrap_failed' : 'internal.bootstrap_failed',
      summary: error instanceof ConfigurationError ? 'Configuration issue' : 'Orchestrator bootstrap failed',
      message: error instanceof ConfigurationError ? error.message : 'Unexpected orchestrator bootstrap error.',
      stage: 'orchestrator.bootstrap',
    });
    process.exitCode = 1;
  }
}

startOrchestrator();