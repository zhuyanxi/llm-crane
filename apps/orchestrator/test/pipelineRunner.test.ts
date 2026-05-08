import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry, type FetchLike } from '@llm-crane/providers';
import type { RuntimeConfig, TaskRequest } from '@llm-crane/schemas';
import { runTaskPipeline } from '../src/pipelineRunner';

function createJsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

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

function createProviderRegistryStub(outputText: string) {
  return {
    invoke: vi.fn().mockResolvedValue({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      outputText,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      latencyMs: 120,
    }),
  };
}

describe('runTaskPipeline', () => {
  it('runs simple path end to end with simple model', async () => {
    const providerRegistry = createProviderRegistryStub('simple result');
    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    expect(response.selectedProvider.modelId).toBe('gpt-4o-mini');
    expect(response.providerResult.status).toBe('completed');
    expect(response.costEstimate.status).toBe('exact');
    expect(response.diagnostic).toBeUndefined();
    expect(response.costEstimate.totalCostUsd).toBeGreaterThan(0);
    expect(response.output).toBe('simple result');
    expect(response.pipeline.graph).toBe('simple-v1');
    expect(response.pipeline.state).toBe('completed');
    expect(response.pipeline.stages.some((stage) => stage.stageId === 'planner')).toBe(false);
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'executor')?.state).toBe('completed');
    expect(response.reasonerResult?.status).toBe('skipped');
    expect(response.reasonerResult?.earlyExitReason).toContain('simple path');
    expect(response.trace.some((event) => event.stage === 'request.received' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'reasoner.finish' && event.status === 'skipped')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'response.cost' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'response.output' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'pipeline.finish' && event.status === 'completed')).toBe(true);
    expect(response.selectedProvider.runtimeId).toBeUndefined();
  });

  it('runs complex path end to end with complex model', async () => {
    const providerRegistry = {
      invoke: vi.fn().mockResolvedValue({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
        outputText: 'complex result',
        latencyMs: 220,
      }),
    };

    const taskRequest: TaskRequest = {
      task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
      qualityBar: 'high',
      constraints: ['Keep public API stable', 'Avoid schema churn'],
      contexts: [
        {
          source: 'workspace',
          uri: '/workspace',
          content: 'workspace snapshot',
        },
        {
          source: 'file',
          uri: '/workspace/src/server.ts',
          languageId: 'typescript',
          content: 'export function start() {}',
        },
      ],
    };

    const response = await runTaskPipeline(runtimeConfig, providerRegistry as never, taskRequest);

    expect(response.selectedProvider.modelId).toBe('claude-3-5-sonnet-latest');
    expect(response.routeDecision.route).toBe('complex');
    expect(response.providerResult.status).toBe('completed');
    expect(response.costEstimate.status).toBe('estimated');
    expect(response.diagnostic).toBeUndefined();
    expect(response.costEstimate.totalTokens).toBeGreaterThan(0);
    expect(response.plannerResult?.status).toBe('planned');
    expect(response.plannerResult?.steps.length).toBeGreaterThan(0);
    expect(response.reasonerResult?.status).toBe('reasoned');
    expect(response.reasonerResult?.needReasoning).toBe(true);
    expect(response.reasonerResult?.summary).toContain('Escalate reasoning');
    expect(response.pipeline.graph).toBe('complex-v1');
    expect(response.pipeline.state).toBe('completed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'planner')?.state).toBe('completed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'reasoner')?.state).toBe('completed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'verifier')?.state).toBe('skipped');
    expect(response.trace.some((event) => event.stage === 'planner.finish' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'reasoner.finish' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'completed')).toBe(true);
  });

  it('honors manual complex-default override on simple route and records override trace', async () => {
    const invokeRoutedProvider = vi.fn(async (_providerRegistry: unknown, modelId: string) => ({
      status: 'completed' as const,
      providerId: 'anthropic' as const,
      modelId,
      outputText: 'manual override result',
      latencyMs: 180,
    }));

    const response = await runTaskPipeline(
      runtimeConfig,
      {} as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
        policyOverrides: {
          modelOverride: {
            mode: 'complex-default',
          },
        },
      },
      {
        invokeRoutedProvider,
      },
    );

    const overrideEvent = response.trace.find((event) => event.stage === 'policy.override');

    expect(response.routeDecision.route).toBe('simple');
    expect(invokeRoutedProvider.mock.calls[0]?.[1]).toBe('claude-3-5-sonnet-latest');
    expect(response.selectedProvider.modelId).toBe('claude-3-5-sonnet-latest');
    expect(response.selectedProvider.reason).toContain('Manual override pinned execution to complex default model claude-3-5-sonnet-latest');
    expect(overrideEvent?.status).toBe('completed');
    expect(overrideEvent?.metadata.mode).toBe('complex-default');
    expect(overrideEvent?.metadata.modelId).toBe('claude-3-5-sonnet-latest');
  });

  it('keeps specific manual override across executor rerun', async () => {
    const invokeRoutedProvider = vi
      .fn(async (_providerRegistry: unknown, modelId: string) => ({
        status: 'completed' as const,
        providerId: 'anthropic' as const,
        modelId,
        outputText: `manual rerun result ${modelId}`,
        latencyMs: 160,
      }));

    const taskRequest: TaskRequest = {
      task: 'Refactor current selection to reduce duplication without changing public API.',
      qualityBar: 'fast',
      constraints: [],
      contexts: [
        {
          source: 'selection',
          uri: '/workspace/src/auth.ts',
          languageId: 'typescript',
          content: 'function loginUser() { return doLogin(); }',
        },
      ],
      policyOverrides: {
        modelOverride: {
          mode: 'specific',
          modelId: 'claude-3-5-sonnet-latest',
        },
      },
    };

    const firstResponse = await runTaskPipeline(
      runtimeConfig,
      {} as never,
      taskRequest,
      {
        invokeRoutedProvider,
      },
    );
    const rerunResponse = await runTaskPipeline(
      runtimeConfig,
      {} as never,
      firstResponse.checkpoint.taskRequest,
      {
        invokeRoutedProvider,
      },
      {
        mode: 'stage-rerun',
        rerun: {
          targetStageId: 'executor',
          checkpoint: firstResponse.checkpoint,
        },
      },
    );

    expect(firstResponse.selectedProvider.modelId).toBe('claude-3-5-sonnet-latest');
    expect(rerunResponse.selectedProvider.modelId).toBe('claude-3-5-sonnet-latest');
    expect(invokeRoutedProvider.mock.calls[0]?.[1]).toBe('claude-3-5-sonnet-latest');
    expect(invokeRoutedProvider.mock.calls[1]?.[1]).toBe('claude-3-5-sonnet-latest');
    expect(rerunResponse.runInfo.mode).toBe('stage-rerun');
    expect(rerunResponse.runInfo.targetStageId).toBe('executor');
    expect(rerunResponse.runInfo.reusedCheckpointStages).toEqual(['structurizer', 'router']);
    expect(rerunResponse.trace.filter((event) => event.stage === 'policy.override')).toHaveLength(2);
  });

  it('falls back to conservative planner output when planner stage crashes', async () => {
    const providerRegistry = {
      invoke: vi.fn().mockResolvedValue({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
        outputText: 'complex result with planner fallback',
        latencyMs: 240,
      }),
    };

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
        qualityBar: 'high',
        constraints: ['Keep public API stable'],
        contexts: [
          {
            source: 'workspace',
            uri: '/workspace',
            content: 'workspace snapshot',
          },
        ],
      },
      {
        planTask: () => {
          throw new Error('planner exploded');
        },
      },
    );

    expect(response.providerResult.status).toBe('completed');
    expect(response.plannerResult?.status).toBe('fallback');
    expect(response.plannerResult?.fallbackReason).toContain('Planner stage crashed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'planner')?.state).toBe('completed');
    expect(response.trace.some((event) => event.stage === 'planner.finish' && event.status === 'failed')).toBe(true);
  });

  it('falls back to conservative reasoner output when reasoner stage crashes', async () => {
    const providerRegistry = {
      invoke: vi.fn().mockResolvedValue({
        providerId: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
        outputText: 'complex result with reasoner fallback',
        latencyMs: 250,
      }),
    };

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
        qualityBar: 'high',
        constraints: ['Keep public API stable'],
        contexts: [
          {
            source: 'workspace',
            uri: '/workspace',
            content: 'workspace snapshot',
          },
        ],
      },
      {
        reasonTask: () => {
          throw new Error('reasoner exploded');
        },
      },
    );

    expect(response.providerResult.status).toBe('completed');
    expect(response.reasonerResult?.status).toBe('fallback');
    expect(response.reasonerResult?.fallbackReason).toContain('Reasoner stage crashed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'reasoner')?.state).toBe('completed');
    expect(response.trace.some((event) => event.stage === 'reasoner.finish' && event.status === 'failed')).toBe(true);
  });

  it('reruns complex pipeline from planner checkpoint and keeps prior trace history', async () => {
    const providerRegistry = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          outputText: 'first complex result',
          latencyMs: 210,
        })
        .mockResolvedValueOnce({
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet-latest',
          outputText: 'planner rerun result',
          latencyMs: 190,
        }),
    };

    const taskRequest: TaskRequest = {
      task: 'Analyze whole workspace for architecture risk and propose robust fixes.',
      qualityBar: 'high',
      constraints: ['Keep public API stable'],
      contexts: [
        {
          source: 'workspace',
          uri: '/workspace',
          content: 'workspace snapshot',
        },
      ],
    };

    const firstResponse = await runTaskPipeline(runtimeConfig, providerRegistry as never, taskRequest);
    const rerunResponse = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      firstResponse.checkpoint.taskRequest,
      {},
      {
        mode: 'stage-rerun',
        rerun: {
          targetStageId: 'planner',
          checkpoint: firstResponse.checkpoint,
        },
      },
    );

    expect(rerunResponse.output).toBe('planner rerun result');
    expect(rerunResponse.runInfo.mode).toBe('stage-rerun');
    expect(rerunResponse.runInfo.targetStageId).toBe('planner');
    expect(rerunResponse.runInfo.reusedCheckpointStages).toEqual(['structurizer', 'router']);
    expect(rerunResponse.runInfo.historyTraceCount).toBe(firstResponse.trace.length);
    expect(rerunResponse.pipeline.stages.find((stage) => stage.stageId === 'structurizer')?.state).toBe('skipped');
    expect(rerunResponse.pipeline.stages.find((stage) => stage.stageId === 'router')?.state).toBe('skipped');
    expect(rerunResponse.pipeline.stages.find((stage) => stage.stageId === 'planner')?.state).toBe('completed');
    expect(rerunResponse.trace.some((event) => event.stage === 'rerun.resume' && event.status === 'completed')).toBe(true);
    expect(rerunResponse.trace.length).toBeGreaterThan(firstResponse.trace.length);
  });

  it('rejects unsupported planner rerun target for simple checkpoint', async () => {
    const providerRegistry = createProviderRegistryStub('simple result');
    const firstResponse = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    await expect(
      runTaskPipeline(
        runtimeConfig,
        providerRegistry as never,
        firstResponse.checkpoint.taskRequest,
        {},
        {
          mode: 'stage-rerun',
          rerun: {
            targetStageId: 'planner',
            checkpoint: firstResponse.checkpoint,
          },
        },
      ),
    ).rejects.toThrow('unsupported for simple pipeline checkpoint');
  });

  it('returns unified failed task response when executor stage crashes', async () => {
    const providerRegistry = createProviderRegistryStub('unused');

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to remove duplication.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
      {
        buildProviderUserPrompt: () => {
          throw new Error('prompt exploded');
        },
      },
    );

    expect(response.providerResult.status).toBe('failed');
    expect(response.costEstimate.status).toBe('unknown');
    expect(response.diagnostic?.category).toBe('internal');
    expect(response.diagnostic?.code).toBe('internal.executor_prompt_crash');
    expect(response.output).toContain('Task execution failed');
    expect(response.pipeline.state).toBe('failed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'executor')?.state).toBe('failed');
    expect(response.pipeline.stages.find((stage) => stage.stageId === 'response')?.state).toBe('completed');
    expect(response.trace.some((event) => event.stage === 'executor.prompt' && event.status === 'failed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'skipped')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'pipeline.finish' && event.status === 'failed')).toBe(true);
  });

  it('records retrying trace state for retriable provider failure', async () => {
    const providerRegistry = createProviderRegistryStub('unused');

    const response = await runTaskPipeline(
      runtimeConfig,
      providerRegistry as never,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
      {
        invokeRoutedProvider: async () => ({
          status: 'failed',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          outputText: '',
          error: {
            providerId: 'openai',
            code: 'rate_limit',
            message: 'Rate limit exceeded',
            retriable: true,
            statusCode: 429,
          },
        }),
      },
    );

    const retryEvent = response.trace.find((event) => event.stage === 'executor.retry');

    expect(retryEvent?.status).toBe('retrying');
    expect(retryEvent?.error?.code).toBe('rate_limit');
    expect(retryEvent?.metadata.retriable).toBe(true);
    expect(response.diagnostic?.category).toBe('provider');
    expect(response.diagnostic?.code).toBe('provider.rate_limit');
    expect(response.costEstimate.status).toBe('unknown');
  });

  it('runs simple path end to end through ollama runtime profile', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        model: 'qwen2.5-coder:7b',
        response: 'ollama pipeline result',
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 120,
        eval_count: 40,
      }),
    );

    const ollamaRuntimeConfig: RuntimeConfig = {
      defaultSimpleModel: 'qwen2.5-coder:7b',
      defaultComplexModel: 'qwen2.5-coder:7b',
      transport: 'stdio',
      logLevel: 'info',
      providerKeys: {},
      runtimeProfiles: [
        {
          runtimeId: 'ollama-local',
          providerId: 'ollama',
          deploymentMode: 'local',
          apiFamily: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['qwen2.5-coder:7b'],
          authMode: 'none',
          timeoutMs: 30000,
        },
      ],
    };

    const providerRegistry = createProviderRegistry(
      {
        runtimeProfiles: ollamaRuntimeConfig.runtimeProfiles,
      },
      { fetch: fetchMock },
    );

    const response = await runTaskPipeline(
      ollamaRuntimeConfig,
      providerRegistry,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    expect(response.selectedProvider.providerId).toBe('ollama');
    expect(response.selectedProvider.runtimeId).toBe('ollama-local');
    expect(response.selectedProvider.deploymentMode).toBe('local');
    expect(response.selectedProvider.apiFamily).toBe('ollama');
    expect(response.selectedProvider.modelId).toBe('qwen2.5-coder:7b');
    expect(response.providerResult.status).toBe('completed');
    expect(response.output).toBe('ollama pipeline result');
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'executor.start' && event.metadata.runtimeId === 'ollama-local')).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/generate');
  });

  it('runs simple path end to end through openai-compatible local runtime profile', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        choices: [
          {
            message: {
              content: 'lmstudio pipeline result',
            },
          },
        ],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 20,
          total_tokens: 100,
        },
      }),
    );

    const localRuntimeConfig: RuntimeConfig = {
      defaultSimpleModel: 'gpt-4o-mini',
      defaultComplexModel: 'gpt-4o-mini',
      transport: 'stdio',
      logLevel: 'info',
      providerKeys: {},
      runtimeProfiles: [
        {
          runtimeId: 'lmstudio-local',
          providerId: 'openai',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234/v1',
          models: ['gpt-4o-mini'],
          authMode: 'header',
          authToken: 'lmstudio-secret',
          authHeaderName: 'X-LM-Studio-Key',
          headers: {
            'X-Client': 'llm-crane',
          },
          timeoutMs: 45000,
        },
      ],
    };

    const providerRegistry = createProviderRegistry(
      {
        runtimeProfiles: localRuntimeConfig.runtimeProfiles,
      },
      { fetch: fetchMock },
    );

    const response = await runTaskPipeline(
      localRuntimeConfig,
      providerRegistry,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    expect(response.selectedProvider.providerId).toBe('openai');
    expect(response.selectedProvider.runtimeId).toBe('lmstudio-local');
    expect(response.selectedProvider.deploymentMode).toBe('local');
    expect(response.selectedProvider.apiFamily).toBe('openai-compatible');
    expect(response.selectedProvider.modelId).toBe('gpt-4o-mini');
    expect(response.providerResult.status).toBe('completed');
    expect(response.output).toBe('lmstudio pipeline result');
    expect(response.costEstimate.status).toBe('unknown');
    expect(response.costEstimate.detail).toContain('Local runtime lmstudio-local pricing unavailable');
    expect(response.trace.some((event) => event.stage === 'executor.invoke' && event.status === 'completed')).toBe(true);
    expect(response.trace.some((event) => event.stage === 'response.cost' && event.metadata.deploymentMode === 'local')).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1].headers?.['X-LM-Studio-Key']).toBe('lmstudio-secret');
  });

  it('returns unified provider diagnostic when ollama model is missing', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(404, {
        error: "model 'missing-model' not found, try pulling it first",
      }),
    );

    const ollamaRuntimeConfig: RuntimeConfig = {
      defaultSimpleModel: 'missing-model',
      defaultComplexModel: 'missing-model',
      transport: 'stdio',
      logLevel: 'info',
      providerKeys: {},
      runtimeProfiles: [
        {
          runtimeId: 'ollama-local',
          providerId: 'ollama',
          deploymentMode: 'local',
          apiFamily: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['missing-model'],
          authMode: 'none',
        },
      ],
    };

    const providerRegistry = createProviderRegistry(
      {
        runtimeProfiles: ollamaRuntimeConfig.runtimeProfiles,
      },
      { fetch: fetchMock },
    );

    const response = await runTaskPipeline(
      ollamaRuntimeConfig,
      providerRegistry,
      {
        task: 'Refactor current selection to reduce duplication without changing public API.',
        qualityBar: 'fast',
        constraints: [],
        contexts: [
          {
            source: 'selection',
            uri: '/workspace/src/auth.ts',
            languageId: 'typescript',
            content: 'function loginUser() { return doLogin(); }',
          },
        ],
      },
    );

    expect(response.providerResult.status).toBe('failed');
    expect(response.diagnostic?.category).toBe('provider');
    expect(response.diagnostic?.code).toBe('provider.unsupported_model');
    expect(response.diagnostic?.runtimeId).toBe('ollama-local');
    expect(response.diagnostic?.deploymentMode).toBe('local');
    expect(response.selectedProvider.providerId).toBe('ollama');
  });
});