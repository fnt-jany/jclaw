import { randomBytes } from "node:crypto";
import { deleteCodexSessionFiles } from "../codex/sessionFiles";
import { openDb } from "../db/database";
import { SLOT_IDS, type SlotId } from "../../shared/constants";

export type RunRecord = {
  id: string;
  timestamp: string;
  input: string;
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
};

export type Session = {
  id: string;
  shortId: SlotId;
  chatId: string | null;
  codexSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  history: RunRecord[];
};

export type ActiveSessionChannel = "telegram" | "web" | "cli" | "shared";
export type ReasoningEffort = "none" | "low" | "medium" | "high";

const DEFAULT_ACTIVE_CHANNEL: ActiveSessionChannel = "shared";

export class SessionStore {
  private readonly dbFile: string;
  private readonly db: ReturnType<typeof openDb>;

  constructor(dbFile: string) {
    this.dbFile = dbFile;
    this.db = openDb(this.dbFile);
  }

  async init(): Promise<void> {
    this.normalizeStore();
  }

  getOrCreateSessionByChat(chatId: string, channel: ActiveSessionChannel = DEFAULT_ACTIVE_CHANNEL): Session {
    const active = this.db
      .prepare("SELECT session_id FROM active_sessions WHERE chat_id = ? AND channel = ?")
      .get(chatId, channel) as { session_id: string } | undefined;

    if (active) {
      const session = this.getSession(active.session_id);
      if (session) {
        return session;
      }
    }

    if (channel !== DEFAULT_ACTIVE_CHANNEL) {
      const shared = this.db
        .prepare("SELECT session_id FROM active_sessions WHERE chat_id = ? AND channel = ?")
        .get(chatId, DEFAULT_ACTIVE_CHANNEL) as { session_id: string } | undefined;
      if (shared) {
        const sharedSession = this.getSession(shared.session_id);
        if (sharedSession) {
          this.upsertActiveSession(chatId, channel, sharedSession.id);
          return sharedSession;
        }
      }
    }

    return this.createAndActivateSession(chatId, channel);
  }

  createSession(chatId: string | null, shortId?: SlotId): Session {
    const now = new Date().toISOString();
    const slot = shortId ?? "A";
    return {
      id: this.generateSessionId(chatId, slot),
      shortId: slot,
      chatId,
      codexSessionId: null,
      createdAt: now,
      updatedAt: now,
      history: []
    };
  }

