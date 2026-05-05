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
  });

  it('throws when provider keys are missing', () => {
    expect(() => loadRuntimeConfig({})).toThrow(ConfigurationError);
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