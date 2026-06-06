# Claude-to-IM Library Plan

## Goal

Keep this repository as the Telegram-first shared thin-bridge core for Codex and Claude hosts.

## Completion Standard

- Shared bridge-core logic and the built-in Telegram adapter are the active artifacts
- Telegram live progress and final replies share one explicit per-message stream context
- Local Codex bindings keep their local-session identity even if resume falls back to a fresh SDK thread
- Commentary, reasoning, and tool progress flow through one Telegram progress path
- Root docs explain the Telegram-first boundary clearly
- Package metadata and build output include the Telegram adapter
- Typecheck, unit tests, and build pass
- Telegram can receive authorized non-image documents as local session attachments
- Telegram can send generated outbox files back with strict path and filename guards
- Bridge-created `.codepilot-uploads/` and `.codepilot-outbox/` directories must be git-ignored by default

## Scope

- Keep host contracts, routing, delivery, permission, security, and local Codex session discovery
- Keep the built-in Telegram adapter, media/file handler, outbound outbox sender, and markdown renderer
- Remove non-Telegram adapters, renderers, docs, tests, and dependencies
- Add repo-specific operating instructions in root `AGENTS.md`
- Rebuild and verify after pruning

## Status

- [x] Shared bridge core with built-in Telegram adapter
- [x] Non-Telegram dependencies removed from package metadata
- [x] Root docs rewritten for the Telegram-first boundary
- [x] Discord, Feishu/Lark, QQ adapters removed
- [x] Final typecheck, unit tests, and build verification
- [x] Docs corrected from erroneous Weixin-only direction back to Telegram-first
- [x] Adapter consumer loop restored so Telegram commands are processed after daemon start
- [x] Redundant docs removed and repo guidance consolidated into `AGENTS.md`
- [x] Duplicate session locking removed so bound Telegram messages no longer deadlock after start
- [x] Permission prompts now send a redacted input summary instead of raw tool payloads
- [x] Telegram final replies now preserve block spacing and use lightweight HTML formatting for clearer mobile reading
- [x] Codex progress commentary now feeds the Telegram live-progress channel so resumed sessions can surface mid-run updates before the final reply
- [x] Bound local Codex sessions now return an immediate progress summary to Telegram when the local task is still actively running, instead of silently hanging on “进度”类追问
- [x] Stream callbacks now share one stable per-message context so Telegram progress/tool/final hooks stay anchored to the same inbound message
- [x] Telegram live progress now replies to the real inbound message instead of guessing from the adapter queue
- [x] Local-session bindings keep their `local-codex` source semantics even after the resumed SDK thread changes
- [x] Telegram adapter startup now fails fast when bot auth is invalid instead of pretending the bridge is healthy
- [x] Bridge-manager now carries a shared stream context object from message start through stream progress, tool events, and final reply handling
- [x] Telegram live progress is anchored by explicit reply context instead of chat-level queue guessing
- [x] Reasoning status now joins the same progress channel as commentary
- [x] Local-session bindings now persist `sessionSource` so fresh-thread fallback does not erase “this is a local Codex session”
- [x] Regression tests cover stream context, local binding stability, and Telegram startup failure behavior
- [x] Telegram live progress now serializes per stream context so concurrent updates share one anchor and do not race the final reply
- [x] Telegram stream shutdown now closes live progress before the final message is handed back to the chat
- [x] Regression tests cover serialized Telegram progress updates and stream-end ordering
- [x] Code review findings on Telegram progress ordering and Codex startup health checks addressed and re-verified
- [x] Historical Codex exec sessions now appear in local-session discovery so Telegram can bind back to resumable Codex work
- [x] Session lookup now accepts either the bridge session id or the underlying Codex session id during `/bind`
- [x] Telegram topic routes now keep separate bindings, permission shortcuts, and session snapshots inside the same group chat
- [x] First plain message inside a Telegram topic now auto-creates and binds a session instead of failing with “No active session”
- [x] End-of-stream Telegram progress placeholders are now deleted before the final reply is sent so one answer only renders once
- [x] The first long-running message in a new Telegram topic no longer blocks later control messages in the adapter loop
- [x] `/bind` fallback now searches older local Codex exec sessions beyond the recent session list window
- [x] Natural-language messages now forward directly to the bound AI session instead of being replaced by bridge-generated progress summaries
- [x] Telegram group commands like `/new@botname` now resolve to the underlying bridge command instead of failing as unknown commands
- [x] Telegram group/topic inbound handling hardened so non-command messages are not lost when Telegram delivers them under broader update types
- [x] Telegram topic replies sent on behalf of the bound group chat now pass authorization instead of being dropped as a fake sender
- [x] First plain Telegram messages in non-topic chats/groups now auto-create and bind a session so `hello`-style messages reply without requiring `/new` or `@bot`
- [x] Bridge-created Telegram sessions now use readable group/DM titles and sync that same title back into the local Codex recent-task index when the SDK session id becomes known
- [x] Local Codex title sync now appends a fresh `session_index.jsonl` record instead of rewriting the whole file, reducing concurrent-write clobbering
- [x] Root docs now describe the current Telegram group/topic semantics, auto-bind behavior, and session-title sync rules
- [x] Post-text Codex transport disconnects no longer replace captured final text with a reconnect error in Telegram delivery
- [x] Telegram generic document receiving and guarded outbox file sending implemented and verified
- [x] Attachment upload and generated-file outbox directories now receive a local `.gitignore` automatically to prevent accidental commits
- [x] Empty runtime streams now become explicit failed-turn messages instead of `No response.`
- [x] Conversation audit records can carry bridge session id, SDK session id, topic id, cwd, status, and error type
- [x] Runtime status persistence is now best-effort and cannot strand a session lock when the status file cannot be written
- [x] Final delivery success now requires an actual successful send; partial chunk/file failures are audited as `delivery_failed` and are not acknowledged as completed turns
- [x] Outbound file markers and file-send fallbacks no longer expose local absolute paths in Telegram-visible notices or conversation audit summaries
- [x] Telegram album inbound audit now includes the topic id for topic-level troubleshooting
- [x] Regression tests cover empty-response audit typing, `/status` runtime display, delivery-failed audit, partial chunk failure, marker redaction, and runtime-status write failures
- [x] Outbox push watcher (Fix #3) polls `<workDir>/.codepilot-outbox/push/` and pushes stable text/file payloads to every bound chat, with .sent/.failed filing and `CTI_OUTBOX_PUSH_ENABLED` / `CTI_OUTBOX_PUSH_POLL_MS` toggles