  createAndActivateSession(chatId: string, channel: ActiveSessionChannel = DEFAULT_ACTIVE_CHANNEL): Session {
    const slot = this.allocateNextSlot(chatId);
    this.removeSessionByChatAndSlot(chatId, slot);

    const session = this.createSession(chatId, slot);
    this.db
      .prepare(
        `INSERT INTO sessions (id, short_id, chat_id, codex_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.shortId, session.chatId, session.codexSessionId, session.createdAt, session.updatedAt);

    this.upsertActiveSession(chatId, channel, session.id);

    return session;
  }


  recreateSessionAtSlot(chatId: string, slot: SlotId, channel: ActiveSessionChannel = DEFAULT_ACTIVE_CHANNEL): Session {
    this.removeSessionByChatAndSlot(chatId, slot);

    const session = this.createSession(chatId, slot);
    this.db
      .prepare(
        `INSERT INTO sessions (id, short_id, chat_id, codex_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.shortId, session.chatId, session.codexSessionId, session.createdAt, session.updatedAt);

    this.upsertActiveSession(chatId, channel, session.id);

    return session;
  }

  setActiveSession(chatId: string, sessionIdOrPrefix: string, channel: ActiveSessionChannel = DEFAULT_ACTIVE_CHANNEL): Session {
    const resolvedId = this.resolveSessionId(sessionIdOrPrefix, chatId);
    if (!resolvedId) {
      const slot = sessionIdOrPrefix.trim().toUpperCase() as SlotId;
      if (SLOT_IDS.includes(slot)) {
        return this.recreateSessionAtSlot(chatId, slot, channel);
      }
      throw new Error(`Session not found: ${sessionIdOrPrefix}`);
    }

    const existing = this.getSession(resolvedId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionIdOrPrefix}`);
    }

    // If moved across chats, keep slot uniqueness in target chat.
    if (existing.chatId !== chatId) {
      this.removeSessionByChatAndSlot(chatId, existing.shortId);
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET chat_id = ?, updated_at = ? WHERE id = ?")
      .run(chatId, now, resolvedId);

    this.upsertActiveSession(chatId, channel, resolvedId);

    const updated = this.getSession(resolvedId);
    if (!updated) {
      throw new Error(`Session not found: ${resolvedId}`);
    }
    return updated;
  }

  resolveSessionId(sessionIdOrPrefix: string, chatId?: string): string | null {
    const exact = this.db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionIdOrPrefix) as { id: string } | undefined;
    if (exact) {
      return exact.id;
    }

    const target = sessionIdOrPrefix.trim();
    if (!target) {
      return null;
    }

    const candidates = chatId
      ? (this.db.prepare("SELECT id, short_id FROM sessions WHERE chat_id = ?").all(chatId) as Array<{ id: string; short_id: string }>)
      : (this.db.prepare("SELECT id, short_id FROM sessions").all() as Array<{ id: string; short_id: string }>);

    const normalizedSlot = target.toUpperCase();
    const slotMatches = candidates.filter((s) => s.short_id.toUpperCase() === normalizedSlot);
    if (slotMatches.length === 1) {
      return slotMatches[0].id;
    }
    if (slotMatches.length > 1) {
      throw new Error(`Ambiguous slot id: ${target}`);
    }

    const prefixMatches = candidates.filter((s) => s.id.startsWith(target));
    if (prefixMatches.length === 1) {
      return prefixMatches[0].id;
    }
    if (prefixMatches.length > 1) {
      throw new Error(`Ambiguous session id prefix: ${sessionIdOrPrefix}`);
    }

    return null;
  }

  ensureSessionForTarget(chatId: string, target: string): Session {
    const resolved = this.resolveSessionId(target, chatId);
    if (resolved) {
      const existing = this.getSession(resolved);
      if (!existing) {
        throw new Error(`Session not found: ${target}`);
      }
      return existing;
    }

    const slot = target.trim().toUpperCase() as SlotId;
    if (!SLOT_IDS.includes(slot)) {
      throw new Error(`Session not found: ${target}`);
    }

    const session = this.createSession(chatId, slot);
    this.db
      .prepare(
        `INSERT INTO sessions (id, short_id, chat_id, codex_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.shortId, session.chatId, session.codexSessionId, session.createdAt, session.updatedAt);

    return session;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT id, short_id, chat_id, codex_session_id, created_at, updated_at
         FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string;
          short_id: string;
          chat_id: string | null;
          codex_session_id: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      shortId: row.short_id as SlotId,
      chatId: row.chat_id,
      codexSessionId: row.codex_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      history: this.listHistory(sessionId, Number.MAX_SAFE_INTEGER)
    };
  }

  setCodexSessionId(sessionId: string, codexSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET codex_session_id = ?, updated_at = ? WHERE id = ?")
      .run(codexSessionId, new Date().toISOString(), sessionId);
  }

  bindCodexSession(chatId: string, slot: string, codexSessionId: string): Session {
    const slotId = slot.toUpperCase() as SlotId;
    if (!SLOT_IDS.includes(slotId)) {
      throw new Error(`Invalid slot id: ${slot}`);
    }

    const row = this.db
      .prepare("SELECT id FROM sessions WHERE chat_id = ? AND short_id = ?")
      .get(chatId, slotId) as { id: string } | undefined;

    if (row) {
      this.setCodexSessionId(row.id, codexSessionId);
      const session = this.getSession(row.id);
      if (!session) {
        throw new Error(`Session not found: ${row.id}`);
      }
      return session;
    }

    const session = this.createSession(chatId, slotId);
    session.codexSessionId = codexSessionId;
    session.updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (id, short_id, chat_id, codex_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.shortId, session.chatId, session.codexSessionId, session.createdAt, session.updatedAt);

    return session;
  }

