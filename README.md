# claude-plan-usage

Read your Claude Code plan quota and historical token/cost burn as structured data — from Node, or from the command line.

## Why

Multi-agent orchestrators, dashboards, and cost-tracking scripts need to know two things: *how much plan quota is left right now*, and *what got burned over time*. Claude Code's interactive `/usage` screen and transcript files hold that data, but nothing exposes it as JSON. `claude-plan-usage` does both:

- **Live plan usage** — the same session/weekly rate-limit data the `/usage` screen shows, fetched by talking to your local `claude` CLI.
- **Transcript usage aggregation** — token counts and cost, computed from your local session transcripts, grouped however you like.

No credentials are read or handled by this library — Claude Code authenticates itself. This package makes no network calls of its own; it only spawns a local process and reads local files.

## Install

```sh
npm install claude-plan-usage
```

Requires **Node >= 18.17**. The live-usage part additionally requires the `claude` CLI (Claude Code) to be installed and reachable on `PATH` (or pointed at via `claudePath`). The transcript-aggregation part works without the CLI installed — it only reads local transcript files.

Ships as dual ESM/CJS with bundled TypeScript types, and has **zero runtime dependencies**.

## Quick start — library

### Live plan usage

```ts
import { getLiveUsage, defaultWindowLabel } from 'claude-plan-usage';

const usage = await getLiveUsage();

if (!usage.available) {
  // No plan limits. That is either a key/token account or a dead login — see
  // "Which account is this?" for how to tell, with classifyAccount.
  console.log(usage.error ?? 'No plan rate limits reported for this account.');
} else {
  for (const w of usage.windows) {
    console.log(`${defaultWindowLabel(w.kind)}: ${w.percent}% (${w.severity})`);
  }
  console.log('Subscription:', usage.subscriptionType, '— session cost: $' + usage.sessionCostUsd);
}
```

### Transcript usage, last 30 days, by model

```ts
import { getTranscriptUsage } from 'claude-plan-usage';

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const report = await getTranscriptUsage({ groupBy: 'model', since });

for (const bucket of report.buckets) {
  console.log(`${bucket.key}: ${bucket.entryCount} calls, $${bucket.costUsd.toFixed(2)}`);
}
console.log('Total: $' + report.totals.costUsd.toFixed(2));
```

## Quick start — CLI

```sh
npx claude-plan-usage
```

Prints live usage for the default config dir, followed by a last-7-days daily transcript table. For a subscription account the live block looks like:

```
~/.claude
  Session (5hr)   ██░░░░░░░░░░░░░░░░░░   12%  resets in 0.2h
  Weekly (7 day)  █░░░░░░░░░░░░░░░░░░░    3%  resets in 6.8d
  Weekly (model-scoped)  █░░░░░░░░░░░░░░░░░░░    3%  resets in 6.8d
  subscription: max
  overage: ON  $0.00/$50.00 USD (0%)
```

An account with no plan limits — a key/token login, *or* a subscription whose login expired — looks like this:

```
~/.claude
  no plan limits (token account or logged-out login — run with --auth)
```

`--auth` says which of the two it is, by adding an auth line to every account:

```
~/.claude
  no plan limits (token account or logged-out login — run with --auth)
  auth: none · logged_out
```

Transcript aggregation (`--transcripts-only --group-by model --since 2026-07-07`):

```
Key                            Input     Output      CacheW         CacheR      Cost  Entries
claude-opus-4-8              755,517  2,915,853  23,829,291    709,396,295   $665.51    2,371
claude-sonnet-5               21,752     11,350     561,614      5,742,434     $4.06       89
TOTAL                        777,269  2,927,203  24,390,905    715,138,729   $669.57    2,460
files scanned 992 · entries 25153 · skipped 14 · duplicates 31369
```

Other useful invocations:

```sh
# Machine-readable output
claude-plan-usage --json

# Only the live probe, no transcript scan
claude-plan-usage --live-only

# Live probe plus the auth method and account-kind verdict for each account
claude-plan-usage --live-only --auth

# Only transcripts, grouped by project, for a specific month
claude-plan-usage --transcripts-only --group-by project --since 2026-06-01 --until 2026-06-30

# Probe a second account
claude-plan-usage --config-dir ~/.claude --config-dir ~/.claude-work --json
```

