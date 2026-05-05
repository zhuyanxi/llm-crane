import { describe, expect, it, vi } from 'vitest';
import {
  ProviderInvocationError,
  createProviderRegistry,
  getProviderIdForModel,
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
});