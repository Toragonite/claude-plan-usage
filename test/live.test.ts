import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseLiveUsage,
  mergeStaleWindows,
  getLiveUsage,
  getLiveUsageForAccounts,
  defaultWindowLabel,
  defaultConfigDir,
  type MergedLiveUsage,
} from '../src/live';

/**
 * Load a JSON fixture from test/fixtures/live/. Uses fs.readFileSync + JSON.parse
 * (no import assertions) to stay CJS/ESM-agnostic; `__dirname` is provided by the
 * vitest module runner in both module systems.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'live', name), 'utf8'));
}

/** A minimal well-formed reading for the merge tests (accepts stale-window fields too). */
function makeUsage(over: Partial<MergedLiveUsage> = {}): MergedLiveUsage {
  return {
    available: true,
    subscriptionType: 'max',
    windows: [],
    sessionCostUsd: null,
    extraUsage: null,
    fetchedAt: 1_000_000,
    raw: null,
    ...over,
  };
}

const WIN = (kind: 'session' | 'weekly_all' | 'weekly_scoped') => ({
  kind,
  percent: 20,
  severity: 'normal',
  resetsAt: null,
});

describe('parseLiveUsage — modern limits[] payload', () => {
  it('parses windows, cost, subscription, and extra usage; orders windows', () => {
    const result = parseLiveUsage(fixture('modern-full.json'));
    expect(result.available).toBe(true);
    expect(result.subscriptionType).toBe('max');
    expect(result.sessionCostUsd).toBe(1.2345);

    // Fixture lists windows out of order and includes an unknown 'opus' kind that
    // must be dropped; output is fixed order session, weekly_all, weekly_scoped.
    expect(result.windows.map((w) => w.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped']);
    expect(result.windows[0]).toEqual({
      kind: 'session',
      percent: 42.5,
      severity: 'warning',
      resetsAt: '2026-07-13T18:00:00.000Z',
    });
    expect(result.windows[1]).toEqual({
      kind: 'weekly_all',
      percent: 10,
      severity: 'normal',
      resetsAt: '2026-07-20T00:00:00.000Z',
    });
    expect(result.windows[2]).toEqual({
      kind: 'weekly_scoped',
      percent: 88,
      severity: 'critical',
      resetsAt: '2026-07-20T00:00:00.000Z',
    });

    // Minor-unit conversion: 0 -> 0, 5000 with dp 2 -> 50.
    expect(result.extraUsage).toEqual({
      enabled: true,
      percent: 0,
      used: 0,
      cap: 50,
      currency: 'USD',
    });
  });
});

describe('parseLiveUsage — extra_usage variants', () => {
  it('honors decimal_places 3, non-USD currency, disabled, and clamps utilization', () => {
    const { extraUsage } = parseLiveUsage(fixture('extra-usage-eur.json'));
    expect(extraUsage).toEqual({
      enabled: false,
      percent: 100, // 150 clamped to 100
      used: 12.345, // 12345 / 10^3
      cap: 100, // 100000 / 10^3
      currency: 'EUR',
    });
  });

  it('defaults dp to 2 when out of range, nulls non-finite amounts, defaults currency', () => {
    const { extraUsage } = parseLiveUsage(fixture('extra-usage-defaults.json'));
    expect(extraUsage).toEqual({
      enabled: true,
      percent: null, // utilization not a number
      used: null, // used_credits not a number
      cap: 25, // 2500 / 10^2 (dp 9 rejected -> default 2)
      currency: 'USD', // missing -> default
    });
  });

  it('treats a non-integer decimal_places as the default 2', () => {
    const { extraUsage } = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 3000, decimal_places: 2.5 } },
    });
    expect(extraUsage?.cap).toBe(30); // 3000 / 10^2
  });

  it('honors decimal_places 0 (no scaling)', () => {
    const { extraUsage } = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: { extra_usage: { is_enabled: true, used_credits: 7, decimal_places: 0 } },
    });
    expect(extraUsage?.used).toBe(7);
  });

  it('returns null extraUsage when extra_usage is null, absent, or a non-object', () => {
    expect(parseLiveUsage({ rate_limits: { extra_usage: null } }).extraUsage).toBeNull();
    expect(parseLiveUsage({ rate_limits: {} }).extraUsage).toBeNull();
    expect(parseLiveUsage({ rate_limits: { extra_usage: 42 } }).extraUsage).toBeNull();
    expect(parseLiveUsage({ rate_limits: { extra_usage: [1, 2] } }).extraUsage).toBeNull();
  });
});

describe('parseLiveUsage — rate_limits null but available', () => {
  it('is available with no windows and no extra usage', () => {
    const result = parseLiveUsage(fixture('rate-limits-null.json'));
    expect(result.available).toBe(true);
    expect(result.subscriptionType).toBe('pro');
    expect(result.windows).toEqual([]);
    expect(result.sessionCostUsd).toBe(0);
    expect(result.extraUsage).toBeNull();
  });
});

