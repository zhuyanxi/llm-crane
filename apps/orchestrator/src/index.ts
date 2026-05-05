import * as readline from 'node:readline';
import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';
import { createProviderRegistry, getProviderIdForModel, type ProviderRegistry } from '@llm-crane/providers';
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
import { EXECUTOR_SYSTEM_PROMPT, buildProviderUserPrompt, invokeRoutedProvider } from './providerExecution';
import { buildRouterScoreInput, routeTask } from './router';
import { buildStructurizerPrompt, structurizeTaskRequest } from './structurizer';

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

async function createTaskResponse(config: RuntimeConfig, providerRegistry: ProviderRegistry, taskRequest: TaskRequest) {
  const structurizerResult = structurizeTaskRequest(taskRequest);
  const routeDecision = routeTask(structurizerResult);
  const routerScoreInput = buildRouterScoreInput(structurizerResult);
  const modelId = routeDecision.route === 'simple' ? config.defaultSimpleModel : config.defaultComplexModel;
  const providerId = getProviderIdForModel(modelId) ?? 'openai';
  const promptText = buildStructurizerPrompt(taskRequest);
  const providerUserPrompt = buildProviderUserPrompt(taskRequest, structurizerResult, routeDecision);
  const providerResult = await invokeRoutedProvider(providerRegistry, modelId, taskRequest, structurizerResult, routeDecision);

  return TaskResponseSchema.parse({
    output:
      providerResult.status === 'completed'
        ? providerResult.outputText
        : `Provider call failed (${providerResult.error?.code ?? 'unknown'}): ${providerResult.error?.message ?? 'Unknown error.'}`,
    routeDecision,
    selectedProvider: {
      providerId,
      modelId,
      reason: routeDecision.reason,
      confidence: routeDecision.confidence,
    },
    providerResult,
    trace: [
      {
        stage: 'bootstrap',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: 'Orchestrator process ready.',
      },
      {
        stage: 'structurizer.prompt',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: `Prompt chars=${promptText.length}; system prompt chars=${STRUCTURIZER_SYSTEM_PROMPT.length}`,
      },
      {
        stage: 'structurizer.parse',
        status: structurizerResult.status === 'structured' ? 'completed' : 'failed',
        timestamp: createTimestamp(),
        detail: `taskType=${structurizerResult.structuredTask.taskType}; openQuestions=${structurizerResult.structuredTask.openQuestions.length}`,
      },
      {
        stage: 'router.score-input',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: `chars=${routerScoreInput.length}`,
      },
      {
        stage: 'router.decision',
        status: routeDecision.status === 'routed' ? 'completed' : 'failed',
        timestamp: createTimestamp(),
        detail: `route=${routeDecision.route}; score=${routeDecision.complexityScore}; confidence=${routeDecision.confidence}`,
      },
      {
        stage: 'provider.prompt',
        status: 'completed',
        timestamp: createTimestamp(),
        detail: `systemChars=${EXECUTOR_SYSTEM_PROMPT.length}; userChars=${providerUserPrompt.length}`,
      },
      {
        stage: 'provider.invoke',
        status: providerResult.status === 'completed' ? 'completed' : 'failed',
        timestamp: createTimestamp(),
        detail:
          providerResult.status === 'completed'
            ? `provider=${providerResult.providerId}; model=${providerResult.modelId}; latencyMs=${providerResult.latencyMs ?? -1}`
            : `provider=${providerResult.providerId}; model=${providerResult.modelId}; error=${providerResult.error?.code ?? 'unknown'}`,
      },
      {
        stage: 'response.sent',
        status: 'completed',
        timestamp: createTimestamp(),
        detail:
          providerResult.error?.message ??
          routeDecision.fallbackReason ??
          structurizerResult.fallbackReason ??
          'Structured task, route decision, and provider result returned to extension.',
      },
    ],
  });
}

async function handleRequest(config: RuntimeConfig, providerRegistry: ProviderRegistry, request: OrchestratorRequest): Promise<void> {
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
          response: await createTaskResponse(config, providerRegistry, taskRequest),
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

function attachStdioProtocol(config: RuntimeConfig, providerRegistry: ProviderRegistry): void {
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
      void handleRequest(config, providerRegistry, request);
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
    const providerRegistry = createProviderRegistry(config.providerKeys);

    logOrchestrator('orchestrator ready');
    logOrchestrator(`simple=${config.defaultSimpleModel} complex=${config.defaultComplexModel}`);
    logOrchestrator(`structurizer prompt chars=${STRUCTURIZER_SYSTEM_PROMPT.length}`);

    attachStdioProtocol(config, providerRegistry);
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