import { getProviderIdForModel, getSupportedModelIdsForProvider, type ProviderApiFamily, type ProviderId } from './catalog';
import { ProviderInvocationError } from './errors';

export type ProviderInvocationRequest = {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  metadata?: Record<string, string>;
};

export type ProviderTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ProviderInvocationResult = {
  providerId: ProviderId;
  modelId: string;
  outputText: string;
  stopReason?: string;
  usage?: ProviderTokenUsage;
  latencyMs: number;
};

export type FetchHeaders = Record<string, string>;

export type FetchRequestInitLike = {
  method?: string;
  headers?: FetchHeaders;
  body?: string;
  signal?: AbortSignal;
};

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type FetchLike = (url: string, init: FetchRequestInitLike) => Promise<FetchResponseLike>;

export type ProviderDeploymentMode = 'hosted' | 'local';

export type ProviderAuthMode = 'none' | 'bearer' | 'header' | 'query';

export type ProviderRuntimeProfile = {
  runtimeId: string;
  providerId: ProviderId;
  deploymentMode: ProviderDeploymentMode;
  apiFamily: ProviderApiFamily;
  baseUrl: string;
  models: string[];
  authMode?: ProviderAuthMode;
  authToken?: string;
  authHeaderName?: string;
  authQueryParam?: string;
  headers?: FetchHeaders;
  timeoutMs?: number;
};

export type ResolvedProviderModel = {
  runtimeId: string;
  providerId: ProviderId;
  deploymentMode: ProviderDeploymentMode;
  apiFamily: ProviderApiFamily;
  modelId: string;
};

export interface ModelProvider {
  readonly runtimeId: string;
  readonly providerId: ProviderId;
  readonly deploymentMode: ProviderDeploymentMode;
  readonly apiFamily: ProviderApiFamily;
  readonly supportedModels: readonly string[];
  supportsModel(modelId: string): boolean;
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
}

type ProviderFactoryContext = {
  runtimeId: string;
  providerId: ProviderId;
  deploymentMode: ProviderDeploymentMode;
  apiFamily: ProviderApiFamily;
  fetch: FetchLike;
  baseUrl: string;
  supportedModels: string[];
  authMode: ProviderAuthMode;
  authToken?: string;
  authHeaderName?: string;
  authQueryParam?: string;
  headers?: FetchHeaders;
  timeoutMs?: number;
};

type OpenAICompatibleProviderConfig = ProviderFactoryContext;

type AnthropicProviderConfig = ProviderFactoryContext;

type GeminiProviderConfig = ProviderFactoryContext;

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function createSupportedModelSet(supportedModels: string[]): Set<string> {
  return new Set(supportedModels.map((modelId) => modelId.trim()).filter(Boolean));
}

function getDefaultFetch(): FetchLike {
  const nativeFetch = globalThis.fetch as unknown as FetchLike | undefined;
  if (!nativeFetch) {
    throw new Error('Global fetch is not available in this runtime.');
  }
  return nativeFetch;
}

function assertSupportedProviderModel(config: ProviderFactoryContext, supportedModelSet: Set<string>, modelId: string): void {
  if (supportedModelSet.has(modelId)) {
    return;
  }

  throw new ProviderInvocationError(`Model ${modelId} is not supported by runtime ${config.runtimeId}.`, {
    providerId: config.providerId,
    code: 'unsupported_model',
    retriable: false,
  });
}

function normalizeOutputText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeOutputText(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object' && value !== null) {
    const text = Reflect.get(value, 'text');
    if (typeof text === 'string') {
      return text.trim();
    }

    const content = Reflect.get(value, 'content');
    if (typeof content === 'string' || Array.isArray(content) || (typeof content === 'object' && content !== null)) {
      return normalizeOutputText(content);
    }
  }

  return '';
}

function readUsage(payload: unknown): ProviderTokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const usage = Reflect.get(payload, 'usage');
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }

  const inputTokens = Reflect.get(usage, 'prompt_tokens') ?? Reflect.get(usage, 'input_tokens');
  const outputTokens = Reflect.get(usage, 'completion_tokens') ?? Reflect.get(usage, 'output_tokens');
  const totalTokens = Reflect.get(usage, 'total_tokens');

  return {
    inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    totalTokens: typeof totalTokens === 'number' ? totalTokens : undefined,
  };
}

function mapStatusToErrorCode(status: number): 'auth' | 'rate_limit' | 'timeout' | 'invalid_request' | 'upstream' | 'unknown' {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request';
  }
  if (status >= 500) {
    return 'upstream';
  }
  return 'unknown';
}

