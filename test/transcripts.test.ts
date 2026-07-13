import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  computeEntryCost,
  getTranscriptUsage,
  parseTranscriptLine,
  type TranscriptEntry,
  type UsageBucket,
} from '../src/transcripts';
import type { ModelPricing } from '../src/pricing';

const CFG_A = fileURLToPath(new URL('./fixtures/transcripts/cfgA', import.meta.url));

/** Track temp directories created by tests so they can be removed afterwards. */
const tempDirs: string[] = [];
function makeTempConfigDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function bucketByKey(buckets: UsageBucket[]): Map<string, UsageBucket> {
  return new Map(buckets.map((b) => [b.key, b]));
}

// --- parseTranscriptLine -----------------------------------------------------

describe('parseTranscriptLine', () => {
  const validObject = {
    type: 'assistant',
    timestamp: '2026-07-13T00:00:00.000Z',
    sessionId: 'sess',
    requestId: 'req',
    costUSD: 0.5,
    message: {
      id: 'mid',
      model: 'claude-opus-4-8',
      role: 'assistant',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
      },
    },
  };

  it('parses a well-formed assistant entry', () => {
    const entry = parseTranscriptLine(JSON.stringify(validObject));
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      timestamp: '2026-07-13T00:00:00.000Z',
      model: 'claude-opus-4-8',
      sessionId: 'sess',
      messageId: 'mid',
      requestId: 'req',
      costUsd: 0.5,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 5,
        cacheReadTokens: 7,
        cacheCreation5mTokens: 3,
        cacheCreation1hTokens: 2,
      },
    });
  });

  it('trims a trailing carriage return before parsing', () => {
    const entry = parseTranscriptLine(JSON.stringify(validObject) + '\r');
    expect(entry).not.toBeNull();
    expect(entry?.model).toBe('claude-opus-4-8');
  });

  it('returns null (never throws) for malformed JSON', () => {
    expect(parseTranscriptLine('{not json')).toBeNull();
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   ')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseTranscriptLine('123')).toBeNull();
    expect(parseTranscriptLine('"a string"')).toBeNull();
    expect(parseTranscriptLine('[1,2,3]')).toBeNull();
    expect(parseTranscriptLine('null')).toBeNull();
  });

  it('returns null for non-assistant line types', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'user', message: {} }))).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: 'summary', summary: 'x' }))).toBeNull();
  });

  it('returns null for synthetic model lines', () => {
    const synthetic = { ...validObject, message: { ...validObject.message, model: '<synthetic>' } };
    expect(parseTranscriptLine(JSON.stringify(synthetic))).toBeNull();
  });

  it('returns null when message or usage shape is invalid', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: validObject.timestamp }))).toBeNull();
    const noUsage = { ...validObject, message: { id: 'x', model: 'claude-opus-4-8' } };
    expect(parseTranscriptLine(JSON.stringify(noUsage))).toBeNull();
  });

  it('returns null when the timestamp is missing or unparseable', () => {
    const bad = { ...validObject, timestamp: 'not-a-date' };
    expect(parseTranscriptLine(JSON.stringify(bad))).toBeNull();
    const missing = { ...validObject } as Record<string, unknown>;
    delete missing.timestamp;
    expect(parseTranscriptLine(JSON.stringify(missing))).toBeNull();
  });

  it('clamps non-finite or negative token counts to 0', () => {
    const object = {
      type: 'assistant',
      timestamp: validObject.timestamp,
      message: {
        id: 'm',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: -5,
          output_tokens: 'x',
          cache_creation_input_tokens: NaN, // JSON-serializes to null
          cache_read_input_tokens: 10,
        },
      },
    };
    const entry = parseTranscriptLine(JSON.stringify(object));
    expect(entry?.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
  });

  it('treats empty-string ids as null and a missing/invalid costUSD as null', () => {
    const object = {
      type: 'assistant',
      timestamp: validObject.timestamp,
      sessionId: '',
      requestId: '',
      costUSD: 'not-a-number',
      message: { id: '', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } },
    };
    const entry = parseTranscriptLine(JSON.stringify(object));
    expect(entry).toMatchObject({ sessionId: null, requestId: null, messageId: null, costUsd: null });
  });
});