describe('parseLiveUsage — top-level five_hour/seven_day fallback', () => {
  it('maps five_hour -> session and seven_day -> weekly_all with severity normal', () => {
    const result = parseLiveUsage(fixture('fallback-toplevel.json'));
    expect(result.windows).toEqual([
      { kind: 'session', percent: 55, severity: 'normal', resetsAt: '2026-07-13T20:00:00.000Z' },
      { kind: 'weekly_all', percent: 12, severity: 'normal', resetsAt: '2026-07-19T00:00:00.000Z' },
    ]);
  });

  it('prefers limits[] over the top-level fallback for the same kind', () => {
    const result = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: {
        limits: [{ kind: 'session', percent: 30, severity: 'warning', resets_at: null }],
        five_hour: { utilization: 90, resets_at: '2026-07-13T20:00:00.000Z' },
      },
    });
    expect(result.windows).toEqual([
      { kind: 'session', percent: 30, severity: 'warning', resetsAt: null },
    ]);
  });

  it('ignores a top-level window whose utilization is not a number', () => {
    const result = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 'lots', resets_at: '2026-07-13T20:00:00.000Z' } },
    });
    expect(result.windows).toEqual([]);
  });
});

describe('parseLiveUsage — setup-token (no plan limits)', () => {
  it('is unavailable with null subscription and empty windows', () => {
    const result = parseLiveUsage(fixture('setup-token.json'));
    expect(result.available).toBe(false);
    expect(result.subscriptionType).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.sessionCostUsd).toBe(0.5);
    expect(result.extraUsage).toBeNull();
  });
});

describe('parseLiveUsage — junk and hostile inputs never throw', () => {
  it('degrades primitives, null, and arrays to an empty unavailable reading', () => {
    for (const junk of [null, undefined, 42, 'x', true, [], [1, 2, 3], NaN]) {
      const result = parseLiveUsage(junk);
      expect(result).toEqual({
        available: false,
        subscriptionType: null,
        windows: [],
        sessionCostUsd: null,
        extraUsage: null,
      });
    }
  });

  it('degrades deeply wrong field types without throwing', () => {
    const result = parseLiveUsage(fixture('deeply-wrong.json'));
    expect(result.available).toBe(false); // "yes" !== true
    expect(result.subscriptionType).toBeNull(); // number -> null
    expect(result.windows).toEqual([]); // limits not array, fallback not an object
    expect(result.sessionCostUsd).toBeNull(); // session is a string
    expect(result.extraUsage).toBeNull(); // extra_usage is an array
  });

  it('drops non-object entries inside limits[]', () => {
    const result = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: { limits: [null, 5, 'x', { kind: 'session', percent: 10 }] },
    });
    expect(result.windows).toEqual([
      { kind: 'session', percent: 10, severity: 'normal', resetsAt: null },
    ]);
  });
});

describe('parseLiveUsage — percent clamping and resets_at validation', () => {
  it('clamps -5 -> 0, 250 -> 100, non-number -> 0 and rejects invalid resets_at', () => {
    const result = parseLiveUsage(fixture('clamp.json'));
    const byKind = Object.fromEntries(result.windows.map((w) => [w.kind, w]));
    expect(byKind.session!.percent).toBe(0); // -5 clamped
    expect(byKind.session!.resetsAt).toBeNull(); // "not-a-real-date"
    expect(byKind.session!.severity).toBe('normal'); // absent -> normal
    expect(byKind.weekly_all!.percent).toBe(100); // 250 clamped
    expect(byKind.weekly_all!.severity).toBe('normal'); // "" -> normal
    expect(byKind.weekly_all!.resetsAt).toBe('2026-07-20T00:00:00.000Z');
    expect(byKind.weekly_scoped!.percent).toBe(0); // "abc" -> 0
    expect(byKind.weekly_scoped!.resetsAt).toBeNull(); // absent
  });

  it('clamps NaN and Infinity percent to 0/100', () => {
    const result = parseLiveUsage({
      rate_limits_available: true,
      rate_limits: {
        limits: [
          { kind: 'session', percent: NaN },
          { kind: 'weekly_all', percent: Infinity },
        ],
      },
    });
    const byKind = Object.fromEntries(result.windows.map((w) => [w.kind, w]));
    expect(byKind.session!.percent).toBe(0); // NaN -> 0
    expect(byKind.weekly_all!.percent).toBe(0); // Infinity is non-finite -> 0
  });
});

