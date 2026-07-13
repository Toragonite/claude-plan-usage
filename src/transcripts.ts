/**
 * Historical token/cost aggregation over Claude Code's local transcript files.
 *
 * Claude Code writes one JSON object per line to
 * `<configDir>/projects/<project-dir-name>/<session-uuid>.jsonl`. Each file mixes
 * many line types (user, assistant, summary, progress, ...). Only `assistant`
 * lines that carry a `message.usage` object contribute to token/cost totals.
 *
 * This module reads those files by streaming them line-by-line (it never loads a
 * whole file into memory), parses each line defensively (a malformed line can
 * never throw), de-duplicates entries that resumed/forked sessions copy across
 * files, and aggregates the survivors into buckets.
 *
 * Only Node.js built-ins are used (`node:fs`, `node:path`, `node:os`,
 * `node:readline`); the module has no runtime dependencies.
 */

import { createReadStream, existsSync, readdirSync, type Dirent } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { DEFAULT_PRICING, resolvePricing, type ModelPricing } from './pricing';

/** How aggregated usage rows are grouped. */
export type TranscriptGroupBy = 'day' | 'month' | 'session' | 'model' | 'project' | 'total';

/**
 * How per-entry cost is determined:
 * - `display`: use only the cost Claude Code recorded on the entry (`costUSD`).
 * - `calculate`: always compute cost from the pricing table.
 * - `auto`: use the recorded cost when present, otherwise compute it.
 */
export type CostMode = 'auto' | 'calculate' | 'display';

/** Options for {@link getTranscriptUsage}. */
export interface TranscriptUsageOptions {
  /**
   * Config directories to scan (each is expected to contain a `projects/`
   * subtree). Defaults to the deduped set of existing directories among
   * `[$CLAUDE_CONFIG_DIR || ~/.claude, ~/.config/claude]`.
   */
  configDirs?: string[];
  /** Inclusive lower bound on entry timestamps. */
  since?: Date;
  /** Inclusive upper bound on entry timestamps. */
  until?: Date;
  /** Grouping for the returned buckets. Defaults to `'day'`. */
  groupBy?: TranscriptGroupBy;
  /** Calendar timezone used for `day`/`month` bucket keys. Defaults to `'local'`. */
  timezone?: 'local' | 'utc';
  /** Cost determination strategy. Defaults to `'auto'`. */
  costMode?: CostMode;
  /** Pricing table override. Defaults to {@link DEFAULT_PRICING}. */
  pricing?: Record<string, ModelPricing>;
}

/** Aggregated token counts and cost. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  entryCount: number;
}

/** One grouped row of the report. */
export interface UsageBucket extends TokenTotals {
  /** Bucket key (e.g. a date, session id, model id, or project name). */
  key: string;
  /** Distinct model ids contributing to this bucket, sorted ascending. */
  models: string[];
}

/** Result of {@link getTranscriptUsage}. */
export interface TranscriptUsageReport {
  /** Grouped rows, sorted by `key` ascending. */
  buckets: UsageBucket[];
  /** Totals across every included entry. */
  totals: TokenTotals;
  /** Number of transcript files successfully opened. */
  filesScanned: number;
  /** Valid usage entries after de-duplication, before date filtering. */
  entriesParsed: number;
  /** Lines that were malformed JSON or malformed assistant entries. */
  entriesSkipped: number;
  /** Entries dropped as duplicates of an already-seen message. */
  duplicatesSkipped: number;
  /** Non-fatal diagnostics (missing dirs, unreadable files, unknown models). */
  warnings: string[];
}

/** A single parsed, usage-bearing assistant entry. */
export interface TranscriptEntry {
  timestamp: string;
  model: string;
  sessionId: string | null;
  messageId: string | null;
  requestId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cacheCreation5mTokens: number | null;
    cacheCreation1hTokens: number | null;
  };
  costUsd: number | null;
}

const GROUP_BY_VALUES: readonly TranscriptGroupBy[] = [
  'day',
  'month',
  'session',
  'model',
  'project',
  'total',
];
const COST_MODE_VALUES: readonly CostMode[] = ['auto', 'calculate', 'display'];
const TIMEZONE_VALUES: readonly ('local' | 'utc')[] = ['local', 'utc'];

