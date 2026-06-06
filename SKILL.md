---
name: claude-to-im
description: |
  Use when working on the local Telegram bridge that lets the owner continue Codex or Claude sessions
  from Telegram, especially for setup, start/stop, health checks, restart questions, binding
  questions, or runtime reconfiguration.
argument-hint: "setup | start | stop | status | logs [N] | doctor | reconfigure"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Codex on Telegram

This skill manages a Telegram bridge for continuing local Claude/Codex sessions from mobile chat.

## When to Use
- Use when the owner asks about the local Telegram bridge itself.
- Use when the task is `setup`, `start`, `stop`, `status`, `logs`, `doctor`, or `reconfigure`.
- Use when the owner asks whether Telegram will continue the same session after restart.
- Use when the owner asks how `/bind`, `/sessions`, topics, or local-session continuation behave.
- Do not use this skill for unrelated Telegram bot work or generic chat replies.

## Scope
- Keep Telegram as the only chat channel.
- Keep runtime selection between Claude and Codex.
- Keep daemon control, health checks, and local-session continuation.
- Keep Telegram private chat, groups, and topics aligned with the current Codex runtime behavior.
- Do not reintroduce Discord, Feishu/Lark, QQ, or Weixin flows.

## Commands
- `setup`: explain the config file and required steps
- `start`: run `bash scripts/daemon.sh start`
- `stop`: run `bash scripts/daemon.sh stop`
- `status`: run `bash scripts/daemon.sh status`
- `logs [N]`: run `bash scripts/daemon.sh logs N`
- `doctor`: run `bash scripts/doctor.sh`
- `reconfigure`: show the current config path and explain which fields to edit

## This Install
- Absolute data home: `$HOME/.claude-to-im/`
- Absolute config file: `$HOME/.claude-to-im/config.env`
- Launch/runtime invariant: this install must run with `CTI_HOME=$HOME/.claude-to-im` when starting, stopping, checking, or regenerating launchd.
- Default runtime if unset: `claude`; Codex runs when `CTI_RUNTIME=codex`, or when `auto` falls back to Codex.
- Bridge session records and bindings live under `$HOME/.claude-to-im/data/`.
- Local Codex history shown in `/sessions` does **not** come only from `$HOME/.claude-to-im/`; it is discovered from local Codex session files, usually under `~/.codex/`, or from `CTI_CODEX_SESSIONS_ROOT` if that override is set.

## Expected Behavior
- Let the owner continue a local Codex session from Telegram private chat, groups, and topics
- Keep group use owner-only by default through owner / allowlist checks
- Keep one separate bound session per Telegram topic
- Show local Codex history in `/sessions`
- Do not surface local Claude-runtime history when running the Codex runtime
- Ignore slash-command-only titles when naming local Codex sessions
- Keep the current active session easy to resume from Telegram

## Setup flow
1. Ensure `npm install` and `npm run build` have been run.
2. Create `~/.claude-to-im/config.env` from `config.env.example`.
3. Set Telegram fields (bot token, owner user ID, allowlist, etc.).
4. For group use, set `CTI_TG_REQUIRE_PRIVATE_CHAT=false`.
5. In BotFather, disable group privacy for the bot so normal group messages reach the bridge.
6. `CTI_ENABLED_CHANNELS=telegram` is already the code default; explain it when asked, but it is not the special fix for most setups.
7. Start the daemon.

## Session and binding behavior

- Session records live in `~/.claude-to-im/data/sessions.json`.
- Telegram window/topic bindings live in `~/.claude-to-im/data/bindings.json`.
- Message history lives in `~/.claude-to-im/data/messages/`.
- Restarting the daemon should keep using the same bound session because those files are loaded again on startup.
- A Telegram window or topic does not need a fresh `/bind` after a normal restart.
- If a window or topic has never been bound before, the first normal message should create a session automatically.
- Topic-enabled groups should keep one separate session per topic instead of one shared group session.
- If a bridge session already has an `sdk_session_id`, `/sessions` may merge that with matching local Codex history so the same underlying session is not listed twice.

## When rebind is actually needed

- Rebind only if the wrong session was bound on purpose or by mistake.
- Rebind if `bindings.json` was deleted, reset, or replaced.
- Rebind if you want that Telegram window/topic to point at a different local session.
- Do not rebind just because the daemon was restarted.

## `/sessions` and `/bind`
- `/sessions` shows the current bound session first, then other recent bridge sessions, then eligible local Codex sessions that are not already represented.
- `/bind` accepts the full session id or a unique prefix.
- `/bind` can match a bridge session id, a stored `sdk_session_id`, or a discovered local Codex session id.
- If a short prefix matches more than one session, the bridge should reject it as ambiguous instead of guessing.

## Current expected behavior
- Default runtime should be Codex.
- Default mode should be `code`.
- `CTI_CLAUDE_EFFORT` is an optional override that only matters when this install is switched to `CTI_RUNTIME=claude` as fallback. Only describe its configured value if it is actually set in `config.env`; do not claim the code hard-defaults it to `high`.
- `/sessions` in Codex runtime should show local Codex history only.
- Local Codex session titles should ignore slash commands and prefer normal spoken prompts.
- The current session should always appear before other recent sessions in `/sessions`.
- Recent sessions should then be ordered by latest activity first.
- First normal message in a private chat, group, or topic should auto-create a session if none is bound yet.
- Topic-enabled groups should keep one separate session per topic.

## Key config fields to explain when asked

- `CTI_RUNTIME`: choose `codex`, `claude`, or `auto`
- `CTI_DEFAULT_WORKDIR`: default working directory for newly created bridge sessions
- `CTI_DEFAULT_MODEL`: default model for newly created bridge sessions when one is set
- `CTI_DEFAULT_MODE`: choose `code`, `plan`, or `ask`
- `CTI_CLAUDE_EFFORT`: Claude thinking strength override when this install is run as a Claude fallback
- `CTI_CLAUDE_SETTING_SOURCES`: Claude CLI setting sources for bridge sessions. Default is `user,project,local`, which loads global/project instructions and enabled plugins such as `codex@openai-codex`. Set to `none` only when SDK isolation is intentional. Because project/local settings can include hooks, MCP, permissions, and plugins, only `/cwd` into directories you trust.
- `CTI_CLAUDE_PLUGIN_DIRS`: optional comma-separated local Claude plugin directories to load for bridge sessions.
- `CTI_CODEX_PASS_MODEL`: whether the stored/default model is forwarded into Codex runtime calls
- `CTI_CODEX_SKIP_GIT_REPO_CHECK`: whether Codex is allowed to run outside a detected git repo
- `CTI_CODEX_APPROVAL_POLICY`, `CTI_CODEX_SANDBOX_MODE`, `CTI_CODEX_MODEL_REASONING_EFFORT`, `CTI_CODEX_NETWORK_ACCESS_ENABLED`, `CTI_CODEX_ADDITIONAL_DIRECTORIES`: Codex runtime overrides
- `CTI_TG_BOT_TOKEN`: Telegram bot token
- `CTI_TG_ALLOWED_USERS`: who may use the bot
- `CTI_TG_OWNER_USER_ID`: the owner lock
- `CTI_TG_REQUIRE_PRIVATE_CHAT`: whether groups/topics are allowed
- `CTI_AUTO_APPROVE`: whether permission prompts are skipped

## Response style
- Keep instructions short and concrete.
- Prefer direct commands over long explanations.
- If the bridge is broken, run `doctor` before guessing.
