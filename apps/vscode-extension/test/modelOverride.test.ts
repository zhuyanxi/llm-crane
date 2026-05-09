import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@llm-crane/schemas';
import { buildModelPolicyOverrides, createModelOverrideCatalog, describeTaskModelOverride } from '../src/modelOverride';

const runtimeConfig: RuntimeConfig = {
  defaultSimpleModel: 'gpt-4o-mini',
  defaultComplexModel: 'claude-3-5-sonnet-latest',
  transport: 'stdio',
  logLevel: 'info',
  providerKeys: {
    openai: 'sk-openai',
    anthropic: 'sk-anthropic',
  },
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

describe('createModelOverrideCatalog', () => {
  it('lists configured hosted and local models with default markers', () => {
    const catalog = createModelOverrideCatalog(runtimeConfig);

    expect(catalog.available).toBe(true);
    expect(catalog.options.some((option) => option.modelId === 'gpt-4o-mini' && option.isDefaultSimple)).toBe(true);
    expect(catalog.options.some((option) => option.modelId === 'claude-3-5-sonnet-latest' && option.isDefaultComplex)).toBe(true);
    expect(catalog.options.some((option) => option.modelId === 'qwen2.5-coder:7b' && option.runtimeId === 'ollama-local')).toBe(true);
  });
});

describe('buildModelPolicyOverrides', () => {
  it('builds specific model override for configured model only', () => {
    const catalog = createModelOverrideCatalog(runtimeConfig);

    expect(buildModelPolicyOverrides('specific', 'qwen2.5-coder:7b', catalog)).toEqual({
      modelOverride: {
        mode: 'specific',
        modelId: 'qwen2.5-coder:7b',
      },
    });

    expect(() => buildModelPolicyOverrides('specific', 'unknown-model', catalog)).toThrow('Model override must use configured model');
  });

  it('describes manual override with selected model detail', () => {
    const description = describeTaskModelOverride(
      {
        modelOverride: {
          mode: 'complex-default',
        },
      },
      'claude-3-5-sonnet-latest',
    );

    expect(description.summary).toBe('Manual override');
    expect(description.detail).toContain('complex default model claude-3-5-sonnet-latest');
  });

  it('includes user policy restrictions in override description', () => {
    const description = describeTaskModelOverride({
      fallbackEnabled: false,
      verificationUpgradeAllowed: false,
    });

    expect(description.detail).toContain('Automatic fallback disabled by user policy.');
    expect(description.detail).toContain('Verification upgrade disabled by user policy.');
  });
});