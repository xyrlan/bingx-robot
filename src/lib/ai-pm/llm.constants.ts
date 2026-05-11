/**
 * Model IDs and per-million-token USD prices for the LLM router.
 *
 * Update these values when Anthropic publishes new pricing or models.
 * Prices are USD per 1,000,000 tokens. The router converts them to per-token
 * before computing call costs.
 *
 * Source: https://www.anthropic.com/pricing (verify periodically).
 */

export const MODEL_HAIKU = 'claude-haiku-4-5';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_OPUS = 'claude-opus-4-7';

export type ModelId = typeof MODEL_HAIKU | typeof MODEL_SONNET | typeof MODEL_OPUS;

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

export const PRICING: Record<ModelId, ModelPricing> = {
  [MODEL_HAIKU]: {
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
    cachedInputUsdPerMillion: 0.10,
  },
  [MODEL_SONNET]: {
    inputUsdPerMillion: 3.0,
    outputUsdPerMillion: 15.0,
    cachedInputUsdPerMillion: 0.30,
  },
  [MODEL_OPUS]: {
    inputUsdPerMillion: 15.0,
    outputUsdPerMillion: 75.0,
    cachedInputUsdPerMillion: 1.50,
  },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function calculateCostUsd(model: ModelId, usage: UsageBreakdown): number {
  const pricing = PRICING[model];
  const regularInput = usage.inputTokens - usage.cachedInputTokens;
  const inputCost = (regularInput / 1_000_000) * pricing.inputUsdPerMillion;
  const cachedCost =
    pricing.cachedInputUsdPerMillion != null
      ? (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputUsdPerMillion
      : 0;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return inputCost + cachedCost + outputCost;
}