  listSlotBindings(chatId: string): Array<{ slotId: SlotId; sessionId: string; codexSessionId: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT short_id, id, codex_session_id
         FROM sessions
         WHERE chat_id = ?
         ORDER BY short_id ASC`
      )
      .all(chatId) as Array<{ short_id: string; id: string; codex_session_id: string | null }>;

    return rows.map((row) => ({
      slotId: row.short_id as SlotId,
      sessionId: row.id,
      codexSessionId: row.codex_session_id
    }));
  }

  getPlanMode(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT plan_mode FROM session_preferences WHERE session_id = ?")
      .get(sessionId) as { plan_mode: number } | undefined;
    return !!row?.plan_mode;
  }

  setPlanMode(sessionId: string, enabled: boolean): boolean {
    this.db
      .prepare(
        `INSERT INTO session_preferences(session_id, plan_mode) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET plan_mode = excluded.plan_mode`
      )
      .run(sessionId, enabled ? 1 : 0);
    return this.getPlanMode(sessionId);
  }

  getReasoningEffort(sessionId: string): ReasoningEffort {
    const row = this.db
      .prepare("SELECT reasoning_effort FROM session_preferences WHERE session_id = ?")
      .get(sessionId) as { reasoning_effort: string } | undefined;

    const value = (row?.reasoning_effort ?? "none").toLowerCase();
    if (value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return "none";
  }

  setReasoningEffort(sessionId: string, effort: ReasoningEffort): ReasoningEffort {
    this.db
      .prepare(
        `INSERT INTO session_preferences(session_id, reasoning_effort)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET reasoning_effort = excluded.reasoning_effort`
      )
      .run(sessionId, effort);

    return this.getReasoningEffort(sessionId);
  }

  appendRun(sessionId: string, run: RunRecord): Session {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.db
      .prepare(
        `INSERT INTO run_history (id, session_id, timestamp, input, output, error, exit_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, sessionId, run.timestamp, run.input, run.output, run.error, run.exitCode, run.durationMs);

    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sessionId);

