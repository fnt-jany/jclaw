import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const connections = new Map<string, Database.Database>();

type TableInfoRow = {
  name: string;
};

function ensureActiveSessionsTable(db: Database.Database): void {
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'active_sessions'")
    .get() as TableInfoRow | undefined;

  if (!tableRow) {
    db.exec(`
      CREATE TABLE active_sessions (
        chat_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY(chat_id, channel)
      );
    `);
    return;
  }

  const columns = db
    .prepare("PRAGMA table_info(active_sessions)")
    .all() as Array<{ name: string }>;
  const hasChannel = columns.some((col) => col.name === "channel");
  if (hasChannel) {
    return;
  }

  db.exec(`
    ALTER TABLE active_sessions RENAME TO active_sessions_legacy;

    CREATE TABLE active_sessions (
      chat_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY(chat_id, channel)
    );

    INSERT INTO active_sessions(chat_id, channel, session_id)
    SELECT chat_id, 'shared', session_id
    FROM active_sessions_legacy;

    DROP TABLE active_sessions_legacy;
  `);
}




function ensureCronJobsTable(db: Database.Database): void {
  const columns = db
    .prepare("PRAGMA table_info(cron_jobs)")
    .all() as Array<{ name: string }>;
  const hasRunOnce = columns.some((col) => col.name === "run_once");
  if (hasRunOnce) {
    return;
  }

  db.exec(`
    ALTER TABLE cron_jobs ADD COLUMN run_once INTEGER NOT NULL DEFAULT 0;
  `);
}


function ensureSessionPreferencesTable(db: Database.Database): void {
  const columns = db
    .prepare("PRAGMA table_info(session_preferences)")
    .all() as Array<{ name: string }>;
  const hasReasoningEffort = columns.some((col) => col.name === "reasoning_effort");
  if (hasReasoningEffort) {
    return;
  }

  db.exec(`
    ALTER TABLE session_preferences ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'none';
  `);
}

function ensureSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL,
      chat_id TEXT,
      codex_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_chat_slot
      ON sessions(chat_id, short_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_chat
      ON sessions(chat_id);

    CREATE TABLE IF NOT EXISTS run_history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      error TEXT,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_history_session_ts
      ON run_history(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS active_sessions (
      chat_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY(chat_id, channel)
    );

    CREATE TABLE IF NOT EXISTS chat_meta (
      chat_id TEXT PRIMARY KEY,
      next_slot INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_preferences (
      chat_id TEXT PRIMARY KEY,
      plan_mode INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_preferences (
      session_id TEXT PRIMARY KEY,
      plan_mode INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT NOT NULL DEFAULT 'none'
    );

    CREATE TABLE IF NOT EXISTS interaction_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL,
      last_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_id TEXT,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      error TEXT,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_jobs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_slot TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      result_reply TEXT,
      result_session_slot TEXT,
      result_session_name TEXT,
      result_log_enabled INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_jobs_status_created
      ON chat_jobs(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_chat_jobs_slot_updated
      ON chat_jobs(chat_id, session_slot, updated_at);

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      session_target TEXT NOT NULL,
      cron TEXT NOT NULL,
      prompt TEXT NOT NULL,
      timezone TEXT,
      run_once INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_due
      ON cron_jobs(enabled, next_run_at);
  `);

  ensureActiveSessionsTable(db);
  ensureCronJobsTable(db);
  ensureSessionPreferencesTable(db);
}

export function openDb(dbFile: string): Database.Database {
  const resolved = path.resolve(dbFile);
  const existing = connections.get(resolved);
  if (existing) {
    return existing;
  }

  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  ensureSchema(db);
  connections.set(resolved, db);
  return db;
}
