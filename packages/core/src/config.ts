import { config as loadDotenv } from 'dotenv';
import { getProviderIdForModel, getSupportedModelIdsForProvider, isSupportedModelId } from '@llm-crane/providers';
import { RuntimeConfigSchema, type ProviderRuntimeProfile, type RuntimeConfig } from '@llm-crane/schemas';
import { ConfigurationError } from './errors';

loadDotenv();

type EnvSource = Record<string, string | undefined>;
type HostedProviderKey = keyof RuntimeConfig['providerKeys'];

function parseRuntimeProfiles(env: EnvSource): ProviderRuntimeProfile[] {
  const rawProfiles = env.LLM_CRANE_RUNTIME_PROFILES;
  if (!rawProfiles) {
    return [];
  }

  try {
    return RuntimeConfigSchema.shape.runtimeProfiles.parse(JSON.parse(rawProfiles));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid LLM_CRANE_RUNTIME_PROFILES: ${message}`);
  }
}

function validateConfiguredModelOwnership(
  providerKeys: RuntimeConfig['providerKeys'],
  runtimeProfiles: ProviderRuntimeProfile[],
): void {
  const configuredOwners = new Map<string, string>();

  const registerOwner = (modelId: string, owner: string) => {
    const existingOwner = configuredOwners.get(modelId);
    if (existingOwner) {
      throw new ConfigurationError(`Model ${modelId} is configured by multiple runtimes: ${existingOwner}, ${owner}`);
    }

    configuredOwners.set(modelId, owner);
  };

  for (const [providerId, apiKey] of Object.entries(providerKeys)) {
    if (!apiKey) {
      continue;
    }

    for (const modelId of getSupportedModelIdsForProvider(providerId as HostedProviderKey)) {
      registerOwner(modelId, `hosted:${providerId}`);
    }
  }

  for (const profile of runtimeProfiles) {
    for (const modelId of profile.models) {
      registerOwner(modelId, `runtime:${profile.runtimeId}`);
    }
  }
}

function requireConfiguredModel(modelId: string, providerKeys: RuntimeConfig['providerKeys'], runtimeProfiles: ProviderRuntimeProfile[]): void {
  if (runtimeProfiles.some((profile) => profile.models.includes(modelId))) {
    return;
  }

  const providerId = getProviderIdForModel(modelId);
  if (!providerId) {
    throw new ConfigurationError(`Unsupported model id: ${modelId}`);
  }

  const hostedProviderKey = providerId as HostedProviderKey;

  if (!providerKeys[hostedProviderKey]) {
    throw new ConfigurationError(`Missing provider or runtime configuration for model: ${modelId}`);
  }
}

export function loadRuntimeConfig(env: EnvSource): RuntimeConfig {
  const defaultSimpleModel = env.LLM_CRANE_SIMPLE_MODEL ?? 'gpt-4o-mini';
  const defaultComplexModel = env.LLM_CRANE_COMPLEX_MODEL ?? 'claude-3-5-sonnet-latest';

  const providerKeys = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    gemini: env.GEMINI_API_KEY,
  };
  const runtimeProfiles = parseRuntimeProfiles(env);

  if (Object.values(providerKeys).every((value) => !value) && runtimeProfiles.length === 0) {
    throw new ConfigurationError('At least one provider API key or runtime profile must be configured.');
  }

  validateConfiguredModelOwnership(providerKeys, runtimeProfiles);

  if (!isSupportedModelId(defaultSimpleModel) && !runtimeProfiles.some((profile) => profile.models.includes(defaultSimpleModel))) {
    throw new ConfigurationError(`Invalid simple model name: ${defaultSimpleModel}`);
  }

  if (!isSupportedModelId(defaultComplexModel) && !runtimeProfiles.some((profile) => profile.models.includes(defaultComplexModel))) {
    throw new ConfigurationError(`Invalid complex model name: ${defaultComplexModel}`);
  }

  requireConfiguredModel(defaultSimpleModel, providerKeys, runtimeProfiles);
  requireConfiguredModel(defaultComplexModel, providerKeys, runtimeProfiles);

  return RuntimeConfigSchema.parse({
    defaultSimpleModel,
    defaultComplexModel,
    transport: env.LLM_CRANE_TRANSPORT ?? 'stdio',
    logLevel: env.LLM_CRANE_LOG_LEVEL ?? 'info',
    providerKeys,
    runtimeProfiles,
  });
}