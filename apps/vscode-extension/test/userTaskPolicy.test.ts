import { describe, expect, it } from 'vitest';
import type { ModelOverrideCatalog } from '../src/modelOverride';
import {
  DEFAULT_USER_TASK_POLICY_SETTINGS,
  describeUserTaskPolicySettings,
  parseUserTaskPolicySettings,
  resolveUserTaskPolicyOverrides,
} from '../src/userTaskPolicy';

const modelOverrideCatalog: ModelOverrideCatalog = {
  available: true,
  defaultSimpleModel: 'gpt-4o-mini',
  defaultComplexModel: 'claude-3-5-sonnet-latest',
  options: [
    {
      modelId: 'gpt-4o-mini',
      providerId: 'openai',
      runtimeId: 'openai',
      deploymentMode: 'hosted',
      apiFamily: 'openai-compatible',
      capabilityTier: 'fast',
      isDefaultSimple: true,
      isDefaultComplex: false,
      label: 'gpt-4o-mini · openai',
      detail: 'hosted · provider=openai',
    },
    {
      modelId: 'claude-3-5-sonnet-latest',
      providerId: 'anthropic',
      runtimeId: 'anthropic',
      deploymentMode: 'hosted',
      apiFamily: 'anthropic',
      capabilityTier: 'high',
      isDefaultSimple: false,
      isDefaultComplex: true,
      label: 'claude-3-5-sonnet-latest · anthropic',
      detail: 'hosted · provider=anthropic',
    },
  ],
};

describe('parseUserTaskPolicySettings', () => {
  it('parses specific user default when configured model exists', () => {
    const parsed = parseUserTaskPolicySettings(
      {
        defaultModelStrategy: 'specific',
        defaultSpecificModelId: 'claude-3-5-sonnet-latest',
        allowAutomaticFallback: false,
        allowVerificationUpgrade: false,
      },
      modelOverrideCatalog,
    );

    expect(parsed.defaultModelStrategy).toBe('specific');
    expect(parsed.defaultSpecificModelId).toBe('claude-3-5-sonnet-latest');
    expect(parsed.allowAutomaticFallback).toBe(false);
    expect(parsed.allowVerificationUpgrade).toBe(false);
  });

  it('throws when specific default model id is missing', () => {
    expect(() =>
      parseUserTaskPolicySettings(
        {
          defaultModelStrategy: 'specific',
        },
        modelOverrideCatalog,
      ),
    ).toThrow('defaultSpecificModelId');
  });
});

describe('resolveUserTaskPolicyOverrides', () => {
  it('applies configured user default when submit stays on user default mode', () => {
    const overrides = resolveUserTaskPolicyOverrides(
      'auto',
      '',
      modelOverrideCatalog,
      {
        defaultModelStrategy: 'complex-default',
        allowAutomaticFallback: false,
        allowVerificationUpgrade: true,
      },
    );

    expect(overrides).toEqual({
      modelOverride: {
        mode: 'complex-default',
      },
      fallbackEnabled: false,
      verificationUpgradeAllowed: true,
    });
  });

  it('returns undefined for fully default policy', () => {
    expect(
      resolveUserTaskPolicyOverrides('auto', '', modelOverrideCatalog, DEFAULT_USER_TASK_POLICY_SETTINGS),
    ).toBeUndefined();
  });
});

describe('describeUserTaskPolicySettings', () => {
  it('describes current policy settings', () => {
    const description = describeUserTaskPolicySettings({
      defaultModelStrategy: 'simple-default',
      allowAutomaticFallback: false,
      allowVerificationUpgrade: true,
    });

    expect(description.summary).toContain('Simple default model');
    expect(description.detail).toContain('fallback disabled');
  });
});