// --- computeEntryCost --------------------------------------------------------

function makeEntry(
  model: string,
  usage: Partial<TranscriptEntry['usage']>,
  costUsd: number | null = null,
): TranscriptEntry {
  return {
    timestamp: '2026-07-13T00:00:00.000Z',
    model,
    sessionId: null,
    messageId: null,
    requestId: null,
    costUsd,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
      ...usage,
    },
  };
}

describe('computeEntryCost', () => {
  it('prices input, output and cache-read against the default table', () => {
    // opus-4-8: input 5, output 25, read 0.5 per MTok.
    const entry = makeEntry('claude-opus-4-8', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 300,
      cacheCreationTokens: 200,
      cacheCreation5mTokens: 200,
      cacheCreation1hTokens: 0,
    });
    // 5000 + 12500 + 150 + (200*6.25) = 18900 microdollars.
    expect(computeEntryCost(entry)).toBeCloseTo(0.0189, 10);
  });

  it('uses the 1h write rate when the 1h breakdown is present', () => {
    const entry = makeEntry('claude-opus-4-8', {
      cacheCreationTokens: 1000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 1000,
    });
    // 1000 * (2*5) = 10000 microdollars = 0.01 (would be 0.00625 if 5m rate were used).
    expect(computeEntryCost(entry)).toBeCloseTo(0.01, 10);
  });

  it('charges all cache-creation tokens at the 5m rate when no breakdown is present', () => {
    const entry = makeEntry('claude-opus-4-8', { cacheCreationTokens: 1000 });
    // 1000 * (1.25*5) = 6250 microdollars = 0.00625.
    expect(computeEntryCost(entry)).toBeCloseTo(0.00625, 10);
  });

  it('uses the breakdown when only one side is non-null', () => {
    const entry = makeEntry('claude-opus-4-8', {
      cacheCreationTokens: 500,
      cacheCreation5mTokens: 500,
      cacheCreation1hTokens: null,
    });
    // Breakdown path: 500 * 6.25 = 3125 microdollars = 0.003125.
    expect(computeEntryCost(entry)).toBeCloseTo(0.003125, 10);
  });

  // Fix 6: the 5m/1h breakdown can under-sum the reported cacheCreationTokens;
  // the remainder must still be charged at the 5m write rate.
  it('charges the cache-creation remainder at the 5m rate when the breakdown under-sums', () => {
    const entry = makeEntry('claude-opus-4-8', {
      cacheCreationTokens: 5000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    });
    // 5000 tokens unaccounted for by the breakdown -> 5000 * 6.25 = 31250 microdollars = 0.03125.
    expect(computeEntryCost(entry)).toBeCloseTo(0.03125, 10);
  });

  it('returns null for an unknown model', () => {
    expect(computeEntryCost(makeEntry('unknown-model-xyz', { inputTokens: 100 }))).toBeNull();
  });

  it('honours a custom pricing table (missing cache rates treated as 0)', () => {
    const table: Record<string, ModelPricing> = { m: { inputPerMTok: 2, outputPerMTok: 3 } };
    const entry = makeEntry('m', { inputTokens: 1_000_000, cacheCreationTokens: 1000 });
    // Only input priced; cache-write rate absent -> 0.
    expect(computeEntryCost(entry, table)).toBeCloseTo(2, 10);
  });
});

// --- getTranscriptUsage: aggregation over on-disk fixtures -------------------

