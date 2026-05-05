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

  it('loads config when local runtime profile provides configured models', () => {
    const config = loadRuntimeConfig({
      LLM_CRANE_SIMPLE_MODEL: 'local-qwen2.5-coder',
      LLM_CRANE_COMPLEX_MODEL: 'local-llama3.1-instruct',
      LLM_CRANE_RUNTIME_PROFILES: JSON.stringify([
        {
          runtimeId: 'lmstudio-local',
          providerId: 'openai',
          deploymentMode: 'local',
          apiFamily: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234/v1',
          models: ['local-qwen2.5-coder', 'local-llama3.1-instruct'],
          authMode: 'none',
        },
      ]),
    });

    expect(config.defaultSimpleModel).toBe('local-qwen2.5-coder');
    expect(config.runtimeProfiles).toHaveLength(1);
    expect(config.runtimeProfiles[0]?.runtimeId).toBe('lmstudio-local');
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