#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  getLiveUsageForAccounts,
  defaultConfigDir,
  defaultWindowLabel,
  type ExtraUsage,
  type LiveUsage,
} from './live';
import {
  getTranscriptUsage,
  type CostMode,
  type TranscriptGroupBy,
  type TranscriptUsageReport,
} from './transcripts';

/** Version string, kept in lockstep with package.json by the release script. */
export const VERSION = '0.1.0';

/** Thrown for user-facing usage errors (bad flags, dates, enums) → exit code 1. */
export class UsageError extends Error {}

const GROUP_BY_VALUES: readonly TranscriptGroupBy[] = [
  'day',
  'month',
  'session',
  'model',
  'project',
  'total',
];
const COST_MODE_VALUES: readonly CostMode[] = ['auto', 'calculate', 'display'];

const ONE_DAY_MS = 86_400_000;

const options = {
  json: { type: 'boolean' },
  'live-only': { type: 'boolean' },
  'transcripts-only': { type: 'boolean' },
  'group-by': { type: 'string' },
  since: { type: 'string' },
  until: { type: 'string' },
  'config-dir': { type: 'string', multiple: true },
  'claude-path': { type: 'string' },
  timeout: { type: 'string' },
  'cost-mode': { type: 'string' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const ANSI = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

const USAGE_HINT = "run 'claude-plan-usage --help' for usage";

const HELP_TEXT = `claude-plan-usage — live claude.ai plan usage + local transcript token/cost aggregation

Usage:
  claude-plan-usage [options]

Options:
  --json                       machine-readable JSON output (no ANSI)
  --live-only                  show only live plan usage
  --transcripts-only           show only transcript aggregation
  --group-by <g>               day|month|session|model|project|total (default day)
  --since <YYYY-MM-DD>         start date (local); disables the 7-day default
  --until <YYYY-MM-DD>         end date (local, inclusive)
  --config-dir <path>          Claude config dir; repeatable for multiple accounts
  --claude-path <path>         path to the claude executable
  --timeout <ms>               live probe timeout in milliseconds
  --cost-mode <m>              auto|calculate|display (default auto)
  --no-color                   disable ANSI colors
  -h, --help                   show this help
  -v, --version                print version

By default: live usage for the default config dir plus transcript usage for the
last 7 days grouped by day.
`;

// ---- Pure helpers (exported for unit testing) ----

/** Render a 20-char progress bar for a 0..100 percentage (clamped). */
export function formatBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

/** Human relative time until an ISO instant: 'now', 'in 3.7h', 'in 2.2d', or '—'. */
export function formatRelative(iso: string | null, nowMs: number): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = t - nowMs;
  if (diff <= 0) return 'now';
  const hours = diff / 3_600_000;
  if (hours < 24) return `in ${hours.toFixed(1)}h`;
  return `in ${(diff / ONE_DAY_MS).toFixed(1)}d`;
}

/** Format a USD cost: $X.XX, with 4 decimals for small non-zero amounts (< $0.10). */
export function formatCost(n: number): string {
  const decimals = n > 0 && n < 0.1 ? 4 : 2;
  return `$${n.toFixed(decimals)}`;
}

/** Format a token count with en-US thousands separators. */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Parse a YYYY-MM-DD flag as a LOCAL date. Throws UsageError on malformed input. */
export function parseDateFlag(s: string, endOfDay: boolean): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new UsageError(`invalid date '${s}' (expected YYYY-MM-DD)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    throw new UsageError(`invalid date '${s}' (expected YYYY-MM-DD)`);
  }
  return d;
}

/** Render the aligned transcript table (header, rows, totals). Plain spaces. */
export function buildTranscriptTable(report: TranscriptUsageReport): string {
  const header = ['Key', 'Input', 'Output', 'CacheW', 'CacheR', 'Cost', 'Entries'];
  const aligns: ReadonlyArray<'l' | 'r'> = ['l', 'r', 'r', 'r', 'r', 'r', 'r'];
  const rows: string[][] = report.buckets.map((b) => [
    b.key,
    formatTokens(b.inputTokens),
    formatTokens(b.outputTokens),
    formatTokens(b.cacheCreationTokens),
    formatTokens(b.cacheReadTokens),
    formatCost(b.costUsd),
    formatTokens(b.entryCount),
  ]);
  const t = report.totals;
  const totalRow = [
    'TOTAL',
    formatTokens(t.inputTokens),
    formatTokens(t.outputTokens),
    formatTokens(t.cacheCreationTokens),
    formatTokens(t.cacheReadTokens),
    formatCost(t.costUsd),
    formatTokens(t.entryCount),
  ];
  const all = [header, ...rows, totalRow];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const renderRow = (r: string[]): string =>
    r
      .map((cell, i) => (aligns[i] === 'l' ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join('  ');
  return [renderRow(header), ...rows.map(renderRow), renderRow(totalRow)].join('\n');
}

/**
 * Render the overage ("extra usage") status line. When enabled, used/cap are
 * shown as fixed 2-decimal amounts: `$<used>/$<cap> USD` for USD, otherwise
 * `<used>/<cap> <currency>`. Null used/cap/percent read as 0.
 */
export function formatOverage(extra: ExtraUsage): string {
  if (!extra.enabled) return 'overage: off';
  const used = extra.used ?? 0;
  const cap = extra.cap ?? 0;
  const pct = extra.percent !== null ? Math.round(extra.percent) : 0;
  const amounts =
    extra.currency === 'USD'
      ? `$${used.toFixed(2)}/$${cap.toFixed(2)} USD`
      : `${used.toFixed(2)}/${cap.toFixed(2)} ${extra.currency}`;
  return `overage: ON  ${amounts} (${pct}%)`;
}

// ---- Rendering ----

function colorize(s: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${s}${ANSI.reset}` : s;
}

function severityColor(percent: number, severity: string): string {
  if (percent >= 90 || severity === 'critical') return ANSI.red;
  if (percent >= 70 || severity === 'warning') return ANSI.yellow;
  return ANSI.green;
}

function renderLiveAccount(
  usage: LiveUsage & { name: string; configDir: string },
  colorEnabled: boolean,
  nowMs: number,
): string[] {
  const lines: string[] = [];
  lines.push(colorize(usage.configDir, ANSI.bold, colorEnabled));
  if (usage.error !== undefined) {
    lines.push(`  probe failed: ${usage.error}`);
    return lines;
  }
  if (!usage.available) {
    lines.push('  no plan limits (token / non-subscription login)');
    return lines;
  }
  for (const w of usage.windows) {
    const pct = Math.round(w.percent);
    const bar = formatBar(w.percent);
    const rel = formatRelative(w.resetsAt, nowMs);
    const label = defaultWindowLabel(w.kind).padEnd(14);
    const line = `  ${label}  ${bar}  ${String(pct).padStart(3)}%  resets ${rel}`;
    lines.push(colorize(line, severityColor(w.percent, w.severity), colorEnabled));
  }
  if (usage.subscriptionType !== null) {
    lines.push(`  subscription: ${usage.subscriptionType}`);
  }
  const extra = usage.extraUsage;
  if (extra !== null) {
    lines.push(`  ${formatOverage(extra)}`);
  }
  return lines;
}

// ---- Entry ----

function usageError(msg: string): number {
  process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(`${USAGE_HINT}\n`);
  return 1;
}

function safeParse(argv: string[]) {
  try {
    const { values } = parseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: false,
    });
    return { ok: true as const, values };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

/** Run the CLI. Returns the intended exit code; never calls process.exit itself. */
export async function main(argv: string[]): Promise<number> {
  const parsed = safeParse(argv);
  if (!parsed.ok) return usageError(parsed.error);
  const values = parsed.values;

  if (values.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (values['live-only'] && values['transcripts-only']) {
    return usageError('--live-only and --transcripts-only are mutually exclusive');
  }

  const groupBy = values['group-by'] ?? 'day';
  if (!GROUP_BY_VALUES.includes(groupBy as TranscriptGroupBy)) {
    return usageError(`invalid --group-by '${groupBy}' (expected ${GROUP_BY_VALUES.join('|')})`);
  }
  const costMode = values['cost-mode'] ?? 'auto';
  if (!COST_MODE_VALUES.includes(costMode as CostMode)) {
    return usageError(`invalid --cost-mode '${costMode}' (expected ${COST_MODE_VALUES.join('|')})`);
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    // Must be finite and strictly positive. `--timeout` and `--timeout=` both
    // yield Number('') === 0, which is a usage error, not a valid probe budget.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return usageError(`invalid --timeout '${values.timeout}' (expected positive milliseconds)`);
    }
  }

  const configDirs = values['config-dir'];

  try {
    let since: Date | undefined;
    let until: Date | undefined;
    if (values.since !== undefined) since = parseDateFlag(values.since, false);
    if (values.until !== undefined) until = parseDateFlag(values.until, true);
    // The 7-day default window applies only when NEITHER bound is given. A lone
    // --until means "everything up to date X", so since stays undefined.
    if (values.since === undefined && values.until === undefined) {
      since = new Date(Date.now() - 7 * ONE_DAY_MS);
    }
    if (since !== undefined && until !== undefined && since.getTime() > until.getTime()) {
      return usageError('--since must be on or before --until');
    }

    const wantLive = values['transcripts-only'] !== true;
    const wantTranscripts = values['live-only'] !== true;
    const nowMs = Date.now();
    const colorEnabled =
      Boolean(process.stdout.isTTY) &&
      process.env.NO_COLOR === undefined &&
      values['no-color'] !== true;

    let liveResults: Array<LiveUsage & { name: string; configDir: string }> | undefined;
    let transcriptReport: TranscriptUsageReport | undefined;

    if (wantLive) {
      const accounts =
        configDirs && configDirs.length > 0
          ? configDirs.map((dir) => ({ name: dir, configDir: dir }))
          : [{ name: defaultConfigDir(), configDir: defaultConfigDir() }];
      liveResults = await getLiveUsageForAccounts(accounts, {
        claudePath: values['claude-path'],
        timeoutMs,
      });
    }

    if (wantTranscripts) {
      transcriptReport = await getTranscriptUsage({
        configDirs,
        since,
        until,
        groupBy: groupBy as TranscriptGroupBy,
        costMode: costMode as CostMode,
      });
    }

    if (values.json) {
      const out: { live?: unknown; transcripts?: unknown } = {};
      if (liveResults !== undefined) out.live = liveResults;
      if (transcriptReport !== undefined) out.transcripts = transcriptReport;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }

    const outLines: string[] = [];
    if (liveResults !== undefined) {
      for (const acct of liveResults) {
        outLines.push(...renderLiveAccount(acct, colorEnabled, nowMs));
      }
    }
    if (transcriptReport !== undefined) {
      if (liveResults !== undefined) outLines.push('');
      outLines.push(buildTranscriptTable(transcriptReport));
      outLines.push(
        `files scanned ${transcriptReport.filesScanned} · entries ${transcriptReport.entriesParsed} · skipped ${transcriptReport.entriesSkipped} · duplicates ${transcriptReport.duplicatesSkipped}`,
      );
      for (const warn of transcriptReport.warnings) {
        process.stderr.write(`warning: ${warn}\n`);
      }
    }
    if (outLines.length > 0) process.stdout.write(`${outLines.join('\n')}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) return usageError(err.message);
    throw err;
  }
}

function run(): void {
  void main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    });
}

if (
  process.env.CLAUDE_PLAN_USAGE_CLI !== '0' &&
  !process.env.VITEST &&
  !process.env.NODE_TEST_CONTEXT &&
  !process.env.JEST_WORKER_ID
) {
  void run();
}
