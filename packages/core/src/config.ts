import { config as loadDotenv } from 'dotenv';
import { getProviderIdForModel, isSupportedModelId } from '@llm-crane/providers';
import { RuntimeConfigSchema, type RuntimeConfig } from '@llm-crane/schemas';
import { ConfigurationError } from './errors';

loadDotenv();

type EnvSource = Record<string, string | undefined>;

function requireProviderKey(modelId: string, providerKeys: RuntimeConfig['providerKeys']): void {
  const providerId = getProviderIdForModel(modelId);

  if (!providerId) {
    throw new ConfigurationError(`Unsupported model id: ${modelId}`);
  }

  if (!providerKeys[providerId]) {
    throw new ConfigurationError(`Missing API key for configured model: ${modelId}`);
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

  if (Object.values(providerKeys).every((value) => !value)) {
    throw new ConfigurationError('At least one provider API key must be configured.');
  }

  if (!isSupportedModelId(defaultSimpleModel)) {
    throw new ConfigurationError(`Invalid simple model name: ${defaultSimpleModel}`);
  }

  if (!isSupportedModelId(defaultComplexModel)) {
    throw new ConfigurationError(`Invalid complex model name: ${defaultComplexModel}`);
  }

  requireProviderKey(defaultSimpleModel, providerKeys);
  requireProviderKey(defaultComplexModel, providerKeys);

  return RuntimeConfigSchema.parse({
    defaultSimpleModel,
    defaultComplexModel,
    transport: env.LLM_CRANE_TRANSPORT ?? 'stdio',
    logLevel: env.LLM_CRANE_LOG_LEVEL ?? 'info',
    providerKeys,
  });
}