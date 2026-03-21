# jclaw (TypeScript)

jclaw shares LLM sessions across Telegram, Windows CLI, Web, and a Cron worker.

## Install

```powershell
npm install
```

## Ubuntu VM Setup (Codex First)

If you want to run jclaw on an Ubuntu VM, install and authenticate `codex` first.
`jclaw` does not perform OpenAI OAuth itself. It launches the `codex` CLI, so the Linux user that runs `jclaw` must already be logged in to `codex`.

Recommended order:

1. SSH into the VM as the same Linux user that will run `pm2` or `systemd`
2. Install Node.js and basic packages
3. Install `@openai/codex`
4. Run `codex login --device-auth`
5. Confirm `codex login status`
6. Clone and configure `jclaw`
7. Run `jclaw` under the same Linux user

Example setup on Ubuntu:

```bash
ssh -i ~/.ssh/your-key.pem ubuntu@<VM_IP>
sudo apt update
sudo apt install -y curl git build-essential nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g @openai/codex pm2
codex --version
codex login --device-auth
codex login status
```

Important:

- `codex` credentials are stored per Linux user
- if you log in as `ubuntu` but run `pm2` as `root` or another user, `jclaw` will not see that login
- complete `codex login` as the same user that will run `jclaw`

Then install `jclaw`:

```bash
git clone <repo-url> /srv/apps/jclaw
cd /srv/apps/jclaw
cp .env.example .env
npm install
npm run build
```

Minimal checks before starting channels:

```bash
codex exec "reply with ok only"
npm run web
npm run dev
```

For process management on Ubuntu, PM2 is the simplest starting point:

```bash
pm2 start ecosystem.web.cjs
pm2 start ecosystem.telegram.cjs
pm2 save
pm2 startup
```

## Configure

```powershell
Copy-Item .env.example .env
```

Main `.env` values:

- `TELEGRAM_BOT_TOKEN`: from BotFather
- `ALLOWED_CHAT_IDS`: allowed chat ids (comma-separated)
- `DATA_FILE`: interaction log JSON path (`./data/interactions.json`)
- `DB_FILE`: SQLite file path (default `./data/jclaw.db`)
- `CODEX_COMMAND`, `CODEX_ARGS_TEMPLATE`, `CODEX_WORKDIR`
- `CRON_NOTIFY_TELEGRAM`: cron result Telegram notification on/off (`true|false`)
- `CRON_NOTIFY_MAX_CHARS`: max chars per cron notification message
- `CRON_NOTIFY_VERBOSE`: detailed cron notification (`true`) or compact output (`false`)

`CODEX_COMMAND=auto` tries PATH first, then VS Code extension paths on Windows.

## Web Auth Cookie Notes

For direct HTTP access during initial VM setup, use:

```env
WEB_ALLOWED_ORIGINS=http://<VM_IP>:3100
WEB_AUTH_COOKIE_SAMESITE=Lax
WEB_AUTH_COOKIE_SECURE=false
```

Meaning:

- `WEB_AUTH_COOKIE_SECURE`: send the auth cookie only over HTTPS when `true`; for direct `http://<VM_IP>:3100` testing keep it `false`
- `WEB_AUTH_COOKIE_SAMESITE`: cookie cross-site policy; `Lax` is the safest default for direct browser access
- `WEB_ALLOWED_ORIGINS`: must exactly match the browser origin, including protocol and port

For a real HTTPS domain later, switch to:

```env
WEB_ALLOWED_ORIGINS=https://your-domain.example
WEB_AUTH_COOKIE_SAMESITE=Lax
WEB_AUTH_COOKIE_SECURE=true
```

## Entry Points

- `src/main/web.ts`: web process entry
- `src/main/telegram.ts`: telegram process entry
- `src/main/cli.ts`: cli entry (`oneshot`/`chat`)
- `src/main/cron.ts`: cron entry (`worker`/`cli`)
- `src/main/tools.ts`: ops tools entry (`slots`)

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
- `/slot bind <A-Z> <thread_id>`

Ops CLI:

```powershell
npm run ops:slots -- list --chat <chat_id>
npm run ops:slots -- bind --chat <chat_id> --slot J --thread <thread_id> [--provider <provider>]
npm run ops:slots -- export --chat <chat_id> --out data/manual-slot-bindings.json
npm run ops:slots -- import --file data/manual-slot-bindings.json
```

`data/manual-slot-bindings.json` lets you edit slot-provider-thread mapping manually and re-import.

## Common Slash Commands

- `/help`
- `/new`
- `/session <A-Z|id|prefix>`
- `/history [n]`
- `/where`
- `/whoami`
- `/log <on|off|status>`
- `/plan <on|off|status>`
- `/cron ...`
- `/slot ...`
- `/status` / `/restart`

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

## Telegram Restart Ops

Use `/restart` from an allowed chat to restart the bot process.
Run the bot under PM2 so it auto-recovers after exit:

```powershell
npm install -g pm2
npm run pm2:telegram:start
```

Useful commands:

```powershell
npm run pm2:telegram:restart
npm run pm2:telegram:stop
npm run pm2:telegram:logs
```