// --- Low-level value helpers -------------------------------------------------

/** True for a non-null, non-array plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number `>= 0`, otherwise `0`. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A finite number `>= 0`, otherwise `null`. */
function toCountOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A non-empty string, otherwise `null`. */
function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Strip a single trailing carriage return (from CRLF line endings). */
function stripTrailingCr(line: string): string {
  return line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line;
}

// --- Line parsing ------------------------------------------------------------

/**
 * Build a {@link TranscriptEntry} from an already-parsed JSON record, or `null`
 * if the record is not a usage-bearing assistant entry.
 *
 * A record qualifies iff: `type === 'assistant'`, `message` is an object,
 * `message.usage` is an object, `message.model` is a string other than
 * `'<synthetic>'`, and `timestamp` is a string that `Date.parse` accepts.
 */
function buildEntry(record: Record<string, unknown>): TranscriptEntry | null {
  if (record.type !== 'assistant') return null;

  const message = record.message;
  if (!isRecord(message)) return null;

  const usage = message.usage;
  if (!isRecord(usage)) return null;

  const model = message.model;
  if (typeof model !== 'string' || model === '<synthetic>') return null;

  const timestamp = record.timestamp;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;

  const cacheCreation = usage.cache_creation;
  const cacheCreation5mTokens = isRecord(cacheCreation)
    ? toCountOrNull(cacheCreation.ephemeral_5m_input_tokens)
    : null;
  const cacheCreation1hTokens = isRecord(cacheCreation)
    ? toCountOrNull(cacheCreation.ephemeral_1h_input_tokens)
    : null;

  const rawCost = record.costUSD;
  const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : null;

  return {
    timestamp,
    model,
    sessionId: toNonEmptyString(record.sessionId),
    messageId: toNonEmptyString(message.id),
    requestId: toNonEmptyString(record.requestId),
    usage: {
      inputTokens: toCount(usage.input_tokens),
      outputTokens: toCount(usage.output_tokens),
      cacheCreationTokens: toCount(usage.cache_creation_input_tokens),
      cacheReadTokens: toCount(usage.cache_read_input_tokens),
      cacheCreation5mTokens,
      cacheCreation1hTokens,
    },
    costUsd,
  };
}

/**
 * Parse a single transcript line into a {@link TranscriptEntry}.
 *
 * Returns `null` (never throws) when the line is not valid JSON, is not an
 * object, or is not a usage-bearing assistant entry (including intentionally
 * excluded `'<synthetic>'` model lines). A trailing carriage return is stripped
 * before parsing.
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const text = stripTrailingCr(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return buildEntry(parsed);
}

/**
 * Classification of a single line for scan bookkeeping:
 * - `entry`: a usable usage entry.
 * - `skipped`: malformed JSON or a malformed assistant entry (counts toward `entriesSkipped`).
 * - `ignored`: not an error and not usable (other line types, synthetic): silently ignored.
 */
type LineKind = 'entry' | 'skipped' | 'ignored';

interface ClassifiedLine {
  kind: LineKind;
  entry: TranscriptEntry | null;
}

/**
 * Classify a non-empty line for the scanner. Distinguishes a genuine usage entry
 * from an error (malformed JSON / malformed assistant line) and from lines that
 * are intentionally ignored (other types, or `'<synthetic>'` assistant lines).
 */
function classifyLine(line: string): ClassifiedLine {
  const text = stripTrailingCr(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'skipped', entry: null };
  }
  if (!isRecord(parsed)) {
    return { kind: 'ignored', entry: null };
  }
  if (parsed.type !== 'assistant') {
    return { kind: 'ignored', entry: null };
  }

  // Assistant line: a '<synthetic>' model is an intentional exclusion, not an
  // error, so it must not be counted as skipped.
  const message = parsed.message;
  if (isRecord(message) && message.model === '<synthetic>') {
    return { kind: 'ignored', entry: null };
  }

  const entry = buildEntry(parsed);
  if (entry === null) {
    // An assistant line with a bad timestamp/usage/model shape is an error.
    return { kind: 'skipped', entry: null };
  }
  return { kind: 'entry', entry };
}

