# AGENTS.md

## Purpose

This repository is the shared Telegram bridge core used by local host wrappers such as `../claude-to-im`.
It should stay small, transport-focused, and reusable.

## What this repo owns

- `src/lib/bridge/host.ts`: host contracts
- `src/lib/bridge/bridge-manager.ts`: bridge orchestration and message handling
- `src/lib/bridge/adapters/telegram-adapter.ts`: built-in Telegram transport
- `src/lib/bridge/channel-router.ts`: chat-to-session binding
- `src/lib/bridge/delivery-layer.ts`: outbound send / retry / dedup
- `src/lib/bridge/permission-broker.ts`: permission prompt and callback handling
- `src/lib/bridge/security/*`: validation and rate limiting
- `src/lib/bridge/local-codex-sessions.ts`: local Codex session discovery
- `src/__tests__/unit/*`: thin-bridge safety and regression tests

## Message flow

1. Adapter receives a Telegram update.
2. `bridge-manager.ts` consumes the queued update.
3. Commands such as `/new`, `/bind`, `/sessions`, and `/perm` are handled directly.
4. First normal messages in a Telegram DM, group, or topic can auto-create and bind a bridge session when no active binding exists.
5. Normal messages are routed to the bound session.
6. `conversation-engine.ts` streams runtime output.
7. `delivery-layer.ts` sends the reply back through Telegram.
8. Bridge-backed session titles should reflect the Telegram chat or topic name and sync back into the local Codex recent-task index when possible.

## Current Telegram semantics

- Group chats and Telegram topics are first-class routes, not private-chat fallbacks.
- One Telegram group can hold separate bindings per topic.
- Group commands with `@botname` suffix must resolve like the plain command.
- Permission handling can flow through inline buttons, `1/2/3` quick replies, or `/perm`.
- Built-in Telegram display names should prefer the group title for group traffic and the person/chat name for DMs.
- Local Codex title sync should append a new `session_index.jsonl` record instead of rewriting the whole file.

## Keep this repo focused

- Telegram transport only
- Shared bridge behavior only
- Session routing, delivery, permission, security, and discovery only
- Tests that stop false success and silent message loss

## Do not add back

- Discord
- Feishu / Lark
- QQ
- Weixin
- Host-specific login, QR, account, or device flows
- Duplicate internal docs spread across the tree

## Editing rules

- Fix shared runtime bugs here; fix local machine boot logic in the consuming host repo.
- Do not reintroduce hidden session creation for read-only commands.
- Do not ship any change without tests and a rebuilt `dist/`.
- Keep `plan.md` in sync with scope and verification state.
- Verify with `npm run typecheck`, `npm run test:unit`, and `npm run build`.
