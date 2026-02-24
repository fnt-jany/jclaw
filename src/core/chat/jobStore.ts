import { randomBytes } from "node:crypto";
import { openDb } from "../db/database";
import type { CommandResult } from "../../shared/types";

export type ChatJobStatus = "pending" | "running" | "completed" | "failed";

export type ChatJobRecord = {
  id: string;
  chatId: string;
  sessionId: string;
  sessionSlot: string;
  prompt: string;
  status: ChatJobStatus;
  result: CommandResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ChatJobSummary = {
  id: string;
  status: ChatJobStatus;
  sessionSlot: string;
  createdAt: string;
  updatedAt: string;
};

export class ChatJobStore {
  private readonly db: ReturnType<typeof openDb>;

  constructor(dbFile: string) {
    this.db = openDb(dbFile);
  }

  async init(): Promise<void> {
    this.db
      .prepare(
        `UPDATE chat_jobs
         SET status = 'pending',
             updated_at = ?,
             started_at = NULL,
             error = NULL
         WHERE status = 'running'`
      )
      .run(new Date().toISOString());
  }

  createPending(input: { chatId: string; sessionId: string; sessionSlot: string; prompt: string }): ChatJobRecord {
    const now = new Date().toISOString();
    const id = `job_${Date.now()}_${randomBytes(2).toString("hex")}`;

    this.db
      .prepare(
        `INSERT INTO chat_jobs (
          id, chat_id, session_id, session_slot, prompt, status,
          result_reply, result_session_slot, result_session_name, result_log_enabled,
          error, created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`
      )
      .run(id, input.chatId, input.sessionId, input.sessionSlot, input.prompt, now, now);

    const job = this.get(id);
    if (!job) {
      throw new Error(`Failed to create chat job: ${id}`);
    }
    return job;
  }

  get(jobId: string): ChatJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, chat_id, session_id, session_slot, prompt, status,
                result_reply, result_session_slot, result_session_name, result_log_enabled,
                error, created_at, updated_at, started_at, finished_at
         FROM chat_jobs
         WHERE id = ?`
      )
      .get(jobId) as ChatJobRow | undefined;

    return row ? mapRow(row) : null;
  }

  listRecentBySlot(chatId: string, sessionSlot: string, limit = 20): ChatJobSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, status, session_slot, created_at, updated_at
         FROM chat_jobs
         WHERE chat_id = ? AND session_slot = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(chatId, sessionSlot, Math.max(1, limit)) as Array<{
      id: string;
      status: ChatJobStatus;
      session_slot: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      sessionSlot: row.session_slot,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  claimNextPending(): ChatJobRecord | null {
    const now = new Date().toISOString();

    const row = this.db
      .prepare(
        `SELECT id
         FROM chat_jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as { id: string } | undefined;

    if (!row) {
      return null;
    }

    const updated = this.db
      .prepare(
        `UPDATE chat_jobs
         SET status = 'running', updated_at = ?, started_at = ?, error = NULL
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, now, row.id);

    if (updated.changes === 0) {
      return null;
    }

    return this.get(row.id);
  }

  markCompleted(jobId: string, result: CommandResult): ChatJobRecord | null {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE chat_jobs
         SET status = 'completed',
             updated_at = ?,
             finished_at = ?,
             result_reply = ?,
             result_session_slot = ?,
             result_session_name = ?,
             result_log_enabled = ?,
             error = NULL
         WHERE id = ?`
      )
      .run(
        now,
        now,
        result.reply,
        result.sessionSlot,
        result.sessionName,
        result.logEnabled ? 1 : 0,
        jobId
      );

    return this.get(jobId);
  }

  markFailed(jobId: string, errorText: string): ChatJobRecord | null {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE chat_jobs
         SET status = 'failed',
             updated_at = ?,
             finished_at = ?,
             error = ?
         WHERE id = ?`
      )
      .run(now, now, errorText, jobId);

    return this.get(jobId);
  }

  prune(maxRows: number): void {
    const max = Math.max(100, maxRows);
    const countRow = this.db
      .prepare("SELECT COUNT(1) as cnt FROM chat_jobs")
      .get() as { cnt: number };

    if (countRow.cnt <= max) {
      return;
    }

    const overflow = countRow.cnt - max;
    this.db
      .prepare(
        `DELETE FROM chat_jobs
         WHERE id IN (
           SELECT id
           FROM chat_jobs
           WHERE status IN ('completed', 'failed')
           ORDER BY updated_at ASC
           LIMIT ?
         )`
      )
      .run(overflow);
  }
}

type ChatJobRow = {
  id: string;
  chat_id: string;
  session_id: string;
  session_slot: string;
  prompt: string;
  status: ChatJobStatus;
  result_reply: string | null;
  result_session_slot: string | null;
  result_session_name: string | null;
  result_log_enabled: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function mapRow(row: ChatJobRow): ChatJobRecord {
  const result =
    row.status === "completed" && row.result_reply && row.result_session_slot && row.result_session_name
      ? {
          reply: row.result_reply,
          sessionSlot: row.result_session_slot,
          sessionName: row.result_session_name,
          logEnabled: row.result_log_enabled === 1
        }
      : null;

  return {
    id: row.id,
    chatId: row.chat_id,
    sessionId: row.session_id,
    sessionSlot: row.session_slot,
    prompt: row.prompt,
    status: row.status,
    result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}
