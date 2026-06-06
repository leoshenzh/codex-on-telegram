# Contributing

Thanks for your interest in improving Codex on Telegram. This guide covers how
to set up a development environment, run the bridge locally, and submit changes.

## Project layout

Codex on Telegram is a thin host wrapper around a vendored Telegram bridge core:

- **`src/`** — the host wrapper this project maintains: the Codex runtime,
  on-disk persistence, and the reliability layer (watchdogs, retries, abort
  handling). Most contributions land here.
- **`lib/`** — the bridge core, vendored unchanged from op7418's
  [`claude-to-im`](./NOTICE). Avoid editing it directly; upstream fixes belong
  upstream. See [`SYNC.md`](./SYNC.md) for how the vendored copy is kept in sync.

This project is a derivative work of op7418's `claude-to-im` (MIT). See
[`NOTICE`](./NOTICE) for the full attribution.

## Development setup

Requirements: macOS and Node.js ≥ 20.

```bash
git clone https://github.com/leoshenzh/codex-on-telegram.git
cd codex-on-telegram
npm install
npm run build       # bundle via scripts/build.js
npm run typecheck   # tsc --noEmit
npm test            # node --test over src/__tests__/*.test.ts
```

`npm test` runs against a throwaway `CTI_HOME` (a temp dir), so it won't touch
your real configuration.

## Running the bridge locally

1. Create the config from the example template (the data home is
   `~/.claude-to-im/`):

   ```bash
   mkdir -p ~/.claude-to-im
   cp config.env.example ~/.claude-to-im/config.env
   ```

2. Edit `~/.claude-to-im/config.env` and set at least your runtime, bot token,
   owner/allowlist IDs, and default working directory. See
   [`config.env.example`](./config.env.example) for the full list.

3. Start the daemon and check its health:

   ```bash
   bash scripts/daemon.sh start
   bash scripts/doctor.sh        # health & config diagnostics
   ```

   Other daemon commands: `stop`, `status`, and `logs [N]`.

For one-off iteration you can also run the entry directly with `npm run dev`
(`tsx src/main.ts`).

## Code style

Match the existing TypeScript style and keep changes surgical. Prefer small,
focused edits over broad refactors, and follow the conventions already present
in the file you're touching.

## Branching and pull requests

1. Fork the repository.
2. Create a feature branch off `main`.
3. Keep each PR focused on a single change.
4. Before opening a PR, make sure both checks pass:

   ```bash
   npm run typecheck
   npm test
   ```

5. Open a PR against `main` with a clear description of what changed and why.

If your change affects the vendored core, explain why it can't be handled
upstream instead.
