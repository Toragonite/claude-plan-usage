import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as os from 'node:os';
import { defaultConfigDir } from './live';

/**
 * Authentication state of a Claude Code config directory, read via the CLI's
 * `auth status --json` subcommand.
 *
 * This exists to disambiguate a reading the live-usage probe CANNOT resolve on
 * its own. `getLiveUsage` returning `available:false` with no `error` has two
 * completely different causes that produce an identical payload:
 *
 * 1. the account authenticates with an API key or setup token, so it genuinely
 *    has no claude.ai plan rate limits to report; or
 * 2. the account IS a subscription login, but that login has expired or been
 *    logged out, so the CLI cannot report the plan limits it would otherwise
 *    have.
 *
 * The first is a normal steady state; the second needs a human to re-login.
 * `auth status` separates them: an API-key account reports `loggedIn:true` with
 * an `api_key`-family `authMethod`, while an expired or absent login reports
 * `loggedIn:false` with `authMethod:'none'`. {@link classifyAccount} folds a
 * usage reading and an auth reading into a single verdict.
 *
 * Like {@link getLiveUsage}, {@link getAuthStatus} resolves in EVERY case and
 * never rejects for environmental failure; only invalid options you pass in (a
 * programmer error) throw a `TypeError`.
 *
 * Zero runtime dependencies: Node built-ins only (`child_process`, `os`).
 */

/**
 * A single normalized auth reading.
 *
 * On failure, `error` is set and `loggedIn` is `false` with every other field
 * `null` — an errored reading asserts nothing about the account. Unlike
 * {@link LiveUsage}, there is no valid "everything null, no error" state: a
 * successful probe always yields at least `loggedIn` and `authMethod`.
 */
export interface AuthStatus {
  /** True when the config dir holds a usable login (subscription OR API key/token). */
  loggedIn: boolean;
  /**
   * How the CLI authenticates: `'claude.ai'` for a subscription login,
   * `'api_key'` / `'api_key_helper'` for key-based auth, `'none'` when logged
   * out. `null` when upstream reported no string value.
   */
  authMethod: string | null;
  /** API provider (`'firstParty'`, …), or `null` when not reported. */
  apiProvider: string | null;
  /**
   * Where a key-based credential came from (`'ANTHROPIC_API_KEY'`,
   * `'apiKeyHelper'`, …). `null` for subscription and logged-out accounts.
   */
  apiKeySource: string | null;
  /** Account email for a subscription login; `null` when logged out or key-based. */
  email: string | null;
  /** claude.ai plan (`'max'`, `'pro'`, …) or `null` when not exposed. */
  subscriptionType: string | null;
  /** The raw `auth status --json` payload on success, or `null` on error. */
  raw: unknown;
  /** Epoch milliseconds when this reading was taken (`Date.now()` at settle time). */
  fetchedAt: number;
  /**
   * Set ONLY when the probe itself failed (spawn failure, timeout, unparseable
   * output, process closed with no output). When set, treat every other field
   * as unknown rather than as evidence.
   */
  error?: string;
}

/** Options for a single auth-status probe. */
export interface AuthStatusOptions {
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
}

/**
 * What kind of account a config dir holds, as judged by {@link classifyAccount}.
 *
 * - `subscription` — a claude.ai plan with rate limits to report.
 * - `token` — an API-key / setup-token login; no plan limits exist, by design.
 * - `logged_out` — no usable login; plan limits are missing because auth is gone.
 * - `unknown` — the evidence needed to decide was missing or errored.
 */
export type AccountKind = 'subscription' | 'token' | 'logged_out' | 'unknown';

