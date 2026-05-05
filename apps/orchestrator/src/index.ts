import * as readline from 'node:readline';
import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';
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
        const message = error instanceof Error ? error.message : 'Task handling failed.';
        writeProtocolEvent({
          id: request.id,
          type: 'error',
          message,
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
      const message = error instanceof Error ? error.message : 'Invalid orchestrator request.';
      writeProtocolEvent({
        type: 'error',
        message: `Invalid orchestrator request: ${message}`,
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
    const providerRegistry = createProviderRegistry(config.providerKeys);
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
    const message = error instanceof ConfigurationError ? error.message : 'Unexpected orchestrator bootstrap error.';
    logOrchestrator(message);
    writeProtocolEvent({
      type: 'error',
      message,
    });
    process.exitCode = 1;
  }
}

startOrchestrator();