export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'gemini';

const MODEL_PROVIDER_MAP: Record<string, ProviderId> = {
  'gpt-4o-mini': 'openai',
  'gpt-4.1': 'openai',
  'claude-3-5-sonnet-latest': 'anthropic',
  'claude-3-7-sonnet-latest': 'anthropic',
  'deepseek-chat': 'deepseek',
  'gemini-1.5-flash': 'gemini',
};

export function isSupportedModelId(modelId: string): boolean {
  return modelId in MODEL_PROVIDER_MAP;
}

export function getProviderIdForModel(modelId: string): ProviderId | undefined {
  return MODEL_PROVIDER_MAP[modelId];
}

export function getSupportedModelIds(): string[] {
  return Object.keys(MODEL_PROVIDER_MAP);
}