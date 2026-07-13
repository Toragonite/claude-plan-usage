/**
 * Static pricing table and model-id resolution for Claude Code transcript cost
 * estimation.
 *
 * All rates are US dollars per million tokens (per-MTok). Cache-write and
 * cache-read rates are derived from the input rate using Anthropic's published
 * multipliers so that every model in {@link DEFAULT_PRICING} carries an explicit,
 * self-consistent set of cache rates.
 *
 * Pricing snapshot as of 2026-07. These numbers change over time; callers that
 * need different or newer prices should pass a custom table via
 * `TranscriptUsageOptions.pricing` (see {@link ./transcripts}).
 */

/**
 * Per-model price rates, all expressed in US dollars per million tokens.
 *
 * `inputPerMTok` and `outputPerMTok` are always present. The cache rates are
 * optional so that user-supplied tables may omit them; consumers treat a missing
 * cache rate as `0`.
 */
export interface ModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million tokens written to the 5-minute ephemeral cache. */
  cacheWrite5mPerMTok?: number;
  /** USD per million tokens written to the 1-hour ephemeral cache. */
  cacheWrite1hPerMTok?: number;
  /** USD per million tokens read from cache. */
  cacheReadPerMTok?: number;
}

/**
 * Build a {@link ModelPricing} entry from base input/output rates, deriving the
 * cache rates from the input rate:
 * - 5-minute cache write: 1.25x input
 * - 1-hour cache write:   2x input
 * - cache read:           0.1x input
 */
function rates(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mPerMTok: 1.25 * inputPerMTok,
    cacheWrite1hPerMTok: 2 * inputPerMTok,
    cacheReadPerMTok: 0.1 * inputPerMTok,
  };
}

/**
 * Default pricing table keyed by model-id prefix.
 *
 * {@link resolvePricing} tries an exact match first, then the longest key that
 * is a hyphen-boundary prefix of the requested model id (so
 * `claude-opus-4-8-20260101` resolves through `claude-opus-4-8`). Dated ids that
 * do not share a family prefix are listed as their own exact keys.
 *
 * Pricing snapshot as of 2026-07; override via `TranscriptUsageOptions.pricing`.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Frontier
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),

  // Opus 4.x (current generation)
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),
  'claude-opus-4-1': rates(15, 75),
  'claude-opus-4-0': rates(15, 75),
  // Dated Opus 4 snapshot id (exact — no family prefix to resolve through).
  'claude-opus-4-20250514': rates(15, 75),

  // Legacy Opus
  'claude-3-opus': rates(15, 75),

  // Sonnet
  'claude-sonnet-5': rates(3, 15),
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  'claude-sonnet-4-0': rates(3, 15),
  // Dated Sonnet 4 snapshot id (exact — no family prefix to resolve through).
  'claude-sonnet-4-20250514': rates(3, 15),
  'claude-3-7-sonnet': rates(3, 15),
  'claude-3-5-sonnet': rates(3, 15),

  // Haiku
  'claude-haiku-4-5': rates(1, 5),
  'claude-3-5-haiku': rates(0.8, 4),
  'claude-3-haiku': rates(0.25, 1.25),
};

/**
 * Resolve pricing for a model id.
 *
 * Resolution order (case-sensitive):
 * 1. Exact key match in `table`.
 * 2. Otherwise the longest key that is a hyphen-boundary prefix of `modelId`
 *    (i.e. `modelId` starts with the key and the next character is `-`). This
 *    stops `claude-opus-4-1` from matching a future `claude-opus-4-10-…`.
 * 3. Otherwise `null`.
 *
 * @param modelId Model id as it appears in a transcript entry.
 * @param table   Pricing table to resolve against. Defaults to {@link DEFAULT_PRICING}.
 * @returns The matching {@link ModelPricing}, or `null` when no key matches.
 */
export function resolvePricing(
  modelId: string,
  table: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing | null {
  if (Object.prototype.hasOwnProperty.call(table, modelId)) {
    const exact = table[modelId];
    if (exact !== undefined) return exact;
  }

  let best: ModelPricing | null = null;
  let bestLen = -1;
  for (const key of Object.keys(table)) {
    if (key.length <= bestLen) continue;
    const matches = modelId === key || (modelId.startsWith(key) && modelId[key.length] === '-');
    if (!matches) continue;
    const value = table[key];
    if (value !== undefined) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}
