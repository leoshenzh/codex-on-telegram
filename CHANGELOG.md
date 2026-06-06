# Changelog

All notable changes in this derivative are documented here.

This project is a derivative work of op7418's [`claude-to-im`](./NOTICE) (MIT).
The upstream bridge core is vendored unchanged under [`lib/`](./lib); the
entries below describe only this derivative's own additions and fixes on top of
that base. Precise upstream version tags do not exist, so changes are grouped
under a single unreleased "derivative additions" section. Each entry is
traceable to a real commit in the project history.

## [Unreleased] — derivative additions

### Added

- **Codex SDK runtime path.** A `CTI_RUNTIME=codex` execution path backed by an
  `@openai/codex-sdk` streaming adapter (`src/codex-provider.ts`) and an on-disk
  Codex session reader (`src/codex-local-sessions.ts`), allowing the Telegram
  bridge to host Codex coding sessions. `@openai/codex-sdk` is declared as an
  optional dependency so the wrapper installs and runs when it is absent.
- **Persistent SDK task and outbound-reference state.** `src/store.ts` persists
  per-session SDK task lists and outbound message references to
  `sdk-tasks.json` / `outbound-refs.json`, with pruning, replacing earlier
  in-memory no-op stubs.
- **Shared SSE test helpers** for the Codex provider's streaming tests, reducing
  duplication across the test suite.
- **Comprehensive Codex-bridge fix plan** documenting the audited bugs and the
  phased remediation, with progress recorded as phases shipped.

### Changed

- **Vendored the bridge core into `./lib`.** The shared `claude-to-im` library
  is now vendored in-tree (`file:./lib`, with `node_modules/claude-to-im`
  symlinked to it) instead of being pulled from an external shared-lib
  repository, making the wrapper a single standalone, buildable repo. Docs,
  scripts, and the lockfile were updated to reflect the vendored path.
- **Mirrored and clarified the wrapper docs**, including an explicit
  default-runtime contract (`CTI_RUNTIME` defaults to `claude` when unset; set
  it to `codex` to serve Codex by default).
- **Read the session-lock timeout at runtime** so it can be tuned without a
  rebuild.
- **Ported the Codex engine swap into the TypeScript source** so the runtime
  behavior is reflected in the tracked source rather than only at build time.

### Fixed

- **Mid-stream wedge prevention.** Bounded the Codex stream iterator and the
  session lock with idle timers so a stalled stream is detected instead of
  hanging indefinitely.
- **Stalled stream surfaced as an error.** A mid-stream timeout is now reported
  as an explicit error rather than a silent "complete" turn, preventing
  truncated output from being delivered as a finished answer.
- **Tool-call-aware watchdog.** The mid-stream watchdog is suspended while a tool
  call is in flight, so long-running tool calls are not misclassified as a wedge.
- **Fresh-thread retry on transient timeouts.** A mid-stream timeout is retried
  on a fresh Codex thread when no final answer has been committed, with the
  final-answer commit flag disambiguated so retries are gated correctly; a dead
  commit flag and an over-broad timeout-retry match were later removed.
- **Abort terminates the subprocess.** The bridge's `AbortSignal` is passed into
  `runStreamed`, so aborting a wedged turn kills the underlying Codex subprocess
  instead of leaking it.
- **Session-lock timeout recovery.** On a session-lock timeout the bridge
  releases its heartbeat and aborts the wedged turn.
- **Accurate audit classification.** The bridge manager consumes
  `ConversationResult.errorType` when synthesizing audit records, so failed
  turns are categorized correctly.

---

### Attribution

The Telegram adapter, bridge manager, session routing, delivery/retry/dedup,
permission handling, input validation, rate limiting, and Markdown→Telegram
rendering are part of op7418's original `claude-to-im` and are not claimed here.
See [NOTICE](./NOTICE), [LICENSE](./LICENSE), and [lib/LICENSE](./lib/LICENSE).
