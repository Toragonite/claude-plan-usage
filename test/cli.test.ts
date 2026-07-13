import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTranscriptTable,
  formatBar,
  formatCost,
  formatOverage,
  formatRelative,
  formatTokens,
  main,
  parseDateFlag,
  UsageError,
} from '../src/cli';
import type { TranscriptUsageReport } from '../src/transcripts';

describe('formatBar', () => {
  it('renders empty at 0', () => {
    expect(formatBar(0)).toBe('░'.repeat(20));
  });
  it('renders full at 100', () => {
    expect(formatBar(100)).toBe('█'.repeat(20));
  });
  it('renders half at 50', () => {
    expect(formatBar(50)).toBe('█'.repeat(10) + '░'.repeat(10));
  });
  it('clamps below 0 and above 100', () => {
    expect(formatBar(-25)).toBe('░'.repeat(20));
    expect(formatBar(250)).toBe('█'.repeat(20));
  });
});

describe('formatRelative', () => {
  const now = 1_600_000_000_000;
  it('returns — for null', () => {
    expect(formatRelative(null, now)).toBe('—');
  });
  it('returns — for invalid dates', () => {
    expect(formatRelative('not-a-date', now)).toBe('—');
  });
  it('returns now for past instants', () => {
    expect(formatRelative(new Date(now - 5_000).toISOString(), now)).toBe('now');
  });
  it('formats sub-day distances in hours', () => {
    expect(formatRelative(new Date(now + 13_320_000).toISOString(), now)).toBe('in 3.7h');
  });
  it('formats multi-day distances in days', () => {
    expect(formatRelative(new Date(now + 190_080_000).toISOString(), now)).toBe('in 2.2d');
  });
});

describe('formatCost', () => {
  it('formats zero with 2 decimals', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
  it('formats small non-zero with 4 decimals', () => {
    expect(formatCost(0.05)).toBe('$0.0500');
  });
  it('formats larger values with 2 decimals', () => {
    expect(formatCost(12.3)).toBe('$12.30');
  });
});

describe('formatTokens', () => {
  it('adds thousands separators', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});

describe('parseDateFlag', () => {
  it('parses a valid date as local midnight', () => {
    const d = parseDateFlag('2026-07-10', false);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(0);
  });
  it('applies end-of-day when requested', () => {
    const d = parseDateFlag('2026-07-10', true);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });
  it('throws UsageError on out-of-range components', () => {
    expect(() => parseDateFlag('2026-13-40', false)).toThrow(UsageError);
  });
  it('throws UsageError on malformed input', () => {
    expect(() => parseDateFlag('nonsense', false)).toThrow(UsageError);
  });
});

describe('buildTranscriptTable', () => {
  const report: TranscriptUsageReport = {
    buckets: [
      {
        key: '2026-07-10',
        inputTokens: 1234,
        outputTokens: 5678,
        cacheCreationTokens: 0,
        cacheReadTokens: 999999,
        costUsd: 0.0523,
        entryCount: 12,
        models: ['claude-opus-4-8'],
      },
    ],
    totals: {
      inputTokens: 1234,
      outputTokens: 5678,
      cacheCreationTokens: 0,
      cacheReadTokens: 999999,
      costUsd: 0.0523,
      entryCount: 12,
    },
    filesScanned: 3,
    entriesParsed: 12,
    entriesSkipped: 1,
    duplicatesSkipped: 0,
    warnings: [],
  };

  it('renders a totals row', () => {
    const lines = buildTranscriptTable(report).split('\n');
    expect(lines.some((l) => l.startsWith('TOTAL'))).toBe(true);
  });
  it('aligns every column to a uniform line width', () => {
    const lines = buildTranscriptTable(report).split('\n');
    const width = lines[0]!.length;
    expect(lines.every((l) => l.length === width)).toBe(true);
  });
  it('formats token counts with separators', () => {
    expect(buildTranscriptTable(report)).toContain('999,999');
  });
});

describe('main exit codes', () => {
  let errSpy: { mockRestore(): void };
  let outSpy: { mockRestore(): void };

  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  it('returns 1 for an unknown flag', async () => {
    expect(await main(['--bogus'])).toBe(1);
  });
  it('returns 1 for a bad --group-by enum', async () => {
    expect(await main(['--group-by', 'bogus'])).toBe(1);
  });
  it('returns 1 for a bad --cost-mode enum', async () => {
    expect(await main(['--cost-mode', 'bogus'])).toBe(1);
  });
  it('returns 1 for conflicting scope flags', async () => {
    expect(await main(['--live-only', '--transcripts-only'])).toBe(1);
  });
  it('returns 0 for --help', async () => {
    expect(await main(['--help'])).toBe(0);
  });
  it('returns 0 for --version', async () => {
    expect(await main(['--version'])).toBe(0);
  });

  // Fix 1(a): --timeout must be finite and strictly positive; 0 is a usage error.
  it('returns 1 for a zero --timeout', async () => {
    expect(await main(['--live-only', '--timeout', '0'])).toBe(1);
  });

  // Fix 1(b): a lone --until must NOT apply the 7-day default since (which would
  // otherwise leave since > until and crash). It runs cleanly and exits 0.
  it('returns 0 for --until without --since (no phantom 7-day default)', async () => {
    expect(
      await main([
        '--transcripts-only',
        '--until',
        '2026-06-01',
        '--config-dir',
        '/nonexistent/cpu-test',
      ]),
    ).toBe(0);
  });

  // Fix 1(c): since after until is a usage error, never a leaked library TypeError.
  it('returns 1 when --since is after --until', async () => {
    expect(
      await main([
        '--transcripts-only',
        '--since',
        '2026-07-10',
        '--until',
        '2026-07-01',
        '--config-dir',
        '/nonexistent/cpu-test',
      ]),
    ).toBe(1);
  });
});

describe('formatOverage', () => {
  it('formats an enabled USD overage as fixed 2-decimal currency', () => {
    expect(formatOverage({ enabled: true, percent: 0, used: 0, cap: 50, currency: 'USD' })).toBe(
      'overage: ON  $0.00/$50.00 USD (0%)',
    );
  });
  it('formats a non-USD overage without a leading $', () => {
    expect(formatOverage({ enabled: true, percent: 12, used: 3.5, cap: 40, currency: 'EUR' })).toBe(
      'overage: ON  3.50/40.00 EUR (12%)',
    );
  });
  it('treats null used/cap/percent as zero', () => {
    expect(
      formatOverage({ enabled: true, percent: null, used: null, cap: null, currency: 'USD' }),
    ).toBe('overage: ON  $0.00/$0.00 USD (0%)');
  });
  it('reports off when overage is disabled', () => {
    expect(
      formatOverage({ enabled: false, percent: null, used: null, cap: null, currency: 'USD' }),
    ).toBe('overage: off');
  });
});