    const updated = this.getSession(sessionId);
    if (!updated) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return updated;
  }

  listHistory(sessionId: string, limit = 10): RunRecord[] {
    const exists = this.db
      .prepare("SELECT 1 as ok FROM sessions WHERE id = ?")
      .get(sessionId) as { ok: number } | undefined;

    if (!exists) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const rows = this.db
      .prepare(
        `SELECT id, timestamp, input, output, error, exit_code, duration_ms
         FROM run_history
         WHERE session_id = ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(sessionId, Math.max(1, limit)) as Array<{
      id: string;
      timestamp: string;
      input: string;
      output: string;
      error: string | null;
      exit_code: number | null;
      duration_ms: number;
    }>;

    return rows
      .reverse()
      .map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        input: row.input,
        output: row.output,
        error: row.error,
        exitCode: row.exit_code,
        durationMs: row.duration_ms
      }));
  }

  private allocateNextSlot(chatId: string): SlotId {
    const row = this.db
      .prepare("SELECT next_slot FROM chat_meta WHERE chat_id = ?")
      .get(chatId) as { next_slot: number } | undefined;

    const idx = row?.next_slot ?? 0;
    const next = SLOT_IDS[idx % SLOT_IDS.length];

    this.db
      .prepare(
        `INSERT INTO chat_meta(chat_id, next_slot) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET next_slot = excluded.next_slot`
      )
      .run(chatId, (idx + 1) % SLOT_IDS.length);

    return next;
  }

  private removeSessionByChatAndSlot(chatId: string, slot: SlotId): void {
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE chat_id = ? AND short_id = ?")
      .get(chatId, slot) as { id: string } | undefined;

    if (!existing) {
      return;
    }

    this.removeSession(existing.id);
  }

  private removeSession(sessionId: string): void {
    const existing = this.db
      .prepare("SELECT id, chat_id, codex_session_id FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; chat_id: string | null; codex_session_id: string | null } | undefined;

    if (!existing) {
      return;
    }

    this.db.prepare("DELETE FROM run_history WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM session_preferences WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    if (existing.chat_id) {
      this.db
        .prepare("DELETE FROM active_sessions WHERE chat_id = ? AND session_id = ?")
        .run(existing.chat_id, sessionId);
    }

    if (existing.codex_session_id) {
      const stillReferenced = this.db
        .prepare("SELECT COUNT(1) as cnt FROM sessions WHERE codex_session_id = ?")
        .get(existing.codex_session_id) as { cnt: number };
      if (stillReferenced.cnt === 0) {
        void deleteCodexSessionFiles(existing.codex_session_id);
      }
    }
  }


  private upsertActiveSession(chatId: string, channel: ActiveSessionChannel, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO active_sessions(chat_id, channel, session_id) VALUES (?, ?, ?)
         ON CONFLICT(chat_id, channel) DO UPDATE SET session_id = excluded.session_id`
      )
      .run(chatId, channel, sessionId);
  }

  private generateSessionId(chatId: string | null, slot: SlotId): string {
    const suffix = randomBytes(3).toString("hex").slice(0, 5);
    const chatTag = (chatId ?? "local").replace(/[^a-zA-Z0-9]/g, "").slice(-4).toLowerCase() || "locl";
    return `s_${chatTag}_${slot.toLowerCase()}_${suffix}`;
  }

  private normalizeStore(): void {
    const chatRows = this.db
      .prepare("SELECT DISTINCT chat_id FROM sessions WHERE chat_id IS NOT NULL")
      .all() as Array<{ chat_id: string }>;

    for (const { chat_id: chatId } of chatRows) {
      const asc = this.db
        .prepare("SELECT id FROM sessions WHERE chat_id = ? ORDER BY updated_at ASC")
        .all(chatId) as Array<{ id: string }>;

      const overflow = Math.max(0, asc.length - SLOT_IDS.length);
      for (let i = 0; i < overflow; i += 1) {
        this.removeSession(asc[i].id);
      }

      const kept = this.db
        .prepare("SELECT id, short_id, updated_at FROM sessions WHERE chat_id = ?")
        .all(chatId) as Array<{ id: string; short_id: string; updated_at: string }>;

      const claimed = new Set<SlotId>();
      const needsSlot: Array<{ id: string; updated_at: string }> = [];
      const newestFirst = [...kept].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      for (const row of newestFirst) {
        const slot = row.short_id as SlotId;
        if (SLOT_IDS.includes(slot) && !claimed.has(slot)) {
          claimed.add(slot);
        } else {
          needsSlot.push({ id: row.id, updated_at: row.updated_at });
        }
      }

      const freeSlots = SLOT_IDS.filter((slot) => !claimed.has(slot));
      for (let i = 0; i < needsSlot.length && i < freeSlots.length; i += 1) {
        this.db
          .prepare("UPDATE sessions SET short_id = ? WHERE id = ?")
          .run(freeSlots[i], needsSlot[i].id);
      }

      const next = this.db
        .prepare("SELECT next_slot FROM chat_meta WHERE chat_id = ?")
        .get(chatId) as { next_slot: number } | undefined;
      if (!next || next.next_slot < 0 || next.next_slot >= SLOT_IDS.length) {
        const occupiedRows = this.db
          .prepare("SELECT short_id FROM sessions WHERE chat_id = ?")
          .all(chatId) as Array<{ short_id: string }>;
        const occupied = new Set(occupiedRows.map((r) => SLOT_IDS.indexOf(r.short_id as SlotId)).filter((v) => v >= 0));
        const firstFree = SLOT_IDS.findIndex((_, idx) => !occupied.has(idx));
        this.db
          .prepare(
            `INSERT INTO chat_meta(chat_id, next_slot) VALUES (?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET next_slot = excluded.next_slot`
          )
          .run(chatId, firstFree >= 0 ? firstFree : 0);
      }

      const activeRows = this.db
        .prepare("SELECT channel, session_id FROM active_sessions WHERE chat_id = ?")
        .all(chatId) as Array<{ channel: string; session_id: string }>;

      for (const row of activeRows) {
        const activeExists = this.db
          .prepare("SELECT 1 as ok FROM sessions WHERE id = ?")
          .get(row.session_id) as { ok: number } | undefined;
        if (!activeExists) {
          this.db
            .prepare("DELETE FROM active_sessions WHERE chat_id = ? AND channel = ?")
            .run(chatId, row.channel);
        }
      }

      const shared = this.db
        .prepare("SELECT session_id FROM active_sessions WHERE chat_id = ? AND channel = ?")
        .get(chatId, DEFAULT_ACTIVE_CHANNEL) as { session_id: string } | undefined;
      const sharedExists = shared
        ? (this.db.prepare("SELECT 1 as ok FROM sessions WHERE id = ?").get(shared.session_id) as { ok: number } | undefined)
        : undefined;

      if (!shared || !sharedExists) {
        const latest = this.db
          .prepare("SELECT id FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1")
          .get(chatId) as { id: string } | undefined;
        if (latest) {
          this.upsertActiveSession(chatId, DEFAULT_ACTIVE_CHANNEL, latest.id);
        }
      }
    }
  }

}