describe('getTranscriptUsage over cfgA fixtures', () => {
  it('groups by day in UTC and reports scan statistics', async () => {
    const report = await getTranscriptUsage({
      configDirs: [CFG_A],
      groupBy: 'day',
      timezone: 'utc',
    });

    expect(report.filesScanned).toBe(3);
    expect(report.entriesParsed).toBe(6);
    // Two malformed JSON lines (broken + torn) plus one invalid-timestamp assistant line.
    expect(report.entriesSkipped).toBe(3);
    // msgA appears in both s1.jsonl and s2.jsonl.
    expect(report.duplicatesSkipped).toBe(1);

    // Assert UTC keys only; local keys depend on the CI timezone.
    expect(report.buckets.map((b) => b.key)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ]);

    const byKey = bucketByKey(report.buckets);
    // 2026-07-10: msgA only (dedup keeps a single copy).
    expect(byKey.get('2026-07-10')).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 300,
      entryCount: 1,
      models: ['claude-opus-4-8'],
    });
    // 2026-07-11: msgB (09:00Z) + msgC (23:30Z, straddling midnight UTC).
    expect(byKey.get('2026-07-11')).toMatchObject({
      inputTokens: 7000,
      outputTokens: 1100,
      entryCount: 2,
      models: ['claude-fable-5', 'claude-sonnet-5'],
    });
    // 2026-07-12: msgD (00:15Z legacy cost) + msgE + msgF (unknown model).
    expect(byKey.get('2026-07-12')).toMatchObject({
      inputTokens: 310,
      outputTokens: 160,
      entryCount: 3,
      models: ['claude-opus-4-8', 'unknown-model-xyz'],
    });

    expect(report.totals).toMatchObject({
      inputTokens: 8310,
      outputTokens: 1760,
      cacheCreationTokens: 200,
      cacheReadTokens: 300,
      entryCount: 6,
    });
  });

  it("uses recorded cost when present and computes the rest in 'auto' mode", async () => {
    const report = await getTranscriptUsage({ configDirs: [CFG_A], timezone: 'utc' });
    // 0.0189 (msgA) + 0.021 (msgB) + 0.055 (msgC) + 0.42 (msgD recorded) + 0 + 0.
    expect(report.totals.costUsd).toBeCloseTo(0.5149, 6);
    // Unknown-model warning is emitted once even though two entries trigger it.
    const warning = 'unknown model pricing: unknown-model-xyz';
    expect(report.warnings).toContain(warning);
    expect(report.warnings.filter((w) => w === warning)).toHaveLength(1);
  });

  it("computes every entry in 'calculate' mode, ignoring recorded cost", async () => {
    const report = await getTranscriptUsage({
      configDirs: [CFG_A],
      timezone: 'utc',
      costMode: 'calculate',
    });
    // msgD is now computed (0.0003) instead of its recorded 0.42.
    expect(report.totals.costUsd).toBeCloseTo(0.0952, 6);
    expect(
      report.warnings.filter((w) => w === 'unknown model pricing: unknown-model-xyz'),
    ).toHaveLength(1);
  });

  it("uses only recorded cost in 'display' mode and emits no pricing warnings", async () => {
    const report = await getTranscriptUsage({
      configDirs: [CFG_A],
      timezone: 'utc',
      costMode: 'display',
    });
    expect(report.totals.costUsd).toBeCloseTo(0.42, 6);
    expect(report.warnings).not.toContain('unknown model pricing: unknown-model-xyz');
  });

  it('groups by project using the raw encoded directory name', async () => {
    const report = await getTranscriptUsage({ configDirs: [CFG_A], groupBy: 'project' });
    expect(report.buckets.map((b) => b.key)).toEqual(['-Users-x-proj1', '-Users-x-proj2']);
    const byKey = bucketByKey(report.buckets);
    expect(byKey.get('-Users-x-proj1')?.entryCount).toBe(4);
    expect(byKey.get('-Users-x-proj2')?.entryCount).toBe(2);
  });

  it('groups by model', async () => {
    const report = await getTranscriptUsage({ configDirs: [CFG_A], groupBy: 'model' });
    expect(report.buckets.map((b) => b.key)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'unknown-model-xyz',
    ]);
    const byKey = bucketByKey(report.buckets);
    expect(byKey.get('claude-opus-4-8')?.entryCount).toBe(2); // msgA + msgD
    expect(byKey.get('claude-opus-4-8')?.models).toEqual(['claude-opus-4-8']);
  });

  it('groups by session', async () => {
    const report = await getTranscriptUsage({ configDirs: [CFG_A], groupBy: 'session' });
    expect(report.buckets.map((b) => b.key)).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });

  it('groups everything into a single total bucket', async () => {
    const report = await getTranscriptUsage({ configDirs: [CFG_A], groupBy: 'total' });
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]?.key).toBe('total');
    expect(report.buckets[0]?.entryCount).toBe(6);
  });

  it('applies since/until inclusively and counts entriesParsed before filtering', async () => {
    const report = await getTranscriptUsage({
      configDirs: [CFG_A],
      timezone: 'utc',
      since: new Date('2026-07-11T09:00:00.000Z'), // exactly msgB
      until: new Date('2026-07-11T23:30:00.000Z'), // exactly msgC
    });
    expect(report.entriesParsed).toBe(6); // counted before the date filter
    expect(report.totals.entryCount).toBe(2); // only msgB + msgC pass the window
    expect(report.buckets.map((b) => b.key)).toEqual(['2026-07-11']);
    expect(report.buckets[0]?.inputTokens).toBe(7000);
  });

  it('excludes entries just outside the since boundary', async () => {
    const report = await getTranscriptUsage({
      configDirs: [CFG_A],
      timezone: 'utc',
      since: new Date('2026-07-11T09:00:00.001Z'), // one ms after msgB
    });
    const byKey = bucketByKey(report.buckets);
    // msgB (09:00:00.000) is now excluded; only msgC remains on 2026-07-11.
    expect(byKey.get('2026-07-11')?.inputTokens).toBe(5000);
    expect(byKey.has('2026-07-10')).toBe(false);
  });
});

