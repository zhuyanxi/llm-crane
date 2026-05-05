import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadRuntimeConfig } from '../src/index';

describe('loadRuntimeConfig', () => {
  it('loads config when provider keys match models', () => {
    const config = loadRuntimeConfig({
      OPENAI_API_KEY: 'openai-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
    });

    expect(config.defaultSimpleModel).toBe('gpt-4o-mini');
    expect(config.defaultComplexModel).toBe('claude-3-5-sonnet-latest');
    expect(config.runtimeProfiles).toEqual([]);
  });

  it('throws when provider keys are missing', () => {
    expect(() => loadRuntimeConfig({})).toThrow(ConfigurationError);
  });

  it('loads config when ollama runtime profile provides configured models', () => {
    const config = loadRuntimeConfig({
      LLM_CRANE_SIMPLE_MODEL: 'qwen2.5-coder:7b',
      LLM_CRANE_COMPLEX_MODEL: 'llama3.1:8b-instruct-q4_K_M',
      LLM_CRANE_RUNTIME_PROFILES: JSON.stringify([
        {
          runtimeId: 'ollama-local',
          providerId: 'ollama',
          deploymentMode: 'local',
          apiFamily: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['qwen2.5-coder:7b', 'llama3.1:8b-instruct-q4_K_M'],
          authMode: 'none',
          timeoutMs: 30000,
        },
      ]),
    });

    expect(config.defaultSimpleModel).toBe('qwen2.5-coder:7b');
    expect(config.runtimeProfiles).toHaveLength(1);
    expect(config.runtimeProfiles[0]?.runtimeId).toBe('ollama-local');
    expect(config.runtimeProfiles[0]?.providerId).toBe('ollama');
    expect(config.runtimeProfiles[0]?.apiFamily).toBe('ollama');
  });

  it('throws when runtime profile conflicts with hosted model ownership', () => {
    expect(() =>
      loadRuntimeConfig({
        OPENAI_API_KEY: 'openai-key',
        ANTHROPIC_API_KEY: 'anthropic-key',
        LLM_CRANE_RUNTIME_PROFILES: JSON.stringify([
          {
            runtimeId: 'lmstudio-local',
            providerId: 'openai',
            deploymentMode: 'local',
            apiFamily: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234/v1',
            models: ['gpt-4o-mini'],
            authMode: 'none',
          },
        ]),
      }),
    ).toThrow('Model gpt-4o-mini is configured by multiple runtimes');
  });

  it('throws on invalid model id', () => {
    expect(() =>
      loadRuntimeConfig({
        OPENAI_API_KEY: 'openai-key',
        LLM_CRANE_SIMPLE_MODEL: 'unknown-model',
        LLM_CRANE_COMPLEX_MODEL: 'gpt-4.1',
      }),
    ).toThrow('Invalid simple model name: unknown-model');
  });
});