# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-13

### Added

- Live plan usage probe (`getLiveUsage`, `parseLiveUsage`) — reads session/weekly/weekly-scoped rate-limit windows, subscription type, session cost, and overage ("extra usage") billing state from the local `claude` CLI's control protocol.
- Multi-account helper (`getLiveUsageForAccounts`) for probing several config dirs concurrently with bounded concurrency.
- `mergeStaleWindows` helper for carrying forward the last known-good rate-limit windows when upstream returns an empty `rate_limits` payload.
- Transcript usage aggregation (`getTranscriptUsage`, `parseTranscriptLine`) — stream-parses local session transcripts, deduplicates resumed-session entries, and aggregates tokens and cost grouped by day, month, session, model, project, or total.
- Embedded pricing table (`DEFAULT_PRICING`, `resolvePricing`, `computeEntryCost`), fully overridable via the `pricing` option.
- `claude-plan-usage` CLI with JSON output, live-only/transcripts-only modes, date filtering, grouping, multi-account support, and `NO_COLOR` support.
