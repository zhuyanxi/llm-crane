import { loadRuntimeConfig } from '@llm-crane/core';
import { getModelDescriptor, getSupportedModelIdsForProvider } from '@llm-crane/providers';
import type { RuntimeConfig, TaskPolicyOverrides } from '@llm-crane/schemas';

export type ModelOverrideMode = 'auto' | 'simple-default' | 'complex-default' | 'specific';

export type ModelOverrideOptionView = {
  modelId: string;
  providerId: string;
  runtimeId?: string;
  deploymentMode: 'hosted' | 'local';
  apiFamily: string;
  capabilityTier?: string;
  isDefaultSimple: boolean;
  isDefaultComplex: boolean;
  label: string;
  detail: string;
};

export type ModelOverrideCatalog = {
  available: boolean;
  error?: string;
  defaultSimpleModel: string;
  defaultComplexModel: string;
  options: ModelOverrideOptionView[];
};

export function createModelOverrideCatalog(config: RuntimeConfig): ModelOverrideCatalog {
  const optionsByModel = new Map<string, ModelOverrideOptionView>();

  const registerOption = (option: Omit<ModelOverrideOptionView, 'label' | 'detail' | 'isDefaultSimple' | 'isDefaultComplex'>) => {
    const isDefaultSimple = option.modelId === config.defaultSimpleModel;
    const isDefaultComplex = option.modelId === config.defaultComplexModel;
    const detailParts = [
      option.deploymentMode,
      option.runtimeId ? `runtime=${option.runtimeId}` : undefined,
      option.capabilityTier ? `tier=${option.capabilityTier}` : undefined,
      `provider=${option.providerId}`,
    ].filter(Boolean);

    optionsByModel.set(option.modelId, {
      ...option,
      isDefaultSimple,
      isDefaultComplex,
      label: [option.modelId, option.runtimeId].filter(Boolean).join(' · '),
      detail: detailParts.join(' · '),
    });
  };

  for (const profile of config.runtimeProfiles) {
    for (const modelId of profile.models) {
      registerOption({
        modelId,
        providerId: profile.providerId,
        runtimeId: profile.runtimeId,
        deploymentMode: profile.deploymentMode,
        apiFamily: profile.apiFamily,
        capabilityTier: getModelDescriptor(modelId)?.capabilityTier,
      });
    }
  }

  for (const [providerId, apiKey] of Object.entries(config.providerKeys)) {
    if (!apiKey) {
      continue;
    }

    for (const modelId of getSupportedModelIdsForProvider(providerId as keyof RuntimeConfig['providerKeys'])) {
      registerOption({
        modelId,
        providerId,
        runtimeId: providerId,
        deploymentMode: 'hosted',
        apiFamily: getModelDescriptor(modelId)?.apiFamily ?? 'openai-compatible',
        capabilityTier: getModelDescriptor(modelId)?.capabilityTier,
      });
    }
  }

  const options = [...optionsByModel.values()].sort((left, right) => {
    const leftRank = Number(left.isDefaultSimple || left.isDefaultComplex);
    const rightRank = Number(right.isDefaultSimple || right.isDefaultComplex);
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }

    return left.modelId.localeCompare(right.modelId);
  });

  return {
    available: true,
    defaultSimpleModel: config.defaultSimpleModel,
    defaultComplexModel: config.defaultComplexModel,
    options,
  };
}

export function loadModelOverrideCatalog(env: Record<string, string | undefined> = process.env): ModelOverrideCatalog {
  try {
    return createModelOverrideCatalog(loadRuntimeConfig(env));
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      defaultSimpleModel: env.LLM_CRANE_SIMPLE_MODEL ?? 'gpt-4o-mini',
      defaultComplexModel: env.LLM_CRANE_COMPLEX_MODEL ?? 'claude-3-5-sonnet-latest',
      options: [],
    };
  }
}

export function buildModelPolicyOverrides(
  mode: ModelOverrideMode,
  specificModelId: string,
  catalog: ModelOverrideCatalog,
): TaskPolicyOverrides | undefined {
  switch (mode) {
    case 'auto':
      return undefined;
    case 'simple-default':
      ensureCatalogAvailable(catalog);
      return {
        modelOverride: {
          mode: 'simple-default',
        },
      };
    case 'complex-default':
      ensureCatalogAvailable(catalog);
      return {
        modelOverride: {
          mode: 'complex-default',
        },
      };
    case 'specific': {
      ensureCatalogAvailable(catalog);
      const normalizedModelId = specificModelId.trim();
      if (!normalizedModelId) {
        throw new Error('Choose configured model before submitting specific model override.');
      }

      if (!catalog.options.some((option) => option.modelId === normalizedModelId)) {
        throw new Error(`Model override must use configured model. Unknown model: ${normalizedModelId}.`);
      }

      return {
        modelOverride: {
          mode: 'specific',
          modelId: normalizedModelId,
        },
      };
    }
  }
}

export function describeTaskModelOverride(
  policyOverrides: TaskPolicyOverrides | undefined,
  selectedModelId?: string,
): { summary: string; detail: string } {
  const restrictionDetails = describePolicyRestrictions(policyOverrides);
  const override = policyOverrides?.modelOverride;
  if (!override) {
    return {
      summary: 'Automatic routing',
      detail: ['Model followed automatic route selection.', ...restrictionDetails].join(' '),
    };
  }

  switch (override.mode) {
    case 'simple-default':
      return {
        summary: 'Manual override',
        detail: [
          selectedModelId
            ? `Pinned execution to simple default model ${selectedModelId}.`
            : 'Pinned execution to configured simple default model.',
          ...restrictionDetails,
        ].join(' '),
      };
    case 'complex-default':
      return {
        summary: 'Manual override',
        detail: [
          selectedModelId
            ? `Pinned execution to complex default model ${selectedModelId}.`
            : 'Pinned execution to configured complex default model.',
          ...restrictionDetails,
        ].join(' '),
      };
    case 'specific':
      return {
        summary: 'Manual override',
        detail: [`Pinned execution to specific model ${override.modelId}.`, ...restrictionDetails].join(' '),
      };
  }
}

function describePolicyRestrictions(policyOverrides: TaskPolicyOverrides | undefined): string[] {
  const details: string[] = [];

  if (policyOverrides?.fallbackEnabled === false) {
    details.push('Automatic fallback disabled by user policy.');
  }

  if (policyOverrides?.verificationUpgradeAllowed === false) {
    details.push('Verification upgrade disabled by user policy.');
  }

  return details;
}

function ensureCatalogAvailable(catalog: ModelOverrideCatalog): void {
  if (catalog.available) {
    return;
  }

  throw new Error(`Model override unavailable: ${catalog.error ?? 'Runtime configuration could not be loaded.'}`);
}