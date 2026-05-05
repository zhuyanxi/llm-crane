import * as readline from 'node:readline';
import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';
import { getProviderIdForModel } from '@llm-crane/providers';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';
import {
  OrchestratorEventSchema,
  OrchestratorRequestSchema,
  TaskRequestSchema,
  TaskResponseSchema,
  type OrchestratorEvent,
  type OrchestratorRequest,
  type RuntimeConfig,
  type TaskRequest,
} from '@llm-crane/schemas';

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

function summarizeContexts(taskRequest: TaskRequest): string {
  if (taskRequest.contexts.length === 0) {
    return 'manual input only';
  }

  return taskRequest.contexts
    .map((context) => {
      const parts: string[] = [context.source];
      if (context.languageId) {
        parts.push(context.languageId);
      }
      if (context.uri) {
        parts.push(context.uri);
      }
      return parts.join(' / ');
    })
    .join('; ');
}

function createTaskResponse(config: RuntimeConfig, taskRequest: TaskRequest) {
  const modelId = config.defaultSimpleModel;
  const providerId = getProviderIdForModel(modelId) ?? 'openai';

  return TaskResponseSchema.parse({
    output: `Lifecycle probe complete. Task: ${taskRequest.task}\nContexts: ${summarizeContexts(taskRequest)}\nStructurizer prompt chars: ${STRUCTURIZER_SYSTEM_PROMPT.length}`,
    selectedProvider: {
      providerId,
      modelId,
      reason: 'V0-S07 subprocess lifecycle probe over stdio transport.',
      confidence: 0.2,
    },
    trace: [
      {
        stage: 'bootstrap',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: 'Orchestrator process ready.',
      },
      {
        stage: 'request.received',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: `Contexts=${taskRequest.contexts.length}`,
      },
      {
        stage: 'response.sent',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: 'Task response returned to extension.',
      },
    ],
  });
}

function handleRequest(config: RuntimeConfig, request: OrchestratorRequest): void {
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
          response: createTaskResponse(config, taskRequest),
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

function attachStdioProtocol(config: RuntimeConfig): void {
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
      handleRequest(config, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid orchestrator request.';
      writeProtocolEvent({
        type: 'error',
        message: `Invalid orchestrator request: ${message}`,
      });
    }
  });

  reader.on('close', () => {
    logOrchestrator('stdin closed; shutting down orchestrator process.');
    process.exit(0);
  });
}

export function startOrchestrator(): void {
  try {
    const config = loadRuntimeConfig(process.env);

    logOrchestrator('orchestrator ready');
    logOrchestrator(`simple=${config.defaultSimpleModel} complex=${config.defaultComplexModel}`);
    logOrchestrator(`structurizer prompt chars=${STRUCTURIZER_SYSTEM_PROMPT.length}`);

    attachStdioProtocol(config);
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