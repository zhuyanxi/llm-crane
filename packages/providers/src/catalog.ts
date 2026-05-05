export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'gemini';

export type ModelCapabilityTier = 'low-cost' | 'high-capability';

export type ModelDescriptor = {
  providerId: ProviderId;
  capabilityTier: ModelCapabilityTier;
  apiFamily: 'openai-compatible' | 'anthropic' | 'gemini';
};

const MODEL_CATALOG: Record<string, ModelDescriptor> = {
  'gpt-4o-mini': {
    providerId: 'openai',
    capabilityTier: 'low-cost',
    apiFamily: 'openai-compatible',
  },
  'gpt-4.1': {
    providerId: 'openai',
    capabilityTier: 'high-capability',
    apiFamily: 'openai-compatible',
  },
  'claude-3-5-sonnet-latest': {
    providerId: 'anthropic',
    capabilityTier: 'high-capability',
    apiFamily: 'anthropic',
  },
  'claude-3-7-sonnet-latest': {
    providerId: 'anthropic',
    capabilityTier: 'high-capability',
    apiFamily: 'anthropic',
  },
  'deepseek-chat': {
    providerId: 'deepseek',
    capabilityTier: 'low-cost',
    apiFamily: 'openai-compatible',
  },
  'gemini-1.5-flash': {
    providerId: 'gemini',
    capabilityTier: 'low-cost',
    apiFamily: 'gemini',
  },
};

export function isSupportedModelId(modelId: string): boolean {
  return modelId in MODEL_CATALOG;
}

export function getProviderIdForModel(modelId: string): ProviderId | undefined {
  return MODEL_CATALOG[modelId]?.providerId;
}

export function getSupportedModelIds(): string[] {
  return Object.keys(MODEL_CATALOG);
}

export function getModelDescriptor(modelId: string): ModelDescriptor | undefined {
  return MODEL_CATALOG[modelId];
}