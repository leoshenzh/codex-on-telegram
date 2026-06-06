# AGENTS

## Purpose

This repo is the Mac-local Telegram wrapper around the shared bridge core in `./lib`.
It exists to run one thing only: a Telegram bot that can continue local Claude/Codex work from this Mac.

## User-facing behavior

- Accept Telegram direct messages, groups, and group topics from the owner / allowlist
- Auto-create and bind a session on the first normal Telegram message when a chat or topic has no active session yet
- Start or bind a local session with `/new`, `/bind`, `/status`, `/sessions`, `/cwd`, `/mode`, and `/stop`
- In Codex runtime, `/sessions` should show the current Telegram bridge session plus recent local Codex history, not local Claude history
- Local Codex session titles in `/sessions` should ignore slash commands like `/remote-control` or `/exit` and prefer normal spoken prompts
- Surface permission prompts back to Telegram and allow approval by inline buttons, `1/2/3`, or `/perm`
- Run the local runtime through Codex or Claude
- Keep a launchd-managed daemon healthy on macOS
- Keep bridge session titles readable and aligned with Telegram chat names

## Current live profile

- Runtime should be `codex`
- Default mode should be `code`
- Group use should be enabled
- Telegram access should stay restricted to the owner through owner / allowlist settings
- Permission prompts auto-approve when `CTI_AUTO_APPROVE=true` is set in config

## Telegram command behavior

- `/start`: show quick-start help only; do not create a new session
- `/help`: show the supported command set
- `/status`: show the currently bound session for that private chat, group, or topic
- `/sessions`: show the current session first, then other recent sessions; in Codex runtime these recent sessions should come from Codex history only
- `/bind SESSION_ID`: bind either to a bridge session or a recent local Codex session by full id or unique prefix
- `/new [path]`: start a fresh session, optionally in a specific working directory
- `/cwd PATH`: switch the working directory for the current binding
- `/mode`: switch among `code`, `plan`, and `ask`
- `/stop`: stop the current running task
- First normal non-command message in a private chat, group, or topic should auto-create and bind a session if none exists yet

## `/sessions` display rules

- `Current session` always appears first when a chat or topic is already bound
- `Other recent sessions` are ordered by most recent activity first
- Local Codex titles should come from Codex history display text
- Slash commands should not be used as titles
- If a Codex session has only slash commands and no normal spoken prompt, it should fall back to a generic local-Codex label

## Operational assumption

- Unless a task explicitly says otherwise, treat the owner's Telegram groups here as single-member groups containing only the owner
- This is a local usage assumption for this repo, not a general security model for multi-user groups
- Do not run two bridge daemons with the same Telegram bot token at the same time
- To run multiple bridges concurrently, give each its own Telegram bot token in its own `config.env`
- Group use requires Telegram BotFather privacy mode to be disabled, otherwise normal non-command group messages may not reach the bot

## Current default config

- Runtime should default to `codex` in `config.env`
- Default mode should be `code`
- Telegram should allow groups by setting `CTI_TG_REQUIRE_PRIVATE_CHAT=false`
- Telegram access should stay locked to the owner through `CTI_TG_OWNER_USER_ID` and `CTI_TG_ALLOWED_USERS`
- `CTI_AUTO_APPROVE=true` means Telegram permission prompts are skipped and tools run directly
- `CTI_DEFAULT_MODEL` should stay unset unless the owner explicitly wants to pin a different Codex model

## Group / topic setup

1. Add the Codex bot to the target Telegram group.
2. Disable BotFather group privacy for that bot so normal group messages are delivered.
3. Keep `CTI_TG_REQUIRE_PRIVATE_CHAT=false` in `~/.claude-to-im/config.env`.
4. Keep `CTI_TG_OWNER_USER_ID` and `CTI_TG_ALLOWED_USERS` set to your Telegram user ID.
5. In a topic-enabled group, each topic should keep its own separate bound session automatically.
6. If the bot is meant for owner-only use in a group, do not add other users to the allowlist.

## Access control

- Owner lock is checked first when `CTI_TG_OWNER_USER_ID` is set
- Allowlist can match a Telegram user id or chat id
- With `CTI_TG_REQUIRE_PRIVATE_CHAT=false`, the owner can use the bot in private chat, groups, and topics
- This repo is not currently documented as a general multi-user shared group bot

## Runtime flow

1. Telegram sends a direct message, group message, or topic message to the bot.
2. `src/main.ts` loads config and boots the daemon.
3. The daemon hands message transport to the shared bridge core in `./lib`.
4. `src/codex-provider.ts` or `src/llm-provider.ts` runs the local runtime.
5. Replies and permission prompts go back through Telegram.
6. State is stored under `~/.claude-to-im/`.

## Session naming

- Direct-message sessions should use `Telegram · <person/chat name>`.
- Group sessions should use `Telegram · <group title>`.
- Topic sessions should use `Telegram · <group title> · Topic <topic id>`.
- When the underlying Codex session id becomes known, the same title should be synced into the local Codex recent-task index.

## Files that matter

- `src/main.ts`: daemon entry
- `src/config.ts`: local config parsing and settings export
- `src/codex-provider.ts`: Codex runtime bridge
- `src/llm-provider.ts`: Claude runtime bridge
- `src/store.ts`: local JSON persistence under `~/.claude-to-im/`
- `scripts/daemon.sh`: start / stop / status / logs
- `scripts/supervisor-macos.sh`: macOS launchd supervision
- `scripts/doctor.sh`: health check
- `config.env.example`: template for `~/.claude-to-im/config.env`
- `SKILL.md`: how Codex should invoke this wrapper

## Keep this repo focused

- Keep only Telegram
- Keep only macOS runtime management
- Keep only the local runtime bridge and health tooling
- Push shared bridge logic down into `./lib`

## Do not add back

- Discord
- Feishu / Lark
- QQ
- Weixin
- Windows or Linux service management
- Duplicate setup docs outside `AGENTS.md`, `SKILL.md`, and `plan.md`

## Editing rules

- Treat this repo as a thin wrapper, not the place to grow bridge features.
- If a change is transport, routing, delivery, permission, or session-core logic, edit `./lib` instead.
- Keep `plan.md` in sync when scope or status changes.
- Verify with `npm test`, `npm run build`, `bash scripts/daemon.sh status`, and `bash scripts/doctor.sh`.
