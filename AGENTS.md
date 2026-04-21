## Scope
- This file applies to everything under `C:\Project\jclaw`.

## Time
- Use `Asia/Seoul` (`KST`, `UTC+09:00`) for all operational reasoning.
- Prefer absolute dates in `YYYY-MM-DD` form when discussing schedules, cron runs, logs, or incidents.

## Project Shape
- `web`, `telegram`, and `cron` are channels over the same product, not separate products.
- Prefer shared logic in `src/core/**` over copying behavior into each channel.
- Session state lives in the database, not in ad hoc files.

## Key Data
- Main DB: `data/jclaw.db`
- Session state and preferences:
  - `sessions`
  - `session_preferences`
  - `run_history`
  - `cron_jobs`
- Do not edit DB rows directly unless there is no safer path. Prefer store/CLI code paths.

## Runtime Expectations
- Web server: `jclaw-web`
- Telegram bot: `jclaw-telegram`
- Cron worker: `jclaw-cron`
- TypeScript/backend changes require restart of the affected PM2 processes.
- Static changes under `web/` usually do not require restart.
- Do not restart `jclaw-web` unless the user explicitly asks for it.

## Commands And Config
- Keep `.env.example` aligned with new environment-backed behavior.
- If a feature depends on per-session state, wire it through `session_preferences` or `sessions`, not process-local memory.
- For Codex prompt transport, prefer robust cross-platform behavior over shell-specific shortcuts.

## Editing Guidance
- Keep channel command surfaces consistent where practical.
- If behavior differs by channel, make the difference explicit in code and naming.
- Avoid introducing one-off logic in `src/apps/web/server.ts` or `src/apps/telegram/bot.ts` when it belongs in `src/core/**`.

## Verification
- Minimum validation after code changes:
  - `npm run -s build`
- If behavior changed in web/telegram/cron, verify the relevant runtime path, not just TypeScript build success.