describe('mergeStaleWindows', () => {
  it('fresh windows win and are marked not stale', () => {
    const fresh = makeUsage({ windows: [WIN('session')], fetchedAt: 5000 });
    const merged = mergeStaleWindows(fresh);
    expect(merged.windows).toEqual([WIN('session')]);
    expect(merged.windowsStale).toBe(false);
    expect(merged.windowsFetchedAt).toBe(5000);
  });

  it('carries previous windows when fresh is empty but available and within maxAge', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session'), WIN('weekly_all')],
      subscriptionType: 'max',
      extraUsage: { enabled: true, percent: 10, used: 1, cap: 50, currency: 'USD' },
      fetchedAt: 100_000,
      windowsFetchedAt: 100_000,
    });
    const fresh = makeUsage({
      windows: [],
      subscriptionType: null,
      extraUsage: null,
      fetchedAt: 100_000 + 10 * 60_000, // 10 minutes later
    });
    const merged = mergeStaleWindows(fresh, prev);
    expect(merged.windowsStale).toBe(true);
    expect(merged.windows).toEqual(prev.windows);
    expect(merged.windowsFetchedAt).toBe(100_000);
    // extraUsage and subscriptionType carried because fresh's are null.
    expect(merged.extraUsage).toEqual(prev.extraUsage);
    expect(merged.subscriptionType).toBe('max');
  });

  it('keeps fresh extraUsage/subscriptionType over prev when fresh has them', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      subscriptionType: 'max',
      extraUsage: { enabled: false, percent: null, used: null, cap: null, currency: 'USD' },
      fetchedAt: 100_000,
      windowsFetchedAt: 100_000,
    });
    const fresh = makeUsage({
      windows: [],
      subscriptionType: 'pro',
      extraUsage: { enabled: true, percent: 5, used: 2, cap: 40, currency: 'EUR' },
      fetchedAt: 100_000 + 60_000,
    });
    const merged = mergeStaleWindows(fresh, prev);
    expect(merged.windowsStale).toBe(true);
    expect(merged.subscriptionType).toBe('pro');
    expect(merged.extraUsage).toEqual(fresh.extraUsage);
  });

  it('does not carry when prev is older than maxAge', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 0,
      windowsFetchedAt: 0,
    });
    const fresh = makeUsage({ windows: [], fetchedAt: 40 * 60_000 }); // 40 minutes later
    const merged = mergeStaleWindows(fresh, prev);
    expect(merged.windows).toEqual([]);
    expect(merged.windowsStale).toBe(false);
    expect(merged.windowsFetchedAt).toBeUndefined();
  });

  it('respects a custom maxAgeMs', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 0,
      windowsFetchedAt: 0,
    });
    const fresh = makeUsage({ windows: [], fetchedAt: 5 * 60_000 }); // 5 minutes later
    // Default 30min would carry; a 2min budget must not.
    expect(mergeStaleWindows(fresh, prev, 2 * 60_000).windowsStale).toBe(false);
    expect(mergeStaleWindows(fresh, prev, 10 * 60_000).windowsStale).toBe(true);
  });

  it('never carries when fresh has a probe error', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 100_000,
      windowsFetchedAt: 100_000,
    });
    const fresh = makeUsage({ windows: [], fetchedAt: 100_000 + 60_000, error: 'timeout' });
    const merged = mergeStaleWindows(fresh, prev);
    expect(merged.windows).toEqual([]);
    expect(merged.windowsStale).toBe(false);
  });

  it('never carries when fresh is unavailable', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 100_000,
      windowsFetchedAt: 100_000,
    });
    const fresh = makeUsage({ windows: [], available: false, fetchedAt: 100_000 + 60_000 });
    expect(mergeStaleWindows(fresh, prev).windowsStale).toBe(false);
  });

  it('does not carry a prev instant in the future', () => {
    const prev: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 200_000,
      windowsFetchedAt: 200_000,
    });
    const fresh = makeUsage({ windows: [], fetchedAt: 100_000 }); // prev is newer than fresh
    expect(mergeStaleWindows(fresh, prev).windowsStale).toBe(false);
  });

  it('guards NaN / non-finite instants', () => {
    const prevNaN: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: NaN,
      windowsFetchedAt: NaN,
    });
    const fresh = makeUsage({ windows: [], fetchedAt: 100_000 });
    expect(mergeStaleWindows(fresh, prevNaN).windowsStale).toBe(false);

    const prevOk: MergedLiveUsage = makeUsage({
      windows: [WIN('session')],
      fetchedAt: 100_000,
      windowsFetchedAt: 100_000,
    });
    const freshNaN = makeUsage({ windows: [], fetchedAt: NaN });
    expect(mergeStaleWindows(freshNaN, prevOk).windowsStale).toBe(false);
  });

  it('returns not-stale when fresh is empty and there is no prev', () => {
    const merged = mergeStaleWindows(makeUsage({ windows: [] }));
    expect(merged.windows).toEqual([]);
    expect(merged.windowsStale).toBe(false);
  });

  it('falls back to prev.fetchedAt when windowsFetchedAt is absent', () => {
    const prev: MergedLiveUsage = makeUsage({ windows: [WIN('session')], fetchedAt: 100_000 });
    const fresh = makeUsage({ windows: [], fetchedAt: 100_000 + 60_000 });
    const merged = mergeStaleWindows(fresh, prev);
    expect(merged.windowsStale).toBe(true);
    expect(merged.windowsFetchedAt).toBe(100_000);
  });
});

