import {
  UserTaskPolicySettingsSchema,
  type TaskPolicyOverrides,
  type UserTaskPolicySettings,
} from '@llm-crane/schemas';
import { buildModelPolicyOverrides, type ModelOverrideCatalog, type ModelOverrideMode } from './modelOverride';

export const DEFAULT_USER_TASK_POLICY_SETTINGS: UserTaskPolicySettings = {
  defaultModelStrategy: 'auto',
  allowAutomaticFallback: true,
  allowVerificationUpgrade: true,
};

export type UserTaskPolicySettingsSource = {
  defaultModelStrategy?: unknown;
  defaultSpecificModelId?: unknown;
  allowAutomaticFallback?: unknown;
  allowVerificationUpgrade?: unknown;
};

export function parseUserTaskPolicySettings(
  source: UserTaskPolicySettingsSource,
  catalog: ModelOverrideCatalog,
): UserTaskPolicySettings {
  try {
    const parsed = UserTaskPolicySettingsSchema.parse({
      defaultModelStrategy: source.defaultModelStrategy ?? DEFAULT_USER_TASK_POLICY_SETTINGS.defaultModelStrategy,
      defaultSpecificModelId:
        typeof source.defaultSpecificModelId === 'string' ? source.defaultSpecificModelId.trim() || undefined : source.defaultSpecificModelId,
      allowAutomaticFallback: source.allowAutomaticFallback ?? DEFAULT_USER_TASK_POLICY_SETTINGS.allowAutomaticFallback,
      allowVerificationUpgrade: source.allowVerificationUpgrade ?? DEFAULT_USER_TASK_POLICY_SETTINGS.allowVerificationUpgrade,
    });

    if (parsed.defaultModelStrategy !== 'specific') {
      return parsed;
    }

    if (!parsed.defaultSpecificModelId) {
      throw new Error('Set llmCrane.defaultSpecificModelId when default model strategy is "specific".');
    }

    if (!catalog.available) {
      throw new Error(`Specific default model unavailable: ${catalog.error ?? 'Runtime configuration could not be loaded.'}`);
    }

    if (!catalog.options.some((option) => option.modelId === parsed.defaultSpecificModelId)) {
      throw new Error(`User default specific model must use configured model. Unknown model: ${parsed.defaultSpecificModelId}.`);
    }

    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid llmCrane user policy configuration. ${message}`);
  }
}

export function resolveUserTaskPolicyOverrides(
  submittedModelOverrideMode: ModelOverrideMode,
  submittedSpecificModelId: string,
  catalog: ModelOverrideCatalog,
  settings: UserTaskPolicySettings,
): TaskPolicyOverrides | undefined {
  const effectiveMode = submittedModelOverrideMode === 'auto'
    ? settings.defaultModelStrategy
    : submittedModelOverrideMode;
  const effectiveSpecificModelId = submittedModelOverrideMode === 'auto' && settings.defaultModelStrategy === 'specific'
    ? settings.defaultSpecificModelId ?? ''
    : submittedSpecificModelId;
  const modelOverridePolicy = buildModelPolicyOverrides(effectiveMode as ModelOverrideMode, effectiveSpecificModelId, catalog);

  const policyOverrides: TaskPolicyOverrides = {
    ...modelOverridePolicy,
    fallbackEnabled: settings.allowAutomaticFallback,
    verificationUpgradeAllowed: settings.allowVerificationUpgrade,
  };

  if (
    !policyOverrides.modelOverride
    && policyOverrides.fallbackEnabled !== false
    && policyOverrides.verificationUpgradeAllowed !== false
  ) {
    return undefined;
  }

  return policyOverrides;
}

export function describeUserTaskPolicySettings(settings: UserTaskPolicySettings): { summary: string; detail: string } {
  const defaultModelStrategy = settings.defaultModelStrategy === 'specific'
    ? `Specific model ${settings.defaultSpecificModelId}`
    : settings.defaultModelStrategy === 'simple-default'
      ? 'Simple default model'
      : settings.defaultModelStrategy === 'complex-default'
        ? 'Complex default model'
        : 'Automatic routing';

  const restrictionParts = [
    settings.allowAutomaticFallback ? 'fallback enabled' : 'fallback disabled',
    settings.allowVerificationUpgrade ? 'verification upgrade enabled' : 'verification upgrade disabled',
  ];

  return {
    summary: `User default: ${defaultModelStrategy}`,
    detail: `Settings apply to every new task when panel stays on user default mode. ${restrictionParts.join(' · ')}.`,
  };
}