import { randomBytes } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { openDb } from "../db/database";

const DEFAULT_CRON_TIMEZONE = "Asia/Seoul";
const MOJIBAKE_PATTERN = /(?:[\u00c3\u00c2\u00e2][\u0080-\u00ff]?|[\u00ec\u00ed\u00eb\u00ea][\u0080-\u00ff]?|\uFFFD|\?{3,})/;

export type CronJob = {
  id: string;
  enabled: boolean;
  chatId: string;
  sessionTarget: string;
  cron: string;
  prompt: string;
  timezone: string | null;
  runOnce: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateCronJobInput = {
  chatId: string;
  sessionTarget: string;
  cron: string;
  prompt: string;
  timezone?: string | null;
  runOnce?: boolean;
};

export class CronStore {
  private readonly db: ReturnType<typeof openDb>;

  constructor(dbFile: string) {
    this.db = openDb(dbFile);
  }

  async init(): Promise<void> {
    return;
  }

  async reload(): Promise<void> {
    return;
  }

  list(): CronJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, enabled, chat_id, session_target, cron, prompt, timezone, run_once, next_run_at,
                last_run_at, last_status, last_error, created_at, updated_at
         FROM cron_jobs
         ORDER BY created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapCronRow);
  }

  get(id: string): CronJob | null {
    const row = this.db
      .prepare(
        `SELECT id, enabled, chat_id, session_target, cron, prompt, timezone, run_once, next_run_at,
                last_run_at, last_status, last_error, created_at, updated_at
         FROM cron_jobs
         WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    return row ? mapCronRow(row) : null;
  }

  async create(input: CreateCronJobInput): Promise<CronJob> {
    const now = new Date().toISOString();
    const id = `cj_${randomBytes(3).toString("hex")}`;
    const timezone = normalizeCronTimezone(input.timezone ?? null);
    const nextRunAt = computeNextRunAt(input.cron, timezone, new Date());
    warnIfSuspiciousPromptEncoding(id, input.prompt);

    this.db
      .prepare(
        `INSERT INTO cron_jobs (
          id, enabled, chat_id, session_target, cron, prompt, timezone, run_once,
          next_run_at, last_run_at, last_status, last_error, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.chatId,
        input.sessionTarget,
        input.cron,
        input.prompt,
        timezone,
        input.runOnce ? 1 : 0,
        nextRunAt,
        now,
        now
      );

    const created = this.get(id);
    if (!created) {
      throw new Error(`Failed to create cron job: ${id}`);
    }
    return created;
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async setEnabled(id: string, enabled: boolean): Promise<CronJob | null> {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }

    const nextRunAt = enabled ? computeNextRunAt(existing.cron, normalizeCronTimezone(existing.timezone), new Date()) : existing.nextRunAt;
    this.db
      .prepare(
        `UPDATE cron_jobs
         SET enabled = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(enabled ? 1 : 0, nextRunAt, new Date().toISOString(), id);

    return this.get(id);
  }

  dueJobs(now = new Date()): CronJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, enabled, chat_id, session_target, cron, prompt, timezone, run_once, next_run_at,
                last_run_at, last_status, last_error, created_at, updated_at
         FROM cron_jobs
         WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC`
      )
      .all(now.toISOString()) as Array<Record<string, unknown>>;

    return rows.map(mapCronRow);
  }

  async markRunResult(id: string, ok: boolean, errorText: string | null, completedAt = new Date()): Promise<CronJob | null> {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }

    const nextRunAt = computeNextRunAt(existing.cron, normalizeCronTimezone(existing.timezone), completedAt);
    this.db
      .prepare(
        `UPDATE cron_jobs
         SET last_run_at = ?,
             last_status = ?,
             last_error = ?,
             next_run_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        completedAt.toISOString(),
        ok ? "ok" : "error",
        ok ? null : errorText,
        nextRunAt,
        new Date().toISOString(),
        id
      );

    return this.get(id);
  }
}

function warnIfSuspiciousPromptEncoding(jobId: string, prompt: string): void {
  if (!MOJIBAKE_PATTERN.test(prompt)) {
    return;
  }
  const preview = prompt.replace(/\r?\n/g, "\\n").slice(0, 160);
  console.warn(`[cron] suspicious prompt encoding job=${jobId} prompt=${preview}`);
}

function mapCronRow(row: Record<string, unknown>): CronJob {
  return {
    id: String(row.id),
    enabled: Number(row.enabled) === 1,
    chatId: String(row.chat_id),
    sessionTarget: String(row.session_target),
    cron: String(row.cron),
    prompt: String(row.prompt),
    timezone: normalizeCronTimezone(row.timezone ? String(row.timezone) : null),
    runOnce: Number(row.run_once) === 1,
    nextRunAt: String(row.next_run_at),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastStatus: row.last_status ? (String(row.last_status) as "ok" | "error") : null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeCronTimezone(timezone: string | null | undefined): string {
  const value = (timezone ?? "").trim();
  return value || DEFAULT_CRON_TIMEZONE;
}

export function computeNextRunAt(cronExpr: string, timezone: string | null, from: Date): string {
  const tz = normalizeCronTimezone(timezone);
  const expr = CronExpressionParser.parse(cronExpr, {
    currentDate: from,
    tz
  });
  return expr.next().toDate().toISOString();
}
