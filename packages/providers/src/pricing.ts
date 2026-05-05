import type { ProviderTokenUsage } from './adapters';
import { getModelDescriptor, type ProviderId } from './catalog';

export type CostEstimateStatus = 'exact' | 'estimated' | 'unknown';
export type CostEstimateUsageSource = 'provider' | 'estimated' | 'unknown';
export type CostEstimatePricingSource = 'catalog' | 'unknown';

export type ModelPricing = {
  modelId: string;
  providerId: ProviderId;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  pricingSource: 'catalog';
};

export type ModelCostEstimate = {
  status: CostEstimateStatus;
  currency: 'USD';
  pricingUnit: 'usd-per-1m-tokens';
  modelId: string;
  usageSource: CostEstimateUsageSource;
  pricingSource: CostEstimatePricingSource;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  totalCostUsd?: number;
  latencyMs?: number;
  detail: string;
};

type EstimateModelCostInput = {
  modelId: string;
  usage?: ProviderTokenUsage;
  promptText?: string;
  outputText?: string;
  latencyMs?: number;
  executionStatus?: 'completed' | 'failed';
};

const MODEL_PRICING_CATALOG: Record<string, { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }> = {
  'gpt-4o-mini': { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
  'gpt-4.1': { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8 },
  'claude-3-5-sonnet-latest': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  'claude-3-7-sonnet-latest': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  'deepseek-chat': { inputUsdPerMillionTokens: 0.27, outputUsdPerMillionTokens: 1.1 },
  'gemini-1.5-flash': { inputUsdPerMillionTokens: 0.075, outputUsdPerMillionTokens: 0.3 },
};

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function roundTokenCount(value: number): number {
  return Math.max(0, Math.round(value));
}

export function estimateTextTokens(text: string | undefined): number | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function getModelPricing(modelId: string): ModelPricing | undefined {
  const pricing = MODEL_PRICING_CATALOG[modelId];
  const descriptor = getModelDescriptor(modelId);

  if (!pricing || !descriptor) {
    return undefined;
  }

  return {
    modelId,
    providerId: descriptor.providerId,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    pricingSource: 'catalog',
  };
}

function deriveTokenUsage(input: EstimateModelCostInput): {
  usageSource: CostEstimateUsageSource;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const usage = input.usage;
  const estimatedInputTokens = estimateTextTokens(input.promptText);
  const estimatedOutputTokens = estimateTextTokens(input.outputText);

  if (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined) {
    return {
      usageSource: 'provider',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    };
  }

  if (
    usage?.totalTokens !== undefined &&
    estimatedInputTokens !== undefined &&
    estimatedOutputTokens !== undefined &&
    estimatedInputTokens + estimatedOutputTokens > 0
  ) {
    const promptWeight = estimatedInputTokens / (estimatedInputTokens + estimatedOutputTokens);
    const inputTokens = roundTokenCount(usage.totalTokens * promptWeight);
    const outputTokens = Math.max(0, usage.totalTokens - inputTokens);

    return {
      usageSource: 'estimated',
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens,
    };
  }

  if (estimatedInputTokens !== undefined || estimatedOutputTokens !== undefined) {
    const inputTokens = usage?.inputTokens ?? estimatedInputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? estimatedOutputTokens ?? 0;

    return {
      usageSource: 'estimated',
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    };
  }

  return {
    usageSource: 'unknown',
  };
}

export function estimateModelCost(input: EstimateModelCostInput): ModelCostEstimate {
  const pricing = getModelPricing(input.modelId);
  if (!pricing) {
    return {
      status: 'unknown',
      currency: 'USD',
      pricingUnit: 'usd-per-1m-tokens',
      modelId: input.modelId,
      usageSource: 'unknown',
      pricingSource: 'unknown',
      latencyMs: input.latencyMs,
      detail: 'Model pricing unavailable in local catalog.',
    };
  }

  if (input.executionStatus === 'failed') {
    return {
      status: 'unknown',
      currency: 'USD',
      pricingUnit: 'usd-per-1m-tokens',
      modelId: input.modelId,
      usageSource: 'unknown',
      pricingSource: pricing.pricingSource,
      latencyMs: input.latencyMs,
      detail: 'Provider call failed; billed token usage unknown.',
    };
  }

  const tokenUsage = deriveTokenUsage(input);
  if (tokenUsage.usageSource === 'unknown' || tokenUsage.inputTokens === undefined || tokenUsage.outputTokens === undefined) {
    return {
      status: 'unknown',
      currency: 'USD',
      pricingUnit: 'usd-per-1m-tokens',
      modelId: input.modelId,
      usageSource: 'unknown',
      pricingSource: pricing.pricingSource,
      latencyMs: input.latencyMs,
      detail: 'Provider returned no token usage and text-based estimate unavailable.',
    };
  }

  const inputCostUsd = roundMoney((tokenUsage.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens);
  const outputCostUsd = roundMoney((tokenUsage.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens);
  const totalCostUsd = roundMoney(inputCostUsd + outputCostUsd);

  return {
    status: tokenUsage.usageSource === 'provider' ? 'exact' : 'estimated',
    currency: 'USD',
    pricingUnit: 'usd-per-1m-tokens',
    modelId: input.modelId,
    usageSource: tokenUsage.usageSource,
    pricingSource: pricing.pricingSource,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    totalTokens: tokenUsage.totalTokens ?? tokenUsage.inputTokens + tokenUsage.outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd,
    latencyMs: input.latencyMs,
    detail:
      tokenUsage.usageSource === 'provider'
        ? 'Estimated from provider-reported token usage and local price catalog.'
        : 'Estimated from prompt/output text length and local price catalog.',
  };
}