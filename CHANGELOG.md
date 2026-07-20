# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-20

### Added

- Auth-status probe (`getAuthStatus`, `parseAuthStatus`) — reads the local `claude` CLI's `auth status --json` for a config dir, reporting login state, auth method, API-key source, email, and subscription type.
- `classifyAccount(usage, auth)` — folds a live-usage reading and an auth reading into a single `AccountKind` verdict: `'subscription'`, `'token'`, `'logged_out'`, or `'unknown'`. Biased toward `'unknown'` when evidence is missing or errored.
- `--auth` CLI flag, adding each account's auth method and account-kind verdict to the live block (and an `auth` object plus `kind` field to `--json` output).

### Fixed

- **Documented `available: false` incorrectly.** The README stated that a live reading of `available: false` with no `error` means the account is an API-key/token login. An expired or logged-out subscription login produces an identical reading, so consumers following that guidance would silently treat a broken login as a normal steady state. Both causes are now documented, with `getAuthStatus` / `classifyAccount` as the way to tell them apart.
- The CLI's `no plan limits` line no longer claims the account is a token login; it names both possibilities and points at `--auth`.
- The live probe now sets UTF-8 encoding on the child's stdout, so a multi-byte character split across chunk boundaries can no longer corrupt a JSON line, and caps the un-newlined line buffer at 1 MB instead of growing it without bound.

## [0.1.0] - 2026-07-13

### Added

- Live plan usage probe (`getLiveUsage`, `parseLiveUsage`) — reads session/weekly/weekly-scoped rate-limit windows, subscription type, session cost, and overage ("extra usage") billing state from the local `claude` CLI's control protocol.
- Multi-account helper (`getLiveUsageForAccounts`) for probing several config dirs concurrently with bounded concurrency.
- `mergeStaleWindows` helper for carrying forward the last known-good rate-limit windows when upstream returns an empty `rate_limits` payload.
- Transcript usage aggregation (`getTranscriptUsage`, `parseTranscriptLine`) — stream-parses local session transcripts, deduplicates resumed-session entries, and aggregates tokens and cost grouped by day, month, session, model, project, or total.
- Embedded pricing table (`DEFAULT_PRICING`, `resolvePricing`, `computeEntryCost`), fully overridable via the `pricing` option.
- `claude-plan-usage` CLI with JSON output, live-only/transcripts-only modes, date filtering, grouping, multi-account support, and `NO_COLOR` support.