/** Default probe timeout, matching the live-usage probe. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Hard cap on collected stdout. `auth status --json` emits a few hundred bytes;
 * anything approaching 64 KB means the process is not the CLI we expect, and the
 * cap keeps a runaway child from growing the buffer without bound.
 */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** True for a plain (non-array, non-null) object. Used to gate every defensive read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field as a string, degrading anything else (including absence) to `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Pure, total parser over the `auth status --json` payload. NEVER throws for any
 * input: `null`, a string, an array, or deeply wrong types all degrade to
 * `loggedIn:false` with every other field `null`.
 *
 * Degrading to `loggedIn:false` is deliberate: a payload we cannot read is not
 * evidence of a working login. Callers that need to distinguish "parsed as
 * logged out" from "could not parse" should check `AuthStatus.error`, which the
 * spawning path sets.
 *
 * @param data The raw `auth status --json` payload (`unknown` by design).
 * @returns The normalized fields of an {@link AuthStatus} (without `raw`,
 *   `fetchedAt`, or `error`).
 */
export function parseAuthStatus(
  data: unknown,
): Pick<
  AuthStatus,
  'loggedIn' | 'authMethod' | 'apiProvider' | 'apiKeySource' | 'email' | 'subscriptionType'
> {
  const obj = isRecord(data) ? data : {};
  return {
    loggedIn: obj.loggedIn === true,
    authMethod: str(obj.authMethod),
    apiProvider: str(obj.apiProvider),
    apiKeySource: str(obj.apiKeySource),
    email: str(obj.email),
    subscriptionType: str(obj.subscriptionType),
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
 * Extract the outermost JSON object from CLI output and parse it. The CLI may
 * prefix stdout with an update notice or similar chatter, so the payload is
 * taken as the span from the first `{` to the last `}`. Returns `undefined` when
 * no such span exists or it does not parse. `JSON.parse` never yields
 * `undefined`, so `undefined` unambiguously means "no payload".
 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Spawn one `auth status --json` probe and resolve an {@link AuthStatus}. NEVER
 * rejects: spawn throw, spawn 'error', timeout, unparseable output and
 * close-without-output all resolve with `error` set. `timeoutMs` is assumed
 * already validated by {@link resolveTimeout}.
 */
function probe(options: AuthStatusOptions, timeoutMs: number): Promise<AuthStatus> {
  return new Promise((resolve) => {
    const configDir = options.configDir ?? defaultConfigDir();
    const claudePath = options.claudePath ?? 'claude';

    // Every failure path funnels through here so the shape is identical and honest.
    const fail = (error: string): AuthStatus => ({
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      apiKeySource: null,
      email: null,
      subscriptionType: null,
      raw: null,
      fetchedAt: Date.now(),
      error,
    });

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(claudePath, ['auth', 'status', '--json'], {
        // A neutral cwd (os.tmpdir()) is REQUIRED so no project .mcp.json is loaded.
        cwd: os.tmpdir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        // stdin is ignored: this subcommand reads nothing and must never block on it.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn can throw synchronously for a pathological claudePath — never reject.
      resolve(fail(`spawn failed: ${(e as Error).message}`));
      return;
    }

    let settled = false;
    let out = '';
    let stderr = '';

    // Single settle path: clears the timer and kills the child exactly once.
    const done = (result: AuthStatus): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(result);
    };

    /**
     * Settle from whatever output arrived. A complete payload can be on stdout
     * even when the process is about to be killed for timing out, so both the
     * close and timeout paths try to parse before reporting `fallbackError`.
     */
    const settleFromOutput = (fallbackError: string): void => {
      const data = extractJson(out);
      if (data === undefined) {
        done(fail(stderr.trim() ? `claude exited: ${stderr.slice(0, 200)}` : fallbackError));
        return;
      }
      done({ ...parseAuthStatus(data), raw: data, fetchedAt: Date.now() });
    };

    const timer = setTimeout(() => settleFromOutput('timeout'), timeoutMs);

    // setEncoding keeps a multi-byte UTF-8 sequence (an accented name, say) from
    // being split across chunk boundaries into replacement characters.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      // Cap AFTER appending so a single oversized chunk cannot overshoot.
      if (out.length > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
      }
    });
    child.on('error', (e) => done(fail(`spawn failed: ${e.message}`)));
    child.on('close', () => settleFromOutput('no response'));
  });
}

/**
 * Read the authentication state of one config dir by spawning
 * `claude auth status --json`.
 *
 * Resolves an {@link AuthStatus} in EVERY case — it never rejects and never
 * throws for environmental failures (missing binary, timeout, garbage output,
 * killed process); those resolve with `error` set. Reads no credentials itself:
 * the spawned CLI inspects its own config dir and reports a summary.
 *
 * @param options See {@link AuthStatusOptions}.
 * @returns A promise resolving to the reading.
 * @throws {TypeError} synchronously when `options.timeoutMs` is present but not a
 *   finite number greater than 0 (a programmer error).
 */
export function getAuthStatus(options: AuthStatusOptions = {}): Promise<AuthStatus> {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  return probe(options, timeoutMs);
}

/**
 * Fold a live-usage reading and an auth reading into one account verdict.
 *
 * Pure and total: any combination of `null`, `undefined`, and partial objects is
 * accepted. The rules, in order:
 *
 * 1. `usage.available === true` → `'subscription'`. Plan limits came back, so the
 *    account demonstrably has a plan; this wins over anything auth says.
 * 2. otherwise a trustworthy auth reading (present, `error === undefined`) decides:
 *    `loggedIn:true` → `'token'` (logged in yet no plan limits ⇒ key/token auth),
 *    `loggedIn:false` → `'logged_out'`.
 * 3. otherwise → `'unknown'`.
 *
 * BIASED TOWARD `'unknown'` ON PURPOSE. When the auth evidence is missing or
 * errored, this reports `'unknown'` rather than guessing `'token'` — guessing is
 * exactly the bug this function exists to fix, since a guess of "token account"
 * silently hides an expired subscription login that a human needs to renew.
 *
 * @param usage A {@link LiveUsage}-shaped reading, or `null`/`undefined` when none was taken.
 * @param auth An {@link AuthStatus}-shaped reading, or `null`/`undefined` when none was taken.
 * @returns The account verdict; see {@link AccountKind}.
 */
export function classifyAccount(
  usage: { available: boolean; error?: string } | null | undefined,
  auth: { loggedIn: boolean; error?: string } | null | undefined,
): AccountKind {
  if (usage?.available === true) {
    return 'subscription';
  }
  if (auth && auth.error === undefined) {
    return auth.loggedIn === true ? 'token' : 'logged_out';
  }
  return 'unknown';
}