// --- getTranscriptUsage: option validation -----------------------------------

describe('getTranscriptUsage option validation', () => {
  it('rejects an invalid groupBy', async () => {
    await expect(getTranscriptUsage({ groupBy: 'weekly' as never })).rejects.toBeInstanceOf(TypeError);
  });
  it('rejects an invalid costMode', async () => {
    await expect(getTranscriptUsage({ costMode: 'nope' as never })).rejects.toBeInstanceOf(TypeError);
  });
  it('rejects an invalid timezone', async () => {
    await expect(getTranscriptUsage({ timezone: 'mars' as never })).rejects.toBeInstanceOf(TypeError);
  });
  it('rejects an invalid since Date', async () => {
    await expect(getTranscriptUsage({ since: new Date('nonsense') })).rejects.toBeInstanceOf(TypeError);
  });
  it('rejects since greater than until', async () => {
    await expect(
      getTranscriptUsage({ since: new Date('2026-07-12'), until: new Date('2026-07-10') }),
    ).rejects.toBeInstanceOf(TypeError);
  });
  it('rejects configDirs that is not an array of strings', async () => {
    await expect(getTranscriptUsage({ configDirs: [123 as never] })).rejects.toBeInstanceOf(TypeError);
    await expect(getTranscriptUsage({ configDirs: 'x' as never })).rejects.toBeInstanceOf(TypeError);
  });
});

// --- getTranscriptUsage: environment edge cases ------------------------------

