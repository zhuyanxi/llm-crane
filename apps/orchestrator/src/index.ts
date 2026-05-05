import * as readline from 'node:readline';
import {
  ConfigurationError,
  createDiagnosticError,
  formatDiagnosticLog,
  loadRuntimeConfig,
} from '@llm-crane/core';
import { createProviderRegistry, type ProviderRegistry } from '@llm-crane/providers';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  OrchestratorEventSchema,
  OrchestratorRequestSchema,
  TaskRequestSchema,
  type OrchestratorEvent,
  type OrchestratorRequest,
  type RuntimeConfig,
} from '@llm-crane/schemas';
import { runTaskWithCache } from './cachedTaskRunner';
import { resolveTaskCachePath, SQLiteTaskCache, type TaskCacheStore } from './taskCache';

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
          }),
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
  }
}

function attachStdioProtocol(config: RuntimeConfig, providerRegistry: ProviderRegistry, taskCache: TaskCacheStore): void {
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
      void handleRequest(config, providerRegistry, taskCache, request);
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

    logOrchestrator('orchestrator ready');
    logOrchestrator(`simple=${config.defaultSimpleModel} complex=${config.defaultComplexModel}`);
    logOrchestrator(`structurizer prompt chars=${STRUCTURIZER_SYSTEM_PROMPT.length}`);
    logOrchestrator(`sqlite cache=${cachePath}`);

    attachStdioProtocol(config, providerRegistry, taskCache);
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