describe('defaultWindowLabel', () => {
  it('maps each kind to its UI label', () => {
    expect(defaultWindowLabel('session')).toBe('Session (5hr)');
    expect(defaultWindowLabel('weekly_all')).toBe('Weekly (7 day)');
    expect(defaultWindowLabel('weekly_scoped')).toBe('Weekly (model-scoped)');
  });
});

describe('defaultConfigDir', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (prev !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = prev;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('honors CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/config/dir';
    expect(defaultConfigDir()).toBe('/custom/config/dir');
  });

  it('falls back to ~/.claude when unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(defaultConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('getLiveUsage — programmer-error validation (synchronous TypeError)', () => {
  it('throws TypeError for timeoutMs 0', () => {
    expect(() => getLiveUsage({ timeoutMs: 0 })).toThrow(TypeError);
  });

  it('throws TypeError for a negative, NaN, Infinity, or non-number timeoutMs', () => {
    expect(() => getLiveUsage({ timeoutMs: -1 })).toThrow(TypeError);
    expect(() => getLiveUsage({ timeoutMs: NaN })).toThrow(TypeError);
    expect(() => getLiveUsage({ timeoutMs: Infinity })).toThrow(TypeError);
    // @ts-expect-error deliberately wrong type to exercise the runtime guard
    expect(() => getLiveUsage({ timeoutMs: '20000' })).toThrow(TypeError);
  });

  it('accepts a valid timeoutMs and undefined without throwing (no real process spawned)', async () => {
    // Use a nonexistent binary so nothing real is launched; both resolve cleanly.
    await expect(
      getLiveUsage({ timeoutMs: 50, claudePath: '/nonexistent/definitely-missing-bin' }),
    ).resolves.toBeDefined();
    await expect(
      getLiveUsage({ claudePath: '/nonexistent/definitely-missing-bin' }),
    ).resolves.toBeDefined();
  });
});

describe('getLiveUsage — environmental failure resolves, never rejects', () => {
  it('resolves with error and available:false for a missing binary', async () => {
    const result = await getLiveUsage({
      claudePath: '/nonexistent/definitely-missing-bin',
      timeoutMs: 2000,
      cwd: os.tmpdir(),
    });
    expect(result.available).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.windows).toEqual([]);
    expect(result.raw).toBeNull();
    expect(typeof result.fetchedAt).toBe('number');
  });
});

describe('getLiveUsageForAccounts', () => {
  it('throws TypeError when accounts is not an array', () => {
    // @ts-expect-error deliberately wrong type to exercise the runtime guard
    expect(() => getLiveUsageForAccounts(null)).toThrow(TypeError);
    // @ts-expect-error deliberately wrong type to exercise the runtime guard
    expect(() => getLiveUsageForAccounts({})).toThrow(TypeError);
  });

  it('throws TypeError synchronously for a bad timeoutMs before doing any work', () => {
    expect(() => getLiveUsageForAccounts([], { timeoutMs: 0 })).toThrow(TypeError);
  });

  // Fix 5: every element must be an object with string name + configDir.
  it('throws TypeError for a null accounts element', () => {
    // @ts-expect-error deliberately malformed element to exercise the runtime guard
    expect(() => getLiveUsageForAccounts([null])).toThrow(TypeError);
  });

  it('throws TypeError when an element is missing configDir', () => {
    // @ts-expect-error deliberately malformed element to exercise the runtime guard
    expect(() => getLiveUsageForAccounts([{ name: 'x' }])).toThrow(TypeError);
  });

  it('resolves an empty array for no accounts', async () => {
    await expect(getLiveUsageForAccounts([])).resolves.toEqual([]);
  });

  it('preserves input order and attaches name/configDir even when every probe fails', async () => {
    const accounts = [
      { name: 'alpha', configDir: '/tmp/alpha' },
      { name: 'beta', configDir: '/tmp/beta' },
      { name: 'gamma', configDir: '/tmp/gamma' },
    ];
    const results = await getLiveUsageForAccounts(accounts, {
      claudePath: '/nonexistent/definitely-missing-bin',
      timeoutMs: 2000,
      concurrency: 2,
    });
    expect(results.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(results.map((r) => r.configDir)).toEqual(['/tmp/alpha', '/tmp/beta', '/tmp/gamma']);
    for (const r of results) {
      expect(r.available).toBe(false);
      expect(typeof r.error).toBe('string');
    }
  });
});