### CLI flags

| Flag | Description |
| --- | --- |
| `--json` | Emit machine-readable JSON instead of formatted text. |
| `--live-only` | Skip transcript aggregation; only run the live usage probe. |
| `--auth` | Also probe each account's auth status; adds an `auth: <method> · <kind>` line to the live block, and an `auth` object plus a `kind` field to each account in `--json` output. Cannot be combined with `--transcripts-only`, which runs no live block to annotate. |
| `--transcripts-only` | Skip the live usage probe; only aggregate transcripts. |
| `--group-by <day\|month\|session\|model\|project\|total>` | Grouping for the transcript table. |
| `--since YYYY-MM-DD` | Only include transcript entries on/after this date. |
| `--until YYYY-MM-DD` | Only include transcript entries on/before this date. |
| `--config-dir <path>` | Config dir to use (repeatable — repeat for multi-account probing). |
| `--claude-path <path>` | Path to the `claude` binary, if not on `PATH`. |
| `--timeout <ms>` | Timeout for the live usage probe. |
| `--cost-mode <auto\|calculate\|display>` | How transcript cost is derived — see [CostMode](#costmode). |
| `--no-color` | Disable colored output (also respects the `NO_COLOR` env var). |
| `-h` | Show help. |
| `-v` | Show version. |

**Exit codes:** `0` success (an unavailable or failed live probe is still a successfully reported state — exit `0`), `1` usage error (bad flags/arguments), `2` internal error.

## How it works

### Live usage: control-protocol probe

`getLiveUsage` spawns the locally-installed `claude` CLI headlessly under the given `CLAUDE_CONFIG_DIR` and issues a `get_usage` control-protocol request over its stdio channel — the same request Claude Code's own `/usage` screen uses internally. No credentials are read by this library; the spawned `claude` process authenticates itself using whatever session already exists under that config dir.

A few guarantees worth knowing before you build on this:

- **Experimental upstream shape.** `get_usage` is an experimental, internal control-protocol response per Claude Code's own documentation — its fields are not a stable public contract. Every field is parsed defensively; anything the parser can't confidently make sense of degrades to `available: false` rather than throwing. The full, unprocessed response is always available on `LiveUsage.raw`, so you can inspect or adapt to shape changes yourself.
- **Never throws for environmental failure.** `getLiveUsage` and `getLiveUsageForAccounts` never reject because of a missing `claude` binary, a timeout, a spawn failure, or a malformed response — all of those surface through the `error` field on the result. Only invalid *options* you pass in (a programmer error) throw a `TypeError`.
- **`available: false` is not necessarily a failure — but it is ambiguous.** `available: false` with no `error` set means the probe succeeded and the account reported no plan rate limits. `error` being set means the probe itself broke. Two *very* different accounts produce that same no-limits reading, and the usage probe cannot tell you which one you have: an API-key/token login that has no plan limits by design, and a subscription login that has **expired or been logged out**. The first is a normal steady state; the second needs a human to log back in. Use [`getAuthStatus`](#getauthstatusoptions-authstatusoptions-promiseauthstatus) and [`classifyAccount`](#classifyaccountusage-auth-accountkind) to separate them — see [Which account is this?](#which-account-is-this).
- **Stale windows.** Upstream `rate_limits` can intermittently come back empty even for accounts that do have plan limits. `mergeStaleWindows(fresh, prev?, maxAgeMs?)` is a pure, I/O-free helper that lets you carry the last known-good windows forward from a previous `MergedLiveUsage`, marked `windowsStale: true`, for up to `maxAgeMs` (default: 30 minutes).

### Which account is this?

`getAuthStatus` spawns `claude auth status --json` under a config dir and normalizes the result. It reads no credentials itself — the CLI inspects its own config dir and reports a summary. These are the four states you will actually see:

| Config dir | `loggedIn` | `authMethod` | Other fields | Live usage reads |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` in the environment | `true` | `api_key` | `apiKeySource: 'ANTHROPIC_API_KEY'` | `available: false` |
| `apiKeyHelper` in settings | `true` | `api_key_helper` | `apiKeySource: 'apiKeyHelper'` | `available: false` |
| Healthy subscription login | `true` | `claude.ai` | `email`, `subscriptionType` | `available: true` |
| Expired login, or never logged in | `false` | `none` | no `email` | `available: false` |

The bottom three rows all read `available: false` from the usage probe alone; only `loggedIn` separates a working key-based account from a dead login. `classifyAccount` folds both readings into one verdict:

```ts
import { getLiveUsage, getAuthStatus, classifyAccount } from 'claude-plan-usage';

const [usage, auth] = await Promise.all([getLiveUsage(), getAuthStatus()]);

switch (classifyAccount(usage, auth)) {
  case 'subscription':
    console.log(`plan ${usage.subscriptionType}, ${usage.windows.length} windows`);
    break;
  case 'token':
    console.log('API key / setup token — no plan limits exist for this account');
    break;
  case 'logged_out':
    console.log('login expired or absent — run `claude` and log in again');
    break;
  case 'unknown':
    console.log('not enough evidence to say — see usage.error / auth.error');
    break;
}
```

`classifyAccount` is deliberately biased toward `'unknown'`: when the auth reading is missing or carries an `error`, it refuses to guess rather than reporting `'token'`. Guessing is the whole bug — a wrong guess of "token account" hides an expired login behind a state that looks normal.

### Transcript scanning

`getTranscriptUsage` stream-parses every `<configDir>/projects/**/*.jsonl` file (across each dir in `configDirs`), extracting per-request token usage and cost, then aggregates it into buckets by day, month, session, model, project, or a single `total`.

- **Deduplication.** Resuming a Claude Code session can produce duplicate usage entries across transcript writes; these are detected and skipped, and the count is reported in `duplicatesSkipped` rather than silently double-counting cost.
- **Pricing.** Cost is computed against an embedded pricing snapshot (`DEFAULT_PRICING`), fully overridable via the `pricing` option. `costMode` controls whether recorded per-entry costs are trusted (`'display'`), always recomputed (`'calculate'`), or recorded-cost-when-present-else-computed (`'auto'`, the default behavior for the CLI).
- **Malformed input never throws.** Lines that fail to parse are counted in `entriesSkipped`, not thrown. Unknown models are aggregated with `costUsd: 0` plus an entry in `warnings` — the scan always completes and returns a report.

## API reference

### Live usage

#### `getLiveUsage(options?: LiveUsageOptions): Promise<LiveUsage>`

Runs the control-protocol probe once and resolves with the result. Never rejects for environmental failure — see [How it works](#live-usage-control-protocol-probe).

#### `getLiveUsageForAccounts(accounts, options?): Promise<Array<LiveUsage & { name: string; configDir: string }>>`

Runs the probe against multiple accounts (multiple config dirs) with bounded concurrency, useful for multi-account orchestrators. `accounts` is `ReadonlyArray<{ name: string; configDir: string }>`. `options` is `LiveUsageOptions & { concurrency?: number }` — `configDir` on `options` is ignored per-account since each account supplies its own. Each result in the returned array carries its originating `name` and `configDir` alongside the usual `LiveUsage` fields.

#### `parseLiveUsage(data: unknown): Pick<LiveUsage, 'available' | 'subscriptionType' | 'windows' | 'sessionCostUsd' | 'extraUsage'>`

Pure parsing function: turns a raw `get_usage` response payload into the parsed subset of `LiveUsage` fields, without spawning any process. Useful for testing against captured payloads or reprocessing `LiveUsage.raw`.

#### `mergeStaleWindows(fresh: LiveUsage, prev?: MergedLiveUsage, maxAgeMs?: number): MergedLiveUsage`

Pure helper (no I/O). If `fresh.windows` is non-empty, returns `fresh` as a `MergedLiveUsage` with `windowsStale: false`. If `fresh.windows` is empty and `prev` exists and is within `maxAgeMs` (default 30 minutes / `1_800_000`), returns `prev`'s windows carried forward with `windowsStale: true` and the original `windowsFetchedAt` preserved.

#### `defaultWindowLabel(kind: UsageWindowKind): string`

Maps a window kind to a human-readable label: `'session'` → `'Session (5hr)'`, `'weekly_all'` → `'Weekly (7 day)'`, `'weekly_scoped'` → `'Weekly (model-scoped)'`.

#### `defaultConfigDir(): string`

Returns `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.

#### `LiveUsageOptions`

| Field | Type | Description |
| --- | --- | --- |
| `configDir?` | `string` | Config dir to probe. Defaults to `defaultConfigDir()`. |
| `claudePath?` | `string` | Path to the `claude` binary. Defaults to resolving `claude` from `PATH`. |
| `timeoutMs?` | `number` | Timeout for the probe. |
| `env?` | `Record<string, string \| undefined>` | Extra environment variables passed to the spawned process. |
| `cwd?` | `string` | Working directory for the spawned process. |

#### `LiveUsage`

| Field | Type | Description |
| --- | --- | --- |
| `available` | `boolean` | Whether plan rate-limit data is available for this account. |
| `subscriptionType` | `string \| null` | The account's subscription tier, as reported upstream. |
| `windows` | `UsageWindow[]` | The parsed rate-limit windows. |
| `sessionCostUsd` | `number \| null` | Cost of the current session, in USD, as reported upstream. |
| `extraUsage` | `ExtraUsage \| null` | Overage ("extra usage") billing state. |
| `fetchedAt` | `number` | Epoch milliseconds when this result was produced. |
| `raw` | `unknown` | The unprocessed upstream payload. |
| `error?` | `string` | Set only when the probe itself failed (see [available vs. error](#live-usage-control-protocol-probe)). |

#### `UsageWindow`

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `UsageWindowKind` | `'session' \| 'weekly_all' \| 'weekly_scoped'`. |
| `percent` | `number` | Utilization percentage for this window. |
| `severity` | `string` | Upstream-reported severity label for this utilization level. |
| `resetsAt` | `string \| null` | ISO timestamp when this window resets, if known. |

#### `ExtraUsage`

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Whether overage ("extra usage") billing is enabled on the account. |
| `percent` | `number \| null` | Percentage of the overage cap consumed. |
| `used` | `number \| null` | Amount of overage consumed. |
| `cap` | `number \| null` | Overage cap. |
| `currency` | `string` | Currency code for `used`/`cap`. |

#### `MergedLiveUsage`

Extends `LiveUsage` with:

| Field | Type | Description |
| --- | --- | --- |
| `windowsStale?` | `boolean` | `true` when `windows` was carried forward from a previous result by `mergeStaleWindows`. |
| `windowsFetchedAt?` | `number` | Epoch milliseconds when the (possibly carried-forward) `windows` were originally fetched. |

### Auth status

#### `getAuthStatus(options?: AuthStatusOptions): Promise<AuthStatus>`

Reads the authentication state of one config dir by spawning `claude auth status --json`. Never rejects for environmental failure (missing binary, timeout, garbage output) — those resolve with `error` set and every other field at its empty value. Only an invalid `timeoutMs` throws a `TypeError`, synchronously.

#### `parseAuthStatus(data: unknown): Pick<AuthStatus, 'loggedIn' | 'authMethod' | 'apiProvider' | 'apiKeySource' | 'email' | 'subscriptionType'>`

Pure parsing function: turns a raw `auth status --json` payload into the parsed subset of `AuthStatus` fields, without spawning any process. Total — non-objects and malformed shapes degrade to `loggedIn: false` with `null` everywhere else rather than throwing.

#### `classifyAccount(usage, auth): AccountKind`

Pure helper (no I/O). Folds a `LiveUsage`-shaped reading and an `AuthStatus`-shaped reading into one verdict; both arguments accept `null` / `undefined`. The rules, in order: `usage.available === true` → `'subscription'`; else a trustworthy auth reading (present, no `error`) decides `'token'` when `loggedIn` and `'logged_out'` when not; else `'unknown'`. See [Which account is this?](#which-account-is-this).

#### `AuthStatusOptions`

| Field | Type | Description |
| --- | --- | --- |
| `configDir?` | `string` | Config dir to probe. Defaults to `defaultConfigDir()`. |
| `claudePath?` | `string` | Path to the `claude` binary. Defaults to resolving `claude` from `PATH`. |
| `timeoutMs?` | `number` | Timeout for the probe. Defaults to `20000`. |

#### `AuthStatus`

| Field | Type | Description |
| --- | --- | --- |
| `loggedIn` | `boolean` | Whether the config dir holds a usable login — subscription *or* API key/token. |
| `authMethod` | `string \| null` | `'claude.ai'`, `'api_key'`, `'api_key_helper'`, `'none'`, or another upstream value. |
| `apiProvider` | `string \| null` | API provider (`'firstParty'`, …), as reported upstream. |
| `apiKeySource` | `string \| null` | Where a key-based credential came from (`'ANTHROPIC_API_KEY'`, `'apiKeyHelper'`). |
| `email` | `string \| null` | Account email for a subscription login; `null` when logged out or key-based. |
| `subscriptionType` | `string \| null` | The account's subscription tier, as reported upstream. |
| `raw` | `unknown` | The unprocessed upstream payload, or `null` on error. |
| `fetchedAt` | `number` | Epoch milliseconds when this result was produced. |
| `error?` | `string` | Set only when the probe itself failed; treat every other field as unknown. |

#### `AccountKind`

| Value | Meaning |
| --- | --- |
| `'subscription'` | A claude.ai plan with rate limits to report. |
| `'token'` | An API-key / setup-token login; no plan limits exist, by design. |
| `'logged_out'` | No usable login; plan limits are missing because auth is gone. |
| `'unknown'` | The evidence needed to decide was missing or errored. |

### Pricing

#### `DEFAULT_PRICING: Record<string, ModelPricing>`

The embedded pricing snapshot used when no `pricing` override is supplied.

#### `resolvePricing(modelId: string, table?: Record<string, ModelPricing>): ModelPricing | null`

Looks up pricing for `modelId` in `table` (defaults to `DEFAULT_PRICING`). Returns `null` if the model is unrecognized.

#### `ModelPricing`

| Field | Type | Description |
| --- | --- | --- |
| `inputPerMTok` | `number` | USD per million input tokens. |
| `outputPerMTok` | `number` | USD per million output tokens. |
| `cacheWrite5mPerMTok?` | `number` | USD per million tokens for a 5-minute cache write. Defaults to `inputPerMTok × 1.25`. |
| `cacheWrite1hPerMTok?` | `number` | USD per million tokens for a 1-hour cache write. Defaults to `inputPerMTok × 2`. |
| `cacheReadPerMTok?` | `number` | USD per million tokens for a cache read. Defaults to `inputPerMTok × 0.1`. |

### Transcript usage

#### `getTranscriptUsage(options?: TranscriptUsageOptions): Promise<TranscriptUsageReport>`

Scans and aggregates local transcripts. Never rejects for environmental failure (missing dirs, malformed lines) — those surface via `warnings`, `entriesSkipped`, and similar counters on the returned report.

#### `parseTranscriptLine(line: string): TranscriptEntry | null`

Parses a single JSONL transcript line into a `TranscriptEntry`, or returns `null` if the line isn't a usage-bearing entry or fails to parse.

#### `computeEntryCost(entry: TranscriptEntry, table?: Record<string, ModelPricing>): number | null`

Computes the USD cost of a single entry against `table` (defaults to `DEFAULT_PRICING`). Returns `null` if the entry's model is unrecognized.

#### `TranscriptUsageOptions`

| Field | Type | Description |
| --- | --- | --- |
| `configDirs?` | `string[]` | Config dirs to scan. Defaults to the existing directories among `[$CLAUDE_CONFIG_DIR ?? ~/.claude, ~/.config/claude]`, deduped. |
| `since?` | `Date` | Only include entries at or after this time. |
| `until?` | `Date` | Only include entries at or before this time. |
| `groupBy?` | `TranscriptGroupBy` | How to bucket results — `'day' \| 'month' \| 'session' \| 'model' \| 'project' \| 'total'`. |
| `timezone?` | `'local' \| 'utc'` | Timezone used when bucketing by day/month. |
| `costMode?` | `CostMode` | How per-entry cost is derived — see [CostMode](#costmode). |
| `pricing?` | `Record<string, ModelPricing>` | Pricing overrides merged over `DEFAULT_PRICING`. |

#### `CostMode`

| Value | Behavior |
| --- | --- |
| `'auto'` | Use the recorded per-entry `costUsd` when present, otherwise compute it from pricing. |
| `'calculate'` | Always compute cost from pricing, ignoring any recorded value. |
| `'display'` | Only use recorded values; entries with no recorded cost contribute `0`. |

#### `TranscriptUsageReport`

| Field | Type | Description |
| --- | --- | --- |
| `buckets` | `UsageBucket[]` | One entry per group, per `groupBy`. |
| `totals` | `TokenTotals` | Totals across all buckets. |
| `filesScanned` | `number` | Number of transcript files scanned. |
| `entriesParsed` | `number` | Number of usage entries successfully parsed. |
| `entriesSkipped` | `number` | Number of lines skipped because they didn't parse as usage entries. |
| `duplicatesSkipped` | `number` | Number of duplicate entries detected and excluded (see [Transcript scanning](#transcript-scanning)). |
| `warnings` | `string[]` | Non-fatal issues encountered during the scan (e.g. unknown models). |

#### `UsageBucket`

Extends `TokenTotals` with:

| Field | Type | Description |
| --- | --- | --- |
| `key` | `string` | The bucket identifier — a date, session ID, model ID, project path, or `'total'`, depending on `groupBy`. |
| `models` | `string[]` | Models seen within this bucket. |

#### `TokenTotals`

| Field | Type | Description |
| --- | --- | --- |
| `inputTokens` | `number` | Input tokens. |
| `outputTokens` | `number` | Output tokens. |
| `cacheCreationTokens` | `number` | Cache-creation (write) tokens. |
| `cacheReadTokens` | `number` | Cache-read tokens. |
| `costUsd` | `number` | Cost in USD. |
| `entryCount` | `number` | Number of usage entries. |

#### `TranscriptEntry`

| Field | Type | Description |
| --- | --- | --- |
| `timestamp` | `string` | ISO timestamp of the request. |
| `model` | `string` | Model ID used for the request. |
| `sessionId` | `string \| null` | Session identifier, if present. |
| `messageId` | `string \| null` | Message identifier, if present. |
| `requestId` | `string \| null` | Request identifier, if present. |
| `usage.inputTokens` | `number` | Input tokens for this entry. |
| `usage.outputTokens` | `number` | Output tokens for this entry. |
| `usage.cacheCreationTokens` | `number` | Total cache-creation tokens for this entry. |
| `usage.cacheReadTokens` | `number` | Cache-read tokens for this entry. |
| `usage.cacheCreation5mTokens` | `number \| null` | Portion of cache-creation tokens billed at the 5-minute rate, if broken out. |
| `usage.cacheCreation1hTokens` | `number \| null` | Portion of cache-creation tokens billed at the 1-hour rate, if broken out. |
| `costUsd` | `number \| null` | Recorded cost for this entry, if present in the transcript. |

#### `TranscriptGroupBy`

`'day' | 'month' | 'session' | 'model' | 'project' | 'total'`

## Multi-account example

```ts
import { getLiveUsageForAccounts } from 'claude-plan-usage';

const results = await getLiveUsageForAccounts(
  [
    { name: 'primary', configDir: '/home/user/.claude' },
    { name: 'secondary', configDir: '/home/user/.claude-secondary' },
    { name: 'ci-bot', configDir: '/home/user/.claude-ci' },
  ],
  { concurrency: 2, timeoutMs: 10_000 },
);

for (const r of results) {
  const status = r.available ? `${r.windows.length} windows` : (r.error ?? 'no plan rate limits');
  console.log(`${r.name} (${r.configDir}): ${status}`);
}
```

## Compatibility & caveats

- The `get_usage` control-protocol response is **experimental** and undocumented as a stable shape — it may change upstream without notice. This library parses it defensively and exposes the raw payload on `LiveUsage.raw` so you can adapt if needed.
- The embedded pricing table is a **snapshot as of 2026-07**. Model prices can change upstream; pass a `pricing` option to override any or all entries.
- **Unofficial.** This package is not affiliated with, endorsed by, or supported by Anthropic.
- It reads only local machine state and makes no network calls of its own — it spawns the local `claude` binary for live usage and reads local transcript files for aggregation.
- Transcripts and config live under the directory `CLAUDE_CONFIG_DIR` points at, or `~/.claude` by default, on macOS, Linux, and Windows alike. Some installs instead use `~/.config/claude` — pass `configDir` / `configDirs` explicitly if that's your layout.

## Contributing

Issues and pull requests are welcome. Run `npm test` before submitting a PR.

## License

MIT
