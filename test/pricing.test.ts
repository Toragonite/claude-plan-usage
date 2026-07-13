import { describe, expect, it } from 'vitest';

import { DEFAULT_PRICING, resolvePricing, type ModelPricing } from '../src/pricing';

describe('DEFAULT_PRICING', () => {
  it('exposes the pinned base rates', () => {
    expect(DEFAULT_PRICING['claude-fable-5']).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(DEFAULT_PRICING['claude-opus-4-8']).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(DEFAULT_PRICING['claude-opus-4-1']).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 });
    expect(DEFAULT_PRICING['claude-sonnet-5']).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(DEFAULT_PRICING['claude-haiku-4-5']).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(DEFAULT_PRICING['claude-3-5-haiku']).toMatchObject({ inputPerMTok: 0.8, outputPerMTok: 4 });
    expect(DEFAULT_PRICING['claude-3-haiku']).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 1.25,
    });
  });

  it('derives explicit cache rates from the input rate for every entry', () => {
    for (const pricing of Object.values(DEFAULT_PRICING)) {
      expect(pricing.cacheWrite5mPerMTok).toBeCloseTo(1.25 * pricing.inputPerMTok, 10);
      expect(pricing.cacheWrite1hPerMTok).toBeCloseTo(2 * pricing.inputPerMTok, 10);
      expect(pricing.cacheReadPerMTok).toBeCloseTo(0.1 * pricing.inputPerMTok, 10);
    }
  });
});

describe('resolvePricing', () => {
  it('matches an exact key', () => {
    const pricing = resolvePricing('claude-opus-4-8');
    expect(pricing).not.toBeNull();
    expect(pricing?.inputPerMTok).toBe(5);
  });

  it('matches by prefix for dated snapshot ids', () => {
    // Dated Opus 4.8 snapshot resolves through the exact-prefix key.
    expect(resolvePricing('claude-opus-4-8-20260101')?.inputPerMTok).toBe(5);
    // Dated Opus 4 (no minor) resolves through its exact claude-opus-4-20250514 key.
    expect(resolvePricing('claude-opus-4-20250514')?.inputPerMTok).toBe(15);
    // Dated 3.5 Sonnet resolves through claude-3-5-sonnet.
    expect(resolvePricing('claude-3-5-sonnet-20241022')?.inputPerMTok).toBe(3);
  });

  it('prefers the longest matching prefix', () => {
    const table: Record<string, ModelPricing> = {
      claude: { inputPerMTok: 1, outputPerMTok: 1 },
      'claude-opus': { inputPerMTok: 2, outputPerMTok: 2 },
      'claude-opus-4-8': { inputPerMTok: 3, outputPerMTok: 3 },
    };
    expect(resolvePricing('claude-opus-4-8-xyz', table)?.inputPerMTok).toBe(3);
    expect(resolvePricing('claude-opus-3', table)?.inputPerMTok).toBe(2);
    expect(resolvePricing('claude-haiku', table)?.inputPerMTok).toBe(1);
  });

  it('returns null when no key is a prefix', () => {
    const table: Record<string, ModelPricing> = {
      claude: { inputPerMTok: 1, outputPerMTok: 1 },
    };
    // 'claude' is not a prefix of 'cla'.
    expect(resolvePricing('cla', table)).toBeNull();
    expect(resolvePricing('gpt-4')).toBeNull();
    expect(resolvePricing('')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(resolvePricing('Claude-Opus-4-8')).toBeNull();
  });

  // Fix 9(a): a key matches only at a hyphen boundary, so a longer minor version
  // like 4-10 never resolves through the 4-1 rates.
  it('matches only at a hyphen boundary between key and remainder', () => {
    expect(resolvePricing('claude-opus-4-10-20270101')).toBeNull();
    expect(resolvePricing('claude-opus-4-1-20250805')).toMatchObject({
      inputPerMTok: 15,
      outputPerMTok: 75,
    });
  });

  // Fix 9(b): dated snapshot ids that have no family prefix are exact keys.
  it('resolves the exact dated snapshot ids', () => {
    expect(resolvePricing('claude-opus-4-20250514')).toMatchObject({
      inputPerMTok: 15,
      outputPerMTok: 75,
    });
    expect(resolvePricing('claude-sonnet-4-20250514')).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });
});
