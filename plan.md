# Codex on Telegram Plan

## Goal

Build and maintain a Telegram-only bridge that lets the owner continue local Claude/Codex sessions from mobile Telegram chat.

## Scope

- Keep Telegram bridge settings and runtime wiring
- Keep daemon lifecycle management
- Keep local session discovery and binding
- Keep Claude/Codex runtime selection
- Consume the sibling shared bridge package through its exported bridge modules
- Remove Discord, Feishu/Lark, QQ, and Weixin code paths and docs from this skill repo

## Completion Standard

- Codex startup must fail fast when the runtime is not actually usable
- Telegram startup state must reflect real API availability instead of “started but broken”
- `config.env`, `doctor.sh`, and `daemon.sh` must agree on `export KEY=...` parsing
- Full host build and automated tests pass
- Host runtime bundle includes Telegram document receiving and guarded outbox file sending
- `daemon.sh status` and `doctor.sh` must agree when `bridge.pid` is missing but `status.json` still points to a live daemon PID
- Session-lock timeout must read `CTI_SESSION_LOCK_TIMEOUT_MS` after runtime config loading, not at module import time

## Status

- [x] Skill repo config reduced to Telegram-only fields
- [x] Daemon entry verified to register only Telegram adapter
- [x] Docs rewritten for Telegram-only
- [x] Weixin source files, tests, and config removed
- [x] Final build and test verification
- [x] Local runtime config cleaned to Telegram-only and rebuilt against the fixed bridge loop
- [x] Docs consolidated into `AGENTS.md` and non-macOS helper scripts removed
- [x] Startup hardening: config parsed as data, not executed as shell
- [x] Runtime hardening: fatal async errors now trigger full shutdown and clean status reset
- [x] Diagnostics updated to judge only the current run
- [x] Codex runtime hardening: terminal stream stalls now self-close so completed replies still return and the session lock is released
- [x] Telegram reply formatting hardening: final Codex replies now keep section breaks and render with mobile-friendly lightweight formatting
- [x] Codex startup hardening: if local startup hangs before the first event, the bridge now times out, returns a clear failure, and releases the session instead of hanging silently
- [x] Config parsing now matches shell semantics for `export KEY=...` entries and keeps Node/runtime reads aligned with the config file
- [x] Codex runtime now performs a startup preflight before the daemon reports itself healthy
- [x] Shared shell helpers now keep `doctor`, `daemon`, and launchd config parsing on one path instead of drifting apart
- [x] Codex runtime now performs a real preflight before daemon startup and fails fast when the SDK/runtime is unusable
- [x] Codex startup timeout helpers now clear their timers on success so healthy runs do not leave hanging handles behind
- [x] `config.env` parsing now accepts `export KEY=...` in Node runtime, and shell scripts share one parser helper instead of drifting
- [x] Regression coverage added for export-prefixed config parsing and Codex preflight behavior
- [x] Codex startup preflight is now a lightweight SDK/runtime initialization check instead of a throwaway real thread
- [x] `doctor.sh` now checks the same runtime path that the daemon actually uses, instead of a separate CLI-only signal
- [x] Regression coverage updated for lightweight Codex preflight semantics
- [x] Code review findings on startup health, doctor alignment, and Telegram progress routing addressed and re-verified
- [x] Host store bindings now distinguish Telegram topics inside one group so each topic can keep its own session
- [x] Host rebuild now consumes the bridge changes needed for exec-session `/bind` recovery and single-send Telegram replies
- [x] Host docs now describe Telegram group/topic support and bridge session title naming instead of the older private-chat-only behavior
- [x] Host docs now treat the owner's Telegram groups as single-member groups by default; that is a local operating assumption, not a general multi-user security model
- [x] macOS launchd plist generation now XML-escapes forwarded env vars so special characters cannot corrupt the plist
- [x] Codex runtime now recognizes newer `final_answer` / `task_complete` progress events, emits the finished reply to Telegram, and stops hanging terminal drains quickly enough to return completed answers
- [x] Skill docs now explain restart/session continuity, binding persistence, topic-level session behavior, and the narrow cases where rebind is actually needed
- [x] Skill docs now describe the real trigger conditions, local-data split, `/sessions` and `/bind` lookup rules, and config fields without claiming false defaults
- [x] Shared bridge regression: error-ending turns now keep a known Codex sdk session id instead of clearing it, so restart and binding persistence survive partial failures
- [x] Host rebuilt against document receiving and guarded outbox file sending bridge changes
- [x] Runtime PID health now falls back to the live `status.json` PID and the daemon refreshes `bridge.pid` during status sync
- [x] Host store now persists per-session runtime status so `/status` can expose the latest bridge view after rebuild/restart
- [x] Host rebuilt against bridge empty-response and rich-audit hardening without restarting the live daemon
- [x] Host store now prunes stale runtime-status records and keeps a larger audit window for bridge incident diagnosis
- [x] Host rebuilt against delivery-failure, file-marker redaction, and runtime-status lock-safety hardening without restarting the live daemon
- [x] Session-lock timeout now reads `CTI_SESSION_LOCK_TIMEOUT_MS` at call time so `config.env` values apply after rebuild; built without restarting the live daemon
- [x] Codex engine swap is now in source: `codex-provider.ts` points the SDK at the auto-updating Codex.app internal binary via `codexPathOverride` (env `CTI_CODEX_PATH`, default `/Applications/Codex.app/Contents/Resources/codex`, existence-guarded) at both the preflight and `ensureSDK` client construction sites, eliminating the version-skew config.toml crash; previously this fix lived only in the gitignored dist build output, so any rebuild/reinstall would have erased it. Rebuilt without restarting the live daemon.
