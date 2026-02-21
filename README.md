# jclaw (TypeScript)

jclaw shares Codex sessions across Telegram, Windows CLI, Web, and a Cron worker.

## Install

```powershell
npm install
```

## Configure

```powershell
Copy-Item .env.example .env
```

Main `.env` values:

- `TELEGRAM_BOT_TOKEN`: from BotFather
- `ALLOWED_CHAT_IDS`: allowed chat ids (comma-separated)
- `DATA_FILE`: legacy JSON path for migration/manual compatibility (`./data/sessions.json`)
- `DB_FILE`: SQLite file path (default `./data/jclaw.db`)
- `CODEX_COMMAND`, `CODEX_ARGS_TEMPLATE`, `CODEX_WORKDIR`

`CODEX_COMMAND=auto` tries PATH first, then VS Code extension paths on Windows.

## Run Channels

- Telegram bot: `npm run dev`
- CLI one-shot: `npm run cli -- [--chat <chat_id>] [--session <A-Z|id|prefix>] "prompt"`
- CLI chat mode: `npm run chat -- [--chat <chat_id>] [--session <A-Z|id|prefix>]`
- Web chat: `npm run web` (open `http://127.0.0.1:3100`)
- Cron worker: `npm run cron:worker`
- Cron management CLI: `npm run cron:cli -- list|add|remove|enable|disable ...`

## Slot Policy

- Slots: `A` to `Z` (max 26)
- New session cycle: `A -> B -> ... -> Z -> A`
- `/session` and `--session` accept slot letter, full id, or unique prefix

## Slot Binding (Manual-Friendly)

Runtime commands:

- `/slot list`
- `/slot show <A-Z>`
- `/slot bind <A-Z> <codex_session_id>`

Admin CLI:

```powershell
npm run admin:slots -- list --chat <chat_id>
npm run admin:slots -- bind --chat <chat_id> --slot J --codex <codex_session_id>
npm run admin:slots -- export --chat <chat_id> --out data/manual-slot-bindings.json
npm run admin:slots -- import --file data/manual-slot-bindings.json
```

`data/manual-slot-bindings.json` lets you edit slot?codex mapping manually and re-import.

## Common Slash Commands

- `/help`
- `/new`
- `/session <A-Z|id|prefix>`
- `/history [n]`
- `/where`
- `/whoami`
- `/log <on|off|status>`
- `/cron ...`
- `/slot ...`

## Storage

- Primary runtime store: SQLite (`data/jclaw.db` by default)
- Legacy JSON files are read for one-time migration and manual workflows

## Build

```powershell
npm run build
```

## Git Setup

```powershell
git init
git add .
git commit -m "chore: bootstrap jclaw"
```
