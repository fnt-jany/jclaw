# data folder

Runtime primary store is SQLite (`jclaw.db`).

## Files

- `jclaw.db`: primary runtime DB (sessions, runs, cron jobs)
- `jclaw.db-wal`, `jclaw.db-shm`: SQLite WAL sidecar files
- `interactions.json`: interaction log file (`/log on` when enabled)
- `manual-slot-bindings.json`: manual slot<->codex mapping import/export file

## Manual slot mapping workflow

1. Export current bindings

```powershell
npm run admin:slots -- export --chat <chat_id> --out data/manual-slot-bindings.json
```

2. Edit `data/manual-slot-bindings.json`

3. Import back

```powershell
npm run admin:slots -- import --file data/manual-slot-bindings.json
```