// --- Cost --------------------------------------------------------------------

/**
 * Compute the USD cost of an entry from a pricing table.
 *
 * Returns `null` when the model has no pricing. Cache-write cost uses the
 * 5m/1h breakdown when either breakdown field is non-null (treating a null side
 * as `0`); any `cacheCreationTokens` beyond the 5m+1h split are charged at the
 * 5m write rate. When no breakdown is present the whole `cacheCreationTokens`
 * count is charged at the 5m write rate.
 *
 * @param entry The entry to price.
 * @param table Pricing table. Defaults to {@link DEFAULT_PRICING}.
 */
export function computeEntryCost(
  entry: TranscriptEntry,
  table: Record<string, ModelPricing> = DEFAULT_PRICING,
): number | null {
  const pricing = resolvePricing(entry.model, table);
  if (pricing === null) return null;

  const inputRate = pricing.inputPerMTok ?? 0;
  const outputRate = pricing.outputPerMTok ?? 0;
  const readRate = pricing.cacheReadPerMTok ?? 0;
  const write5mRate = pricing.cacheWrite5mPerMTok ?? 0;
  const write1hRate = pricing.cacheWrite1hPerMTok ?? 0;

  const u = entry.usage;

  let cacheWriteTokenCost: number;
  if (u.cacheCreation5mTokens !== null || u.cacheCreation1hTokens !== null) {
    const tokens5m = u.cacheCreation5mTokens ?? 0;
    const tokens1h = u.cacheCreation1hTokens ?? 0;
    // The breakdown can under-sum the reported total; charge the remainder at
    // the 5m write rate so no written tokens go unpriced.
    const remainder = Math.max(0, u.cacheCreationTokens - tokens5m - tokens1h);
    cacheWriteTokenCost = tokens5m * write5mRate + tokens1h * write1hRate + remainder * write5mRate;
  } else {
    cacheWriteTokenCost = u.cacheCreationTokens * write5mRate;
  }

  const total =
    u.inputTokens * inputRate +
    u.outputTokens * outputRate +
    u.cacheReadTokens * readRate +
    cacheWriteTokenCost;

  return total / 1e6;
}

// --- Option validation -------------------------------------------------------

/** Validate a Date option; throws {@link TypeError} on an invalid value. */
function requireValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
}

// --- Config-dir resolution ---------------------------------------------------

/** Order-preserving string de-duplication. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Resolve the config directories to scan. A provided-but-missing directory adds
 * a warning and is skipped; missing default directories are silently omitted.
 */
function resolveConfigDirs(provided: string[] | undefined, warnings: string[]): string[] {
  if (provided !== undefined) {
    const result: string[] = [];
    for (const dir of dedupe(provided)) {
      if (existsSync(dir)) result.push(dir);
      else warnings.push(`config dir not found: ${dir}`);
    }
    return result;
  }

  const home = homedir();
  const primary = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const secondary = join(home, '.config', 'claude');
  return dedupe([primary, secondary]).filter((dir) => existsSync(dir));
}

// --- File discovery ----------------------------------------------------------

interface DiscoveredFile {
  file: string;
  /** First-level directory name under `projects/` (the raw encoded project name). */
  project: string;
}

/**
 * Recursively find every `*.jsonl` file under a `projects/` directory. Symlinks
 * are not followed. Unreadable directories add a warning and are skipped; a
 * missing `projects/` directory is silently ignored.
 */
function discoverJsonlFiles(projectsDir: string, warnings: string[]): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
  const stack: { dir: string; project: string | null }[] = [{ dir: projectsDir, project: null }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') warnings.push(`cannot read directory: ${current.dir}`);
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // do not follow symlinks
      const full = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        // The first-level directory name under projects/ is the project name and
        // is carried down into nested subdirectories.
        stack.push({ dir: full, project: current.project ?? entry.name });
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push({ file: full, project: current.project ?? '' });
      }
    }
  }

  return found;
}

