# Claude-to-IM

Telegram-only shared bridge core for local Claude/Codex host wrappers.

## Includes

- Telegram adapter
- Bridge manager
- Session routing
- Delivery, retry, and dedup
- Permission callback handling
- Input validation and rate limiting
- Local Codex session discovery

## Does not include

- Any non-Telegram channel
- Host-side login or device management
- Multi-platform deployment guides

## Verify

```bash
npm run typecheck
npm run test:unit
npm run build
```
