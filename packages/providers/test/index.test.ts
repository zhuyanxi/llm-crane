import { describe, expect, it, vi } from 'vitest';
import {
  ProviderInvocationError,
  createProviderRegistry,
  estimateModelCost,
  estimateTextTokens,
  getProviderIdForModel,
  getModelPricing,
  getSupportedModelIds,
  isSupportedModelId,
  type FetchLike,
} from '../src';

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

describe('model catalog', () => {
  it('returns provider ids for supported models', () => {
    expect(getProviderIdForModel('gpt-4o-mini')).toBe('openai');
    expect(getProviderIdForModel('claude-3-5-sonnet-latest')).toBe('anthropic');
    expect(getProviderIdForModel('deepseek-chat')).toBe('deepseek');
    expect(getProviderIdForModel('gemini-1.5-flash')).toBe('gemini');
    expect(isSupportedModelId('unknown-model')).toBe(false);
    expect(getSupportedModelIds()).toContain('gpt-4.1');
  });
});

describe('pricing', () => {
  it('returns pricing for supported model ids', () => {
    expect(getModelPricing('gpt-4o-mini')).toEqual(
      expect.objectContaining({
        modelId: 'gpt-4o-mini',
        providerId: 'openai',
        pricingSource: 'catalog',
      }),
    );
    expect(getModelPricing('unknown-model')).toBeUndefined();
    expect(estimateTextTokens('abcd')).toBe(1);
  });

  it('uses provider token usage for exact cost estimate', () => {
    const estimate = estimateModelCost({
      modelId: 'gpt-4o-mini',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
      },
      latencyMs: 350,
      executionStatus: 'completed',
    });

    expect(estimate.status).toBe('exact');
    expect(estimate.usageSource).toBe('provider');
    expect(estimate.totalCostUsd).toBeCloseTo(0.00045, 6);
    expect(estimate.latencyMs).toBe(350);
  });

  it('falls back to estimated usage when provider token usage missing', () => {
    const estimate = estimateModelCost({
      modelId: 'claude-3-5-sonnet-latest',
      promptText: 'A'.repeat(800),
      outputText: 'B'.repeat(400),
      executionStatus: 'completed',
    });

    expect(estimate.status).toBe('estimated');
    expect(estimate.usageSource).toBe('estimated');
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBeGreaterThan(0);
    expect(estimate.totalCostUsd).toBeGreaterThan(0);
  });

  it('returns unknown when pricing or usage unavailable', () => {
    const failedEstimate = estimateModelCost({
      modelId: 'gpt-4o-mini',
      executionStatus: 'failed',
    });
    const unknownPricing = estimateModelCost({
      modelId: 'unknown-model',
      promptText: 'hello',
      outputText: 'world',
      executionStatus: 'completed',
    });

    expect(failedEstimate.status).toBe('unknown');
    expect(unknownPricing.status).toBe('unknown');
  });
});

describe('ProviderRegistry', () => {
  it('routes OpenAI-compatible model through OpenAI adapter', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        choices: [
          {
            message: {
              content: 'openai result',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      }),
    );

    const registry = createProviderRegistry({ openai: 'sk-openai' }, { fetch: fetchMock });
    const result = await registry.invoke({
      modelId: 'gpt-4o-mini',
      prompt: 'Fix bug',
      systemPrompt: 'System prompt',
      maxOutputTokens: 256,
    });

    expect(result.providerId).toBe('openai');
    expect(result.outputText).toBe('openai result');
    expect(result.usage?.totalTokens).toBe(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1].headers?.Authorization).toBe('Bearer sk-openai');
  });

  it('routes Anthropic model through Anthropic adapter', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        content: [
          {
            type: 'text',
            text: 'anthropic result',
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 14,
        },
      }),
    );

    const registry = createProviderRegistry({ anthropic: 'sk-anthropic' }, { fetch: fetchMock });
    const result = await registry.invoke({
      modelId: 'claude-3-5-sonnet-latest',
      prompt: 'Analyze code',
      systemPrompt: 'Be careful',
    });

    expect(result.providerId).toBe('anthropic');
    expect(result.outputText).toBe('anthropic result');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchMock.mock.calls[0]?.[1].headers?.['x-api-key']).toBe('sk-anthropic');
  });

  it('supports OpenAI-compatible DeepSeek adapter without new contract', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        choices: [
          {
            message: {
              content: 'deepseek result',
            },
          },
        ],
      }),
    );

    const registry = createProviderRegistry({ deepseek: 'sk-deepseek' }, { fetch: fetchMock });
    const result = await registry.invoke({
      modelId: 'deepseek-chat',
      prompt: 'Review file',
    });

    expect(result.providerId).toBe('deepseek');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('supports Gemini adapter behind same registry interface', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: 'gemini result' }],
            },
            finish_reason: 'STOP',
          },
        ],
      }),
    );

    const registry = createProviderRegistry({ gemini: 'sk-gemini' }, { fetch: fetchMock });
    const result = await registry.invoke({
      modelId: 'gemini-1.5-flash',
      prompt: 'Summarize file',
      systemPrompt: 'Keep concise',
    });

    expect(result.providerId).toBe('gemini');
    expect(result.outputText).toBe('gemini result');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/models/gemini-1.5-flash:generateContent?key=sk-gemini');
  });

  it('maps provider HTTP errors to unified ProviderInvocationError', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      createJsonResponse(429, {
        error: {
          message: 'Rate limit exceeded',
        },
      }),
    );

    const registry = createProviderRegistry({ openai: 'sk-openai' }, { fetch: fetchMock });

    await expect(
      registry.invoke({
        modelId: 'gpt-4o-mini',
        prompt: 'Fix bug',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderInvocationError>>({
        name: 'ProviderInvocationError',
        providerId: 'openai',
        code: 'rate_limit',
        retriable: true,
        statusCode: 429,
      }),
    );
  });

  it('supports hosted and local openai-compatible runtimes at same time', async () => {
    const fetchMock = vi.fn<FetchLike>()
      .mockResolvedValueOnce(
        createJsonResponse(200, {
          choices: [
            {
              message: {
                content: 'hosted result',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(200, {
          choices: [
            {
              message: {
                content: 'local result',
              },
            },
          ],
        }),
      );

    const registry = createProviderRegistry(
      {
        apiKeys: { openai: 'sk-openai' },
        runtimeProfiles: [
          {
            runtimeId: 'lmstudio-local',
            providerId: 'openai',
            deploymentMode: 'local',
            apiFamily: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234/v1',
            models: ['local-qwen2.5-coder'],
            authMode: 'none',
          },
        ],
      },
      { fetch: fetchMock },
    );

    const hostedResult = await registry.invoke({
      modelId: 'gpt-4o-mini',
      prompt: 'Use hosted runtime',
    });
    const localResult = await registry.invoke({
      modelId: 'local-qwen2.5-coder',
      prompt: 'Use local runtime',
    });

    expect(hostedResult.outputText).toBe('hosted result');
    expect(localResult.outputText).toBe('local result');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1].headers?.Authorization).toBe('Bearer sk-openai');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(fetchMock.mock.calls[1]?.[1].headers?.Authorization).toBeUndefined();
    expect(registry.describeModel('local-qwen2.5-coder')).toEqual(
      expect.objectContaining({
        runtimeId: 'lmstudio-local',
        providerId: 'openai',
        deploymentMode: 'local',
      }),
    );
  });
});