function isRetriableCode(code: string): boolean {
  return code === 'rate_limit' || code === 'timeout' || code === 'network' || code === 'upstream';
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload.trim();
  }

  if (typeof payload !== 'object' || payload === null) {
    return fallback;
  }

  const directMessage = Reflect.get(payload, 'message');
  if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
    return directMessage.trim();
  }

  const error = Reflect.get(payload, 'error');
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }

  if (typeof error === 'object' && error !== null) {
    const nestedMessage = Reflect.get(error, 'message');
    if (typeof nestedMessage === 'string' && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }

  return fallback;
}

async function readJsonPayload(response: FetchResponseLike): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }
}

async function postJson(
  config: ProviderFactoryContext,
  request: ProviderInvocationRequest,
  path: string,
  headers: FetchHeaders,
  body: unknown,
): Promise<{ payload: unknown; latencyMs: number }> {
  const abortController = new AbortController();
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await config.fetch(buildRequestUrl(config, path), {
      method: 'POST',
      headers: buildRequestHeaders(config, headers),
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    const payload = await readJsonPayload(response);

    if (!response.ok) {
      const code = mapStatusToErrorCode(response.status);
      throw new ProviderInvocationError(readErrorMessage(payload, `Provider ${config.providerId} request failed.`), {
        providerId: config.providerId,
        code,
        retriable: isRetriableCode(code),
        statusCode: response.status,
        details: payload,
      });
    }

    return {
      payload,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ProviderInvocationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Provider request failed.';
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    throw new ProviderInvocationError(
      isAbortError ? `Provider ${config.providerId} request timed out after ${timeoutMs}ms.` : message,
      {
        providerId: config.providerId,
        code: isAbortError ? 'timeout' : 'network',
        retriable: true,
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildRequestHeaders(config: ProviderFactoryContext, headers: FetchHeaders): FetchHeaders {
  const resolvedHeaders: FetchHeaders = {
    ...headers,
    ...(config.headers ?? {}),
  };

  if (config.authMode === 'bearer' && config.authToken) {
    resolvedHeaders.Authorization = `Bearer ${config.authToken}`;
  }

  if (config.authMode === 'header' && config.authToken && config.authHeaderName) {
    resolvedHeaders[config.authHeaderName] = config.authToken;
  }

  return resolvedHeaders;
}

function buildRequestUrl(config: ProviderFactoryContext, path: string): string {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}${path}`);

  if (config.authMode === 'query' && config.authToken && config.authQueryParam) {
    url.searchParams.set(config.authQueryParam, config.authToken);
  }

  return url.toString();
}

function extractOpenAICompatibleText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return '';
  }

  const choices = Reflect.get(payload, 'choices');
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }

  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) {
    return '';
  }

  const message = Reflect.get(firstChoice, 'message');
  const directContent = normalizeOutputText(message);
  if (directContent) {
    return directContent;
  }

  const text = Reflect.get(firstChoice, 'text');
  return normalizeOutputText(text);
}

function extractAnthropicText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return '';
  }

  const content = Reflect.get(payload, 'content');
  return normalizeOutputText(content);
}

function extractGeminiText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return '';
  }

  const candidates = Reflect.get(payload, 'candidates');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '';
  }

  const firstCandidate = candidates[0];
  if (typeof firstCandidate !== 'object' || firstCandidate === null) {
    return '';
  }

  const content = Reflect.get(firstCandidate, 'content');
  if (typeof content !== 'object' || content === null) {
    return '';
  }

  const parts = Reflect.get(content, 'parts');
  return normalizeOutputText(parts);
}

function readStopReason(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const stopReason = Reflect.get(payload, 'stop_reason') ?? Reflect.get(payload, 'finish_reason');
  return typeof stopReason === 'string' ? stopReason : undefined;
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): ModelProvider {
  const supportedModelSet = createSupportedModelSet(config.supportedModels);

  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    deploymentMode: config.deploymentMode,
    apiFamily: config.apiFamily,
    supportedModels: [...supportedModelSet],
    supportsModel(modelId: string): boolean {
      return supportedModelSet.has(modelId);
    },
    async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
      assertSupportedProviderModel(config, supportedModelSet, request.modelId);

      const { payload, latencyMs } = await postJson(
        config,
        request,
        '/chat/completions',
        {
          'Content-Type': 'application/json',
        },
        {
          model: request.modelId,
          messages: [
            ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
            { role: 'user', content: request.prompt },
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
        },
      );

      const outputText = extractOpenAICompatibleText(payload);
      if (!outputText) {
        throw new ProviderInvocationError(`Provider ${config.providerId} returned empty completion.`, {
          providerId: config.providerId,
          code: 'upstream',
          retriable: true,
          details: payload,
        });
      }

      return {
        providerId: config.providerId,
        modelId: request.modelId,
        outputText,
        stopReason: readStopReason(payload),
        usage: readUsage(payload),
        latencyMs,
      };
    },
  };
}

export function createAnthropicProvider(config: AnthropicProviderConfig): ModelProvider {
  const supportedModelSet = createSupportedModelSet(config.supportedModels);

  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    deploymentMode: config.deploymentMode,
    apiFamily: config.apiFamily,
    supportedModels: [...supportedModelSet],
    supportsModel(modelId: string): boolean {
      return supportedModelSet.has(modelId);
    },
    async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
      assertSupportedProviderModel(config, supportedModelSet, request.modelId);

      const { payload, latencyMs } = await postJson(
        config,
        request,
        '/messages',
        {
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        {
          model: request.modelId,
          system: request.systemPrompt,
          max_tokens: request.maxOutputTokens ?? 1024,
          temperature: request.temperature,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: request.prompt,
                },
              ],
            },
          ],
        },
      );

      const outputText = extractAnthropicText(payload);
      if (!outputText) {
        throw new ProviderInvocationError('Provider anthropic returned empty completion.', {
          providerId: config.providerId,
          code: 'upstream',
          retriable: true,
          details: payload,
        });
      }

      return {
        providerId: config.providerId,
        modelId: request.modelId,
        outputText,
        stopReason: readStopReason(payload),
        usage: readUsage(payload),
        latencyMs,
      };
    },
  };
}

export function createGeminiProvider(config: GeminiProviderConfig): ModelProvider {
  const supportedModelSet = createSupportedModelSet(config.supportedModels);

  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    deploymentMode: config.deploymentMode,
    apiFamily: config.apiFamily,
    supportedModels: [...supportedModelSet],
    supportsModel(modelId: string): boolean {
      return supportedModelSet.has(modelId);
    },
    async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
      assertSupportedProviderModel(config, supportedModelSet, request.modelId);

      const encodedModelId = encodeURIComponent(request.modelId);
      const { payload, latencyMs } = await postJson(
        config,
        request,
        `/models/${encodedModelId}:generateContent`,
        {
          'Content-Type': 'application/json',
        },
        {
          ...(request.systemPrompt
            ? {
                systemInstruction: {
                  parts: [{ text: request.systemPrompt }],
                },
              }
            : {}),
          contents: [
            {
              role: 'user',
              parts: [{ text: request.prompt }],
            },
          ],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
          },
        },
      );

      const outputText = extractGeminiText(payload);
      if (!outputText) {
        throw new ProviderInvocationError('Provider gemini returned empty completion.', {
          providerId: config.providerId,
          code: 'upstream',
          retriable: true,
          details: payload,
        });
      }

      return {
        providerId: config.providerId,
        modelId: request.modelId,
        outputText,
        stopReason: readStopReason(payload),
        usage: readUsage(payload),
        latencyMs,
      };
    },
  };
}

export type ProviderApiKeys = Partial<Record<ProviderId, string>>;

export type ProviderRegistryConfig = {
  apiKeys?: ProviderApiKeys;
  runtimeProfiles?: ProviderRuntimeProfile[];
};

export type ProviderRegistryOptions = {
  fetch?: FetchLike;
  baseUrls?: Partial<Record<ProviderId, string>>;
};

const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly modelProviders = new Map<string, ModelProvider>();

  constructor(initialProviders: ModelProvider[] = []) {
    for (const provider of initialProviders) {
      this.register(provider);
    }
  }

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.runtimeId)) {
      throw new Error(`Runtime ${provider.runtimeId} is already registered.`);
    }

    for (const modelId of provider.supportedModels) {
      const existingProvider = this.modelProviders.get(modelId);
      if (existingProvider) {
        throw new Error(
          `Model ${modelId} is already configured by runtime ${existingProvider.runtimeId}; runtime ${provider.runtimeId} conflicts.`,
        );
      }
    }

    this.providers.set(provider.runtimeId, provider);

    for (const modelId of provider.supportedModels) {
      this.modelProviders.set(modelId, provider);
    }
  }

  getProvider(providerId: ProviderId): ModelProvider | undefined {
    return [...this.providers.values()].find((provider) => provider.providerId === providerId);
  }

  getProviderByRuntimeId(runtimeId: string): ModelProvider | undefined {
    return this.providers.get(runtimeId);
  }

  listProviderIds(): ProviderId[] {
    return [...new Set([...this.providers.values()].map((provider) => provider.providerId))];
  }

  listRuntimeIds(): string[] {
    return [...this.providers.keys()];
  }

  describeModel(modelId: string): ResolvedProviderModel | undefined {
    const provider = this.modelProviders.get(modelId);
    if (!provider) {
      return undefined;
    }

    return {
      runtimeId: provider.runtimeId,
      providerId: provider.providerId,
      deploymentMode: provider.deploymentMode,
      apiFamily: provider.apiFamily,
      modelId,
    };
  }

  async invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult> {
    const provider = this.modelProviders.get(request.modelId);
    if (!provider) {
      const providerId = getProviderIdForModel(request.modelId);
      if (providerId) {
        throw new ProviderInvocationError(`Provider ${providerId} is not configured.`, {
          providerId,
          code: 'provider_not_configured',
          retriable: false,
        });
      }

      throw new ProviderInvocationError(`Unsupported model id: ${request.modelId}`, {
        providerId: 'openai',
        code: 'unsupported_model',
        retriable: false,
      });
    }

    return await provider.invoke(request);
  }
}

function createRuntimeProfileProvider(profile: ProviderRuntimeProfile, fetch: FetchLike): ModelProvider {
  const baseConfig = {
    runtimeId: profile.runtimeId,
    providerId: profile.providerId,
    deploymentMode: profile.deploymentMode,
    apiFamily: profile.apiFamily,
    fetch,
    baseUrl: profile.baseUrl,
    supportedModels: profile.models,
    authMode: profile.authMode ?? 'none',
    authToken: profile.authToken,
    authHeaderName: profile.authHeaderName,
    authQueryParam: profile.authQueryParam,
    headers: profile.headers,
    timeoutMs: profile.timeoutMs,
  } satisfies ProviderFactoryContext;

  switch (profile.apiFamily) {
    case 'openai-compatible':
      return createOpenAICompatibleProvider(baseConfig);
    case 'anthropic':
      return createAnthropicProvider(baseConfig);
    case 'gemini':
      return createGeminiProvider(baseConfig);
  }
}

function createHostedRuntimeProfiles(apiKeys: ProviderApiKeys, baseUrls: Record<ProviderId, string>): ProviderRuntimeProfile[] {
  const profiles: ProviderRuntimeProfile[] = [];

  if (apiKeys.openai) {
    profiles.push({
      runtimeId: 'openai',
      providerId: 'openai',
      deploymentMode: 'hosted',
      apiFamily: 'openai-compatible',
      baseUrl: baseUrls.openai,
      models: getSupportedModelIdsForProvider('openai'),
      authMode: 'bearer',
      authToken: apiKeys.openai,
    });
  }

  if (apiKeys.deepseek) {
    profiles.push({
      runtimeId: 'deepseek',
      providerId: 'deepseek',
      deploymentMode: 'hosted',
      apiFamily: 'openai-compatible',
      baseUrl: baseUrls.deepseek,
      models: getSupportedModelIdsForProvider('deepseek'),
      authMode: 'bearer',
      authToken: apiKeys.deepseek,
    });
  }

  if (apiKeys.anthropic) {
    profiles.push({
      runtimeId: 'anthropic',
      providerId: 'anthropic',
      deploymentMode: 'hosted',
      apiFamily: 'anthropic',
      baseUrl: baseUrls.anthropic,
      models: getSupportedModelIdsForProvider('anthropic'),
      authMode: 'header',
      authToken: apiKeys.anthropic,
      authHeaderName: 'x-api-key',
    });
  }

  if (apiKeys.gemini) {
    profiles.push({
      runtimeId: 'gemini',
      providerId: 'gemini',
      deploymentMode: 'hosted',
      apiFamily: 'gemini',
      baseUrl: baseUrls.gemini,
      models: getSupportedModelIdsForProvider('gemini'),
      authMode: 'query',
      authToken: apiKeys.gemini,
      authQueryParam: 'key',
    });
  }

  return profiles;
}

function isProviderRegistryConfig(value: ProviderRegistryConfig | ProviderApiKeys): value is ProviderRegistryConfig {
  return 'apiKeys' in value || 'runtimeProfiles' in value;
}

export function createProviderRegistry(configOrApiKeys: ProviderRegistryConfig | ProviderApiKeys, options: ProviderRegistryOptions = {}): ProviderRegistry {
  const fetch = options.fetch ?? getDefaultFetch();
  const baseUrls = {
    ...DEFAULT_BASE_URLS,
    ...options.baseUrls,
  };
  const config: ProviderRegistryConfig = isProviderRegistryConfig(configOrApiKeys)
    ? configOrApiKeys
    : { apiKeys: configOrApiKeys };

  const runtimeProfiles = [
    ...createHostedRuntimeProfiles(config.apiKeys ?? {}, baseUrls),
    ...(config.runtimeProfiles ?? []),
  ];
  const providers = runtimeProfiles.map((profile) => createRuntimeProfileProvider(profile, fetch));

  return new ProviderRegistry(providers);
}