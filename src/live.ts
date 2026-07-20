import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Live claude.ai plan rate-limit usage via the Claude Code control protocol
 * `get_usage` request.
 *
 * A short-lived `claude` process is spawned in stream-json mode under a target
 * `CLAUDE_CONFIG_DIR`; a single `control_request` of subtype `get_usage` returns
 * the same structured data the interactive `/usage` command shows — session cost
 * totals plus claude.ai plan rate-limit utilization and reset times "when
 * available". No credentials are read or handled here: the Claude CLI
 * authenticates itself under the given config directory.
 *
 * UPSTREAM IS EXPERIMENTAL. The `get_usage` response is documented as "the
 * response shape may change", so every field is read defensively and any parse
 * gap degrades to `available:false` rather than throwing. The spawning functions
 * ({@link getLiveUsage}, {@link getLiveUsageForAccounts}) never reject and never
 * throw for environmental failures (missing binary, timeout, garbage output,
 * killed process) — every path resolves a {@link LiveUsage}. The only throws are
 * `TypeError` for programmer errors (see each function's docs).
 *
 * Zero runtime dependencies: Node built-ins only (`child_process`, `os`, `path`).
 */

/**
 * Rate-limit windows this library surfaces. Upstream `limits[].kind` may carry
 * other kinds; they are ignored.
 *
 * - `session` — the rolling 5-hour session window.
 * - `weekly_all` — the 7-day window covering all models.
 * - `weekly_scoped` — the 7-day window scoped to a specific (premium) model.
 */
export type UsageWindowKind = 'session' | 'weekly_all' | 'weekly_scoped';

/** One normalized rate-limit window. */
export interface UsageWindow {
  /** Which window this is; see {@link UsageWindowKind}. */
  kind: UsageWindowKind;
  /** Percent of the window consumed, clamped to 0-100 (non-finite input → 0). */
  percent: number;
  /**
   * Raw upstream severity (`'normal'` | `'warning'` | `'critical'` | some other
   * string). `'normal'` when upstream reports none or an empty value.
   */
  severity: string;
  /** ISO-8601 reset timestamp, or `null` when absent or unparseable. */
  resetsAt: string | null;
}

/**
 * Overage ("extra usage") billing state.
 *
 * While `enabled` is false, exhausting a plan window BLOCKS further work — the
 * account spends quota, never money. Once `enabled` is true, work past a plan
 * limit is billed against a monthly cap instead, so overrunning a window starts
 * spending real money.
 *
 * Amounts are reported by upstream in MINOR units (e.g. cents) and are converted
 * here to MAJOR units (e.g. dollars). `used` and `cap` are `null` whenever the
 * corresponding upstream value is missing or non-finite.
 */
export interface ExtraUsage {
  /** Whether overage billing is switched on for this account. */
  enabled: boolean;
  /** Percent of the monthly overage cap consumed (0-100), or `null` when not reported. */
  percent: number | null;
  /** Spend so far in major currency units (e.g. dollars), or `null` when not reported. */
  used: number | null;
  /** Monthly overage cap in major currency units, or `null` when not reported. */
  cap: number | null;
  /** ISO-4217-ish currency code; defaults to `'USD'` when not reported. */
  currency: string;
}

/**
 * A single normalized live-usage reading.
 *
 * IMPORTANT: `available === false` with `error === undefined` is a VALID,
 * successful state. It means the account exposed no claude.ai plan rate limits.
 * It is NOT a failure, and the `error` field is set ONLY when the probe itself
 * failed. Callers must treat `error === undefined && available === false` as "no
 * plan limits", never as an error.
 *
 * It is also AMBIGUOUS: a setup-token / API-key login (which has no plan limits
 * by design) and a subscription login that has expired or been logged out both
 * produce this exact reading. Do not assume the former — `getAuthStatus` and
 * `classifyAccount` in `./auth` exist to tell them apart.
 */
export interface LiveUsage {
  /** True only when the account exposes claude.ai plan rate limits (`rate_limits_available`). */
  available: boolean;
  /** claude.ai plan (`'max'`, `'pro'`, …) or `null` when not exposed. */
  subscriptionType: string | null;
  /** Ordered session, weekly_all, weekly_scoped; empty when unavailable or on error. */
  windows: UsageWindow[];
  /** Current session accumulated cost in USD, or `null`. */
  sessionCostUsd: number | null;
  /** Overage billing state, or `null` when the account reports none. */
  extraUsage: ExtraUsage | null;
  /** Epoch milliseconds when this reading was taken (`Date.now()` at settle time). */
  fetchedAt: number;
  /** The raw `get_usage` payload on success, or `null` on error. Useful for debugging upstream drift. */
  raw: unknown;
  /**
   * Set ONLY when the probe itself failed (spawn failure, timeout, non-success
   * `control_response`, process closed with no response, unparseable output).
   * Distinct from `available:false`, which is a valid "no plan limits" state.
   */
  error?: string;
}

/** Options for a single live-usage probe. */
export interface LiveUsageOptions {
  /**
   * `CLAUDE_CONFIG_DIR` to probe under. Defaults to {@link defaultConfigDir}
   * (`process.env.CLAUDE_CONFIG_DIR` or `~/.claude`).
   */
  configDir?: string;
  /** Path or command name for the Claude CLI. Defaults to `'claude'`. */
  claudePath?: string;
  /**
   * Overall probe timeout in milliseconds. Defaults to `20000`. Must be a finite
   * number greater than 0 when provided, or a `TypeError` is thrown synchronously.
   */
  timeoutMs?: number;
  /**
   * Extra environment variables merged over `process.env` for the spawned CLI.
   * `CLAUDE_CONFIG_DIR` is always overridden from `configDir` and cannot be
   * shadowed here.
   */
  env?: Record<string, string | undefined>;
  /**
   * Working directory for the spawned CLI. Defaults to `os.tmpdir()`. A neutral
   * directory is REQUIRED so that no project `.mcp.json` is loaded — a project
   * cwd would spawn that project's MCP servers on every probe.
   */
  cwd?: string;
}

/** A {@link LiveUsage} augmented with carried-forward ("stale") window bookkeeping. */
export interface MergedLiveUsage extends LiveUsage {
  /**
   * True when `windows` were carried over from an earlier reading because the
   * latest probe returned no windows while the plan is still available. The
   * values are real but not current; surfaces should mark them.
   */
  windowsStale?: boolean;
  /**
   * Epoch milliseconds when `windows` were actually observed fresh. Equals
   * `fetchedAt` for a fresh reading; older when the windows were carried over.
   */
  windowsFetchedAt?: number;
}

/** Default probe timeout. `get_usage` returns in ~1-2s; 20s is a generous ceiling. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Default bounded concurrency for {@link getLiveUsageForAccounts}. */
const DEFAULT_CONCURRENCY = 3;

/** Cap on the un-newlined stdout buffer; past this the output is not stream-json at all. */
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;

/** How long a good windows reading is carried forward once upstream stops returning windows. */
const DEFAULT_STALE_WINDOW_MAX_MS = 30 * 60 * 1000;

/** Human labels matching the `/usage` UI, per confirmed mapping. */
const WINDOW_LABELS: Record<UsageWindowKind, string> = {
  session: 'Session (5hr)',
  weekly_all: 'Weekly (7 day)',
  weekly_scoped: 'Weekly (model-scoped)',
};

/** Fixed output order for windows. Absent kinds are omitted, present kinds keep this order. */
const WINDOW_ORDER: UsageWindowKind[] = ['session', 'weekly_all', 'weekly_scoped'];

/** True for a plain (non-array, non-null) object. Used to gate every defensive read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamp any input to a percentage in [0, 100]; non-finite / non-number → 0. */
function clampPercent(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

/** Return `s` if it is a non-empty string parseable by `Date.parse`, else `null`. */
function validIso(s: unknown): string | null {
  if (typeof s !== 'string' || !s) {
    return null;
  }
  return Number.isNaN(Date.parse(s)) ? null : s;
}

/**
 * The default `CLAUDE_CONFIG_DIR`: `process.env.CLAUDE_CONFIG_DIR` when set,
 * otherwise `~/.claude`. Exposed so callers can display or reuse it.
 */
export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Human-readable label for a window kind, matching the `/usage` UI:
 * `session` → `'Session (5hr)'`, `weekly_all` → `'Weekly (7 day)'`,
 * `weekly_scoped` → `'Weekly (model-scoped)'`.
 */
export function defaultWindowLabel(kind: UsageWindowKind): string {
  return WINDOW_LABELS[kind];
}

/** Map the `get_usage` payload to our normalized, ordered windows. Never throws. */
function parseWindows(data: Record<string, unknown>): UsageWindow[] {
  const rl = isRecord(data.rate_limits) ? data.rate_limits : {};
  const out: Partial<Record<UsageWindowKind, UsageWindow>> = {};

  // Preferred source: the normalized limits[] array (the only place weekly_scoped appears).
  const limits = Array.isArray(rl.limits) ? rl.limits : [];
  for (const entry of limits) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = entry.kind;
    if (kind === 'session' || kind === 'weekly_all' || kind === 'weekly_scoped') {
      out[kind] = {
        kind,
        percent: clampPercent(entry.percent),
        severity: typeof entry.severity === 'string' && entry.severity ? entry.severity : 'normal',
        resetsAt: validIso(entry.resets_at),
      };
    }
  }

  // Fallback for older builds that only populate the top-level window objects.
  // Only fills a kind absent from limits[], and only when utilization is a number.
  const fromTop = (kind: UsageWindowKind, key: string): void => {
    if (out[kind]) {
      return;
    }
    const w = rl[key];
    if (isRecord(w) && typeof w.utilization === 'number') {
      out[kind] = {
        kind,
        percent: clampPercent(w.utilization),
        severity: 'normal',
        resetsAt: validIso(w.resets_at),
      };
    }
  };
  fromTop('session', 'five_hour');
  fromTop('weekly_all', 'seven_day');

  return WINDOW_ORDER.map((k) => out[k]).filter((w): w is UsageWindow => w !== undefined);
}

/**
 * Read `rate_limits.extra_usage`. Upstream is experimental and every field may be
 * null, so anything unreadable degrades to `null` rather than a misleading zero.
 * Amounts arrive in MINOR units: `used_credits: 0, monthly_limit: 5000,
 * decimal_places: 2` means $0.00 spent of a $50.00 cap → `used: 0, cap: 50`.
 */
function parseExtraUsage(data: Record<string, unknown>): ExtraUsage | null {
  const rl = isRecord(data.rate_limits) ? data.rate_limits : {};
  const eu = rl.extra_usage;
  if (!isRecord(eu)) {
    return null;
  }
  const percent =
    typeof eu.utilization === 'number' && Number.isFinite(eu.utilization)
      ? clampPercent(eu.utilization)
      : null;
  // decimal_places is honored only when a plausible integer 0..6; otherwise default 2.
  const rawDp = eu.decimal_places;
  const dp =
    typeof rawDp === 'number' && Number.isInteger(rawDp) && rawDp >= 0 && rawDp <= 6 ? rawDp : 2;
  const toMajor = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v / Math.pow(10, dp) : null;
  const currency = typeof eu.currency === 'string' && eu.currency ? eu.currency : 'USD';
  return {
    enabled: eu.is_enabled === true,
    percent,
    used: toMajor(eu.used_credits),
    cap: toMajor(eu.monthly_limit),
    currency,
  };
}

/**
 * Pure, total parser over the `get_usage` `<data>` payload. NEVER throws for any
 * input: `null`, a string, an array, or deeply wrong types all degrade to
 * `available:false` with empty windows and null fields.
 *
 * @param data The raw `get_usage` response payload (`unknown` by design).
 * @returns The normalized fields of a {@link LiveUsage} (without `fetchedAt`,
 *   `raw`, or `error`).
 */
export function parseLiveUsage(
  data: unknown,
): Pick<LiveUsage, 'available' | 'subscriptionType' | 'windows' | 'sessionCostUsd' | 'extraUsage'> {
  const obj = isRecord(data) ? data : {};
  const session = isRecord(obj.session) ? obj.session : {};
  return {
    available: obj.rate_limits_available === true,
    subscriptionType: typeof obj.subscription_type === 'string' ? obj.subscription_type : null,
    windows: parseWindows(obj),
    sessionCostUsd: typeof session.total_cost_usd === 'number' ? session.total_cost_usd : null,
    extraUsage: parseExtraUsage(obj),
  };
}

/**
 * Validate an optional `timeoutMs` and return the effective value.
 *
 * @throws {TypeError} when `timeoutMs` is present but not a finite number > 0.
 */
function resolveTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a finite number > 0, received ${String(timeoutMs)}`);
  }
  return timeoutMs;
}

/**
 * Spawn one probe and resolve a {@link LiveUsage}. NEVER rejects: spawn throw,
 * spawn 'error', timeout, non-success response, close-without-response and
 * unparseable output all resolve with `error` set. `timeoutMs` is assumed
 * already validated by {@link resolveTimeout}.
 */
function probe(options: LiveUsageOptions, timeoutMs: number): Promise<LiveUsage> {
  return new Promise((resolve) => {
    const configDir = options.configDir ?? defaultConfigDir();
    const claudePath = options.claudePath ?? 'claude';
    // A neutral cwd (os.tmpdir()) is REQUIRED so no project .mcp.json is loaded.
    const cwd = options.cwd ?? os.tmpdir();

    // Every failure path funnels through here so the shape is identical and honest.
    const fail = (error: string): LiveUsage => ({
      available: false,
      subscriptionType: null,
      windows: [],
      sessionCostUsd: null,
      extraUsage: null,
      fetchedAt: Date.now(),
      raw: null,
      error,
    });

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(
        claudePath,
        ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        {
          cwd,
          // options.env is merged in, but CLAUDE_CONFIG_DIR is always ours.
          env: { ...process.env, ...options.env, CLAUDE_CONFIG_DIR: configDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (e) {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve(fail(`spawn failed: ${(e as Error).message}`));
      return;
    }

    child.stdin.on('error', () => {
      /* EPIPE when the child died first; the settle path handles the outcome */
    });

    let settled = false;
    let sent = false;
    let buf = '';
    let stderr = '';

    // Single settle path: clears every timer and kills the child exactly once.
    const done = (result: LiveUsage): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(result);
    };

    const timer = setTimeout(() => done(fail('timeout')), timeoutMs);

    const sendRequest = (): void => {
      if (sent) {
        return;
      }
      sent = true;
      try {
        child.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: 'u1',
            request: { subtype: 'get_usage' },
          }) + '\n',
        );
      } catch {
        // stdin closed — the close handler will settle with an error
      }
    };
    // Send once the process is up: on the first output line, else after a short fallback delay.
    const sendTimer = setTimeout(sendRequest, 800);

    const handleLine = (line: string): void => {
      if (!line.trim()) {
        return;
      }
      sendRequest();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type !== 'control_response') {
        return;
      }
      clearTimeout(sendTimer);
      const resp = isRecord(msg.response) ? msg.response : {};
      if (resp.subtype !== 'success') {
        done(fail(`control_response ${String(resp.subtype ?? 'error')}`));
        return;
      }
      const data = resp.response;
      done({ ...parseLiveUsage(data), fetchedAt: Date.now(), raw: data });
    };

    // setEncoding keeps a multi-byte UTF-8 sequence from being split across chunk
    // boundaries into replacement characters, which would corrupt a JSON line.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      // A well-behaved stream-json child emits newline-terminated lines. If a
      // megabyte arrives with no newline at all, the output is not what we expect
      // and no amount of further buffering will produce a parseable line — drop it
      // and let the timeout / close path settle with an honest error.
      if (buf.length > MAX_LINE_BUFFER_BYTES) {
        buf = '';
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(sendTimer);
      done(fail(`spawn failed: ${e.message}`));
    });
    child.on('close', () => {
      clearTimeout(sendTimer);
      done(fail(stderr.trim() ? `claude exited: ${stderr.slice(0, 200)}` : 'no response'));
    });
  });
}

/**
 * Probe live claude.ai plan usage for one account by spawning the Claude CLI and
 * issuing a single `get_usage` control request.
 *
 * Resolves a {@link LiveUsage} in EVERY case — it never rejects and never throws
 * for environmental failures (missing binary, timeout, garbage output, killed
 * process); those resolve with `error` set. Remember that `available:false` with
 * `error===undefined` is a valid "no plan limits" state, not a failure.
 *
 * @param options See {@link LiveUsageOptions}.
 * @returns A promise resolving to the reading.
 * @throws {TypeError} synchronously when `options.timeoutMs` is present but not a
 *   finite number greater than 0 (a programmer error).
 */
export function getLiveUsage(options: LiveUsageOptions = {}): Promise<LiveUsage> {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  return probe(options, timeoutMs);
}

/**
 * Probe live usage for several accounts with bounded concurrency, preserving the
 * INPUT ORDER of `accounts` in the result array and attaching each account's
 * `name` and `configDir` to its reading. Like {@link getLiveUsage}, individual
 * probes never reject; each slot resolves to a reading (possibly with `error`).
 *
 * @param accounts Accounts to probe; each supplies a display `name` and a
 *   `configDir` to probe under.
 * @param options Per-probe {@link LiveUsageOptions} plus an optional
 *   `concurrency` (default 3, clamped to at least 1). Any `configDir` in
 *   `options` is overridden per account.
 * @returns A promise resolving to one reading per account, in input order.
 * @throws {TypeError} synchronously when `accounts` is not an array, when any
 *   `accounts[i]` is not an object with string `name` and string `configDir`, or
 *   when `options.timeoutMs` is present but not a finite number greater than 0.
 */
export function getLiveUsageForAccounts(
  accounts: ReadonlyArray<{ name: string; configDir: string }>,
  options: LiveUsageOptions & { concurrency?: number } = {},
): Promise<Array<LiveUsage & { name: string; configDir: string }>> {
  if (!Array.isArray(accounts)) {
    throw new TypeError('accounts must be an array');
  }
  // Validate every element up front, before starting any runner.
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i] as unknown;
    if (
      account === null ||
      typeof account !== 'object' ||
      typeof (account as Record<string, unknown>).name !== 'string' ||
      typeof (account as Record<string, unknown>).configDir !== 'string'
    ) {
      throw new TypeError(`accounts[${i}] must be { name: string, configDir: string }`);
    }
  }
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const rawC = options.concurrency;
  const concurrency = Math.max(
    1,
    typeof rawC === 'number' && Number.isFinite(rawC) ? Math.floor(rawC) : DEFAULT_CONCURRENCY,
  );
  return runAccounts(accounts, options, timeoutMs, concurrency);
}

/** Shared-cursor bounded-concurrency runner. Writes results by index to preserve order. */
async function runAccounts(
  accounts: ReadonlyArray<{ name: string; configDir: string }>,
  options: LiveUsageOptions,
  timeoutMs: number,
  concurrency: number,
): Promise<Array<LiveUsage & { name: string; configDir: string }>> {
  const results: Array<LiveUsage & { name: string; configDir: string }> = new Array(
    accounts.length,
  );
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < accounts.length) {
      const idx = cursor++;
      const account = accounts[idx];
      if (account === undefined) {
        continue; // unreachable: cursor < length guarantees an element; satisfies noUncheckedIndexedAccess
      }
      const usage = await probe({ ...options, configDir: account.configDir }, timeoutMs);
      results[idx] = { ...usage, name: account.name, configDir: account.configDir };
    }
  };
  const runnerCount = Math.min(concurrency, accounts.length);
  await Promise.all(Array.from({ length: runnerCount }, runner));
  return results;
}

/**
 * Carry a previous good windows reading forward when a fresh probe returns no
 * windows but the plan is still available.
 *
 * `get_usage` intermittently returns `rate_limits: null` while
 * `rate_limits_available` stays true — a fresh but empty reading. Rather than
 * blank the UI, the last good windows (and the overage / subscription state that
 * vanish with them) are carried forward, marked stale, for up to `maxAgeMs`.
 * After that the account falls to the honest "no windows" state.
 *
 * Pure: does not mutate its arguments. Guards NaN / non-finite instants.
 *
 * @param fresh The latest reading.
 * @param prev The previous merged reading, if any.
 * @param maxAgeMs Maximum age of carried windows in ms (default 30 minutes).
 * @returns A {@link MergedLiveUsage}: fresh windows when present; otherwise
 *   carried windows (`windowsStale:true`) when eligible; otherwise fresh
 *   unchanged (`windowsStale:false`).
 */
export function mergeStaleWindows(
  fresh: LiveUsage,
  prev?: MergedLiveUsage,
  maxAgeMs: number = DEFAULT_STALE_WINDOW_MAX_MS,
): MergedLiveUsage {
  if (fresh.windows.length > 0) {
    return { ...fresh, windowsFetchedAt: fresh.fetchedAt, windowsStale: false };
  }

  const prevWindows = prev && Array.isArray(prev.windows) ? prev.windows : [];
  const prevAt = prev ? (prev.windowsFetchedAt ?? prev.fetchedAt) : undefined;
  const freshAt = fresh.fetchedAt;
  const withinWindow =
    typeof prevAt === 'number' &&
    Number.isFinite(prevAt) &&
    typeof freshAt === 'number' &&
    Number.isFinite(freshAt) &&
    freshAt - prevAt >= 0 &&
    freshAt - prevAt <= maxAgeMs;

  // Only paper over the specific "available, no windows, no probe error" gap.
  if (fresh.available && fresh.error === undefined && prevWindows.length > 0 && withinWindow) {
    return {
      ...fresh,
      windows: prevWindows,
      // extraUsage / subscriptionType disappear together with rate_limits — keep last known.
      extraUsage: fresh.extraUsage ?? prev!.extraUsage,
      subscriptionType: fresh.subscriptionType ?? prev!.subscriptionType,
      windowsStale: true,
      windowsFetchedAt: prevAt,
    };
  }

  return { ...fresh, windowsStale: false };
}