describe('getTranscriptUsage environment handling', () => {
  it('warns and skips a provided config dir that does not exist', async () => {
    const missing = join(tmpdir(), 'claude-plan-usage-definitely-missing-xyz');
    const report = await getTranscriptUsage({ configDirs: [missing] });
    expect(report.warnings).toContain(`config dir not found: ${missing}`);
    expect(report.buckets).toEqual([]);
    expect(report.filesScanned).toBe(0);
    expect(report.totals.entryCount).toBe(0);
  });

  it('resolves an empty report when no config dirs are given', async () => {
    const report = await getTranscriptUsage({ configDirs: [] });
    expect(report).toMatchObject({
      buckets: [],
      filesScanned: 0,
      entriesParsed: 0,
      entriesSkipped: 0,
      duplicatesSkipped: 0,
    });
    expect(report.totals.entryCount).toBe(0);
  });

  it('parses entries from files with CRLF line endings', async () => {
    const dir = makeTempConfigDir('cpu-crlf-');
    const projectDir = join(dir, 'projects', '-Users-x-crlf');
    mkdirSync(projectDir, { recursive: true });
    const l1 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T01:00:00.000Z',
      sessionId: 's',
      requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 10 } },
    });
    const l2 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T02:00:00.000Z',
      sessionId: 's',
      requestId: 'r2',
      message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 10 } },
    });
    writeFileSync(join(projectDir, 'c.jsonl'), `${l1}\r\n${l2}\r\n`);

    const report = await getTranscriptUsage({ configDirs: [dir], groupBy: 'total' });
    expect(report.entriesParsed).toBe(2);
    expect(report.entriesSkipped).toBe(0);
    expect(report.totals.inputTokens).toBe(200);
  });

  it('falls back to the file basename when a session id is missing', async () => {
    const dir = makeTempConfigDir('cpu-nosession-');
    const projectDir = join(dir, 'projects', '-Users-x-nos');
    mkdirSync(projectDir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T03:00:00.000Z',
      requestId: 'r',
      message: { id: 'm', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    writeFileSync(join(projectDir, 'my-session.jsonl'), `${line}\n`);

    const report = await getTranscriptUsage({ configDirs: [dir], groupBy: 'session' });
    expect(report.buckets.map((b) => b.key)).toEqual(['my-session']);
  });

  it('finds transcripts nested in subdirectories under a project dir', async () => {
    const dir = makeTempConfigDir('cpu-nested-');
    const nested = join(dir, 'projects', '-Users-x-nested', 'sub');
    mkdirSync(nested, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T04:00:00.000Z',
      sessionId: 's',
      requestId: 'r',
      message: { id: 'm', model: 'claude-opus-4-8', usage: { input_tokens: 42, output_tokens: 1 } },
    });
    writeFileSync(join(nested, 'deep.jsonl'), `${line}\n`);

    const report = await getTranscriptUsage({ configDirs: [dir], groupBy: 'project' });
    // The project key is the first-level directory name, not the nested subdir.
    expect(report.buckets.map((b) => b.key)).toEqual(['-Users-x-nested']);
    expect(report.buckets[0]?.inputTokens).toBe(42);
  });

  // Fix 3: the pricing option MERGES over DEFAULT_PRICING; overriding one model
  // must not blank out the default rates for the others.
  it('merges a pricing override over DEFAULT_PRICING (defaults survive for other models)', async () => {
    const dir = makeTempConfigDir('cpu-pricing-merge-');
    const projectDir = join(dir, 'projects', '-Users-x-merge');
    mkdirSync(projectDir, { recursive: true });
    const opus = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T00:00:00.000Z',
      sessionId: 's',
      requestId: 'r1',
      message: {
        id: 'm1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });
    const sonnet = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T00:00:00.000Z',
      sessionId: 's',
      requestId: 'r2',
      message: {
        id: 'm2',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });
    writeFileSync(join(projectDir, 'p.jsonl'), `${opus}\n${sonnet}\n`);

    const report = await getTranscriptUsage({
      configDirs: [dir],
      costMode: 'calculate',
      groupBy: 'model',
      pricing: { 'claude-opus-4-8': { inputPerMTok: 99, outputPerMTok: 0 } },
    });
    const byKey = bucketByKey(report.buckets);
    // Overridden model: 1M input tokens at the new $99/MTok rate.
    expect(byKey.get('claude-opus-4-8')?.costUsd).toBeCloseTo(99, 6);
    // Un-overridden model still resolves through DEFAULT_PRICING (sonnet-5 = $3/MTok input).
    expect(byKey.get('claude-sonnet-5')?.costUsd).toBeCloseTo(3, 6);
    // ...and therefore emits no unknown-pricing warning.
    expect(report.warnings).not.toContain('unknown model pricing: claude-sonnet-5');
  });
});