/**
 * Stream a file line-by-line, invoking `onLine` for each line. Resolves to
 * `true` on a clean read and `false` (with a warning) if the file could not be
 * read. Never rejects.
 */
function readFileLines(
  file: string,
  onLine: (line: string) => void,
  warnings: string[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const settle = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    stream.on('error', () => {
      warnings.push(`cannot read file: ${file}`);
      rl.close();
      stream.destroy();
      settle(false);
    });
    rl.on('line', (line) => {
      onLine(line);
    });
    rl.on('error', () => {
      warnings.push(`cannot read file: ${file}`);
      stream.destroy();
      settle(false);
    });
    rl.on('close', () => {
      settle(true);
    });
  });
}

// --- Bucketing ---------------------------------------------------------------

interface BucketAccumulator extends TokenTotals {
  key: string;
  models: Set<string>;
}

/** Zero-pad a positive integer to at least two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format an ISO timestamp into a `YYYY-MM-DD` or `YYYY-MM` key. */
function calendarKey(
  timestamp: string,
  timezone: 'local' | 'utc',
  granularity: 'day' | 'month',
): string {
  const date = new Date(timestamp);
  const utc = timezone === 'utc';
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  if (granularity === 'month') return `${year}-${pad2(month)}`;
  const day = utc ? date.getUTCDate() : date.getDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// --- Public entry point ------------------------------------------------------

/**
 * Aggregate historical token usage and cost from Claude Code transcript files.
 *
 * Discovers `*.jsonl` files under each config directory's `projects/` subtree,
 * streams them, de-duplicates entries globally by `messageId requestId`, filters
 * by the optional `since`/`until` window, and groups the survivors according to
 * `groupBy`.
 *
 * The returned promise never rejects for environmental reasons (missing or
 * unreadable directories/files become warnings). It rejects only via a
 * synchronous {@link TypeError} for invalid options.
 *
 * @throws {TypeError} On an invalid `groupBy`, `costMode`, `timezone`,
 * `since`/`until` value, `since > until`, or non-string-array `configDirs`.
 */
export async function getTranscriptUsage(
  options: TranscriptUsageOptions = {},
): Promise<TranscriptUsageReport> {
  const groupBy = options.groupBy ?? 'day';
  if (!GROUP_BY_VALUES.includes(groupBy)) {
    throw new TypeError(
      `Invalid groupBy: ${String(options.groupBy)} (expected one of ${GROUP_BY_VALUES.join(', ')})`,
    );
  }

  const costMode = options.costMode ?? 'auto';
  if (!COST_MODE_VALUES.includes(costMode)) {
    throw new TypeError(
      `Invalid costMode: ${String(options.costMode)} (expected one of ${COST_MODE_VALUES.join(', ')})`,
    );
  }

  const timezone = options.timezone ?? 'local';
  if (!TIMEZONE_VALUES.includes(timezone)) {
    throw new TypeError(
      `Invalid timezone: ${String(options.timezone)} (expected one of ${TIMEZONE_VALUES.join(', ')})`,
    );
  }

  const { since, until } = options;
  if (since !== undefined) requireValidDate(since, 'since');
  if (until !== undefined) requireValidDate(until, 'until');
  if (since !== undefined && until !== undefined && since.getTime() > until.getTime()) {
    throw new TypeError('since must be less than or equal to until');
  }

  if (options.configDirs !== undefined) {
    if (
      !Array.isArray(options.configDirs) ||
      !options.configDirs.every((dir) => typeof dir === 'string')
    ) {
      throw new TypeError('configDirs must be an array of strings');
    }
  }

  const sinceMs = since?.getTime();
  const untilMs = until?.getTime();
  const pricingTable = { ...DEFAULT_PRICING, ...options.pricing };

  const warnings: string[] = [];
  const configDirs = resolveConfigDirs(options.configDirs, warnings);

  const stats = {
    filesScanned: 0,
    entriesParsed: 0,
    entriesSkipped: 0,
    duplicatesSkipped: 0,
  };
  const seenIds = new Set<string>();
  const warnedModels = new Set<string>();
  const buckets = new Map<string, BucketAccumulator>();

  /** Cost of an included entry under the active cost mode (never null). */
  const costOf = (entry: TranscriptEntry): number => {
    if (costMode === 'display') return entry.costUsd ?? 0;
    if (costMode === 'auto' && entry.costUsd !== null) return entry.costUsd;
    const computed = computeEntryCost(entry, pricingTable);
    if (computed === null) {
      const message = `unknown model pricing: ${entry.model}`;
      if (!warnedModels.has(message)) {
        warnedModels.add(message);
        warnings.push(message);
      }
      return 0;
    }
    return computed;
  };

  const bucketKeyOf = (entry: TranscriptEntry, project: string, fileStem: string): string => {
    switch (groupBy) {
      case 'day':
        return calendarKey(entry.timestamp, timezone, 'day');
      case 'month':
        return calendarKey(entry.timestamp, timezone, 'month');
      case 'session':
        return entry.sessionId ?? fileStem;
      case 'model':
        return entry.model;
      case 'project':
        return project;
      case 'total':
        return 'total';
    }
  };

  const includeEntry = (entry: TranscriptEntry, project: string, fileStem: string): void => {
    // Global de-duplication: only entries with both ids can be de-duplicated.
    if (entry.messageId !== null && entry.requestId !== null) {
      const idKey = `${entry.messageId} ${entry.requestId}`;
      if (seenIds.has(idKey)) {
        stats.duplicatesSkipped++;
        return;
      }
      seenIds.add(idKey);
    }

    // Counted after de-dup, before date filtering.
    stats.entriesParsed++;

    const t = Date.parse(entry.timestamp);
    if (sinceMs !== undefined && t < sinceMs) return;
    if (untilMs !== undefined && t > untilMs) return;

    const key = bucketKeyOf(entry, project, fileStem);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        entryCount: 0,
        models: new Set<string>(),
      };
      buckets.set(key, bucket);
    }
    const u = entry.usage;
    bucket.inputTokens += u.inputTokens;
    bucket.outputTokens += u.outputTokens;
    bucket.cacheCreationTokens += u.cacheCreationTokens;
    bucket.cacheReadTokens += u.cacheReadTokens;
    bucket.costUsd += costOf(entry);
    bucket.entryCount++;
    bucket.models.add(entry.model);
  };

  for (const configDir of configDirs) {
    const projectsDir = join(configDir, 'projects');
    const files = discoverJsonlFiles(projectsDir, warnings);
    for (const { file, project } of files) {
      const fileStem = basename(file, '.jsonl');
      const opened = await readFileLines(
        file,
        (line) => {
          if (line.trim().length === 0) return; // skip empty/whitespace lines
          const classified = classifyLine(line);
          if (classified.kind === 'skipped') {
            stats.entriesSkipped++;
            return;
          }
          if (classified.entry === null) return; // ignored line type
          includeEntry(classified.entry, project, fileStem);
        },
        warnings,
      );
      if (opened) stats.filesScanned++;
    }
  }

  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    entryCount: 0,
  };
  for (const bucket of buckets.values()) {
    totals.inputTokens += bucket.inputTokens;
    totals.outputTokens += bucket.outputTokens;
    totals.cacheCreationTokens += bucket.cacheCreationTokens;
    totals.cacheReadTokens += bucket.cacheReadTokens;
    totals.costUsd += bucket.costUsd;
    totals.entryCount += bucket.entryCount;
  }

  const bucketList: UsageBucket[] = [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      costUsd: bucket.costUsd,
      entryCount: bucket.entryCount,
      models: [...bucket.models].sort((a, b) => a.localeCompare(b, 'en')),
    }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));

  return {
    buckets: bucketList,
    totals,
    filesScanned: stats.filesScanned,
    entriesParsed: stats.entriesParsed,
    entriesSkipped: stats.entriesSkipped,
    duplicatesSkipped: stats.duplicatesSkipped,
    warnings,
  };
}
