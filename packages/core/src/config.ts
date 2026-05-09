import { config as loadDotenv } from 'dotenv';
import { getProviderIdForModel, getSupportedModelIdsForProvider, isSupportedModelId } from '@llm-crane/providers';
import {
  CachePolicySchema,
  ProviderFallbackPolicySchema,
  ProviderRetryPolicySchema,
  RuntimeConfigSchema,
  type CachePolicy,
  type ProviderFallbackPolicy,
  type ProviderRetryPolicy,
  type ProviderRuntimeProfile,
  type RuntimeConfig,
} from '@llm-crane/schemas';
import { ConfigurationError } from './errors';

loadDotenv();

type EnvSource = Record<string, string | undefined>;
type HostedProviderKey = keyof RuntimeConfig['providerKeys'];

const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
  maxRetries: 2,
  backoffStrategy: 'exponential',
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

const DEFAULT_CACHE_POLICY: CachePolicy = {
  ttlMs: 86_400_000,
};

const DEFAULT_PROVIDER_FALLBACK_POLICY: ProviderFallbackPolicy = {
  enabled: true,
  simple: [],
  complex: [],
};

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

function parseProviderRetryPolicy(env: EnvSource): ProviderRetryPolicy {
  const candidate = {
    maxRetries: env.LLM_CRANE_PROVIDER_MAX_RETRIES,
    backoffStrategy: env.LLM_CRANE_PROVIDER_BACKOFF_STRATEGY,
    baseDelayMs: env.LLM_CRANE_PROVIDER_RETRY_BASE_DELAY_MS,
    maxDelayMs: env.LLM_CRANE_PROVIDER_RETRY_MAX_DELAY_MS,
  };

  if (Object.values(candidate).every((value) => value === undefined)) {
    return DEFAULT_PROVIDER_RETRY_POLICY;
  }

  try {
    return ProviderRetryPolicySchema.parse({
      maxRetries: candidate.maxRetries !== undefined ? Number(candidate.maxRetries) : DEFAULT_PROVIDER_RETRY_POLICY.maxRetries,
      backoffStrategy: candidate.backoffStrategy ?? DEFAULT_PROVIDER_RETRY_POLICY.backoffStrategy,
      baseDelayMs: candidate.baseDelayMs !== undefined ? Number(candidate.baseDelayMs) : DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs,
      maxDelayMs: candidate.maxDelayMs !== undefined ? Number(candidate.maxDelayMs) : DEFAULT_PROVIDER_RETRY_POLICY.maxDelayMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid provider retry configuration: ${message}`);
  }
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  throw new ConfigurationError(`Invalid boolean value: ${value}`);
}

function parseModelList(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  return [...new Set(rawValue.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function parseProviderFallbackPolicy(env: EnvSource): ProviderFallbackPolicy {
  try {
    return ProviderFallbackPolicySchema.parse({
      enabled: parseBooleanEnv(env.LLM_CRANE_ENABLE_PROVIDER_FALLBACK, DEFAULT_PROVIDER_FALLBACK_POLICY.enabled),
      simple: parseModelList(env.LLM_CRANE_SIMPLE_FALLBACK_MODELS),
      complex: parseModelList(env.LLM_CRANE_COMPLEX_FALLBACK_MODELS),
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid provider fallback configuration: ${message}`);
  }
}

function parseCachePolicy(env: EnvSource): CachePolicy {
  if (env.LLM_CRANE_CACHE_TTL_MS === undefined) {
    return DEFAULT_CACHE_POLICY;
  }

  try {
    return CachePolicySchema.parse({
      ttlMs: Number(env.LLM_CRANE_CACHE_TTL_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Invalid cache policy configuration: ${message}`);
  }
}

function validateConfiguredFallbackModels(
  fallbackPolicy: ProviderFallbackPolicy,
  providerKeys: RuntimeConfig['providerKeys'],
  runtimeProfiles: ProviderRuntimeProfile[],
): void {
  for (const modelId of [...fallbackPolicy.simple, ...fallbackPolicy.complex]) {
    requireConfiguredModel(modelId, providerKeys, runtimeProfiles);
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
  const providerRetry = parseProviderRetryPolicy(env);
  const cachePolicy = parseCachePolicy(env);
  const providerFallback = parseProviderFallbackPolicy(env);

  if (Object.values(providerKeys).every((value) => !value) && runtimeProfiles.length === 0) {
    throw new ConfigurationError('At least one provider API key or runtime profile must be configured.');
  }

  validateConfiguredModelOwnership(providerKeys, runtimeProfiles);
  validateConfiguredFallbackModels(providerFallback, providerKeys, runtimeProfiles);

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
    cachePolicy,
    logLevel: env.LLM_CRANE_LOG_LEVEL ?? 'info',
    providerRetry,
    providerFallback,
    providerKeys,
    runtimeProfiles,
  });
}