import dotenv from "dotenv";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../core/config/env";
import { SessionStore, Session } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { applyPlanModePrompt } from "../../core/codex/promptMode";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronStore } from "../../core/cron/store";
import { buildOneShotCron } from "../../core/cron/oneshot";
import { parseArgs } from "../../core/commands/args";
import { DEFAULT_LOCAL_CHAT_ID, LOG_COMMAND, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";
import { CommandResult, sessionSummary } from "../../shared/types";
import { ChatJobStore, ChatJobRecord } from "../../core/chat/jobStore";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");
const store = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const cronStore = new CronStore(config.dbFile);
const chatJobStore = new ChatJobStore(config.dbFile);
const sessionLocks = new Set<string>();

let codexCommandResolved = "";

const WEB_PORT = Number(process.env.JCLAW_WEB_PORT ?? "3100");
const WEB_HOST = process.env.JCLAW_WEB_HOST ?? "127.0.0.1";

type ChatAttachment = {
  fileName?: string;
  mimeType?: string;
  contentBase64?: string;
};

type ChatRequest = {
  chatId?: string;
  slot?: string;
  message?: string;
  attachment?: ChatAttachment;
};

type AuthRequest = {
  idToken?: string;
  password?: string;
};

type WebAuthSession = {
  token: string;
  email: string;
  method: "google" | "dev";
  expiresAt: number;
};

const WEB_CHAT_ID = process.env.WEB_CHAT_ID?.trim() || defaultChatId();
const WEB_AUTH_COOKIE = "jclaw_web_auth";
const WEB_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const WEB_DEV_PASSWORD = process.env.WEB_DEV_PASSWORD ?? "3437";
const WEB_DEV_MAX_FAILED_ATTEMPTS = 3;
const WEB_GOOGLE_CLIENT_ID = (process.env.WEB_GOOGLE_CLIENT_ID ?? "").trim();
const WEB_AUTH_COOKIE_SAMESITE = (process.env.WEB_AUTH_COOKIE_SAMESITE ?? "Lax").trim();
const WEB_AUTH_COOKIE_SECURE = (process.env.WEB_AUTH_COOKIE_SECURE ?? (process.env.NODE_ENV === "production" ? "true" : "false")).trim().toLowerCase() === "true";
const WEB_ALLOWED_ORIGINS = new Set(
  (process.env.WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const WEB_UPLOAD_DIR = path.join(dataDir, "web_uploads");
const WEB_UPLOAD_MAX_FILES = Math.max(1, Number(process.env.WEB_UPLOAD_MAX_FILES ?? "50") || 50);
const WEB_UPLOAD_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.WEB_UPLOAD_MAX_BYTES ?? String(15 * 1024 * 1024)) || 15 * 1024 * 1024);

const WEB_ALLOWED_EMAILS = new Set(
  (process.env.WEB_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
);
const webAuthSessions = new Map<string, WebAuthSession>();
const chatJobSubscribers = new Map<string, Set<ServerResponse>>();
const CHAT_JOB_MAX = Math.max(200, Number(process.env.WEB_CHAT_JOB_MAX ?? "2000") || 2000);
const CHAT_JOB_WORKERS = Math.max(1, Number(process.env.WEB_CHAT_JOB_WORKERS ?? "1") || 1);
const CHAT_SSE_HEARTBEAT_MS = Math.max(10000, Number(process.env.WEB_CHAT_SSE_HEARTBEAT_MS ?? "15000") || 15000);
let activeJobWorkers = 0;
let devPasswordFailedAttempts = 0;
let devPasswordLocked = false;

function pruneExpiredWebAuthSessions(): void {
  const now = Date.now();
  for (const [token, session] of webAuthSessions.entries()) {
    if (session.expiresAt <= now) {
      webAuthSessions.delete(token);
    }
  }
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const raw = req.headers.cookie ?? "";
  const out = new Map<string, string>();

  for (const pair of raw.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = decodeURIComponent(trimmed.slice(0, idx).trim());
    const value = decodeURIComponent(trimmed.slice(idx + 1).trim());
    out.set(key, value);
  }

  return out;
}

function setAuthCookie(res: ServerResponse, token: string): void {
  const sameSite = WEB_AUTH_COOKIE_SAMESITE;
  const isSecure = WEB_AUTH_COOKIE_SECURE;
  const maxAgeSeconds = Math.floor(WEB_SESSION_TTL_MS / 1000);
  const parts = [
    `${WEB_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res: ServerResponse): void {
  const sameSite = WEB_AUTH_COOKIE_SAMESITE;
  const isSecure = WEB_AUTH_COOKIE_SECURE;
  const parts = [
    `${WEB_AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0"
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getAuthSession(req: IncomingMessage): WebAuthSession | null {
  pruneExpiredWebAuthSessions();
  const token = parseCookies(req).get(WEB_AUTH_COOKIE);
  if (!token) {
    return null;
  }
  const session = webAuthSessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    webAuthSessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): WebAuthSession | null {
  const session = getAuthSession(req);
  if (!session) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  return session;
}

function createAuthSession(email: string, method: "google" | "dev"): WebAuthSession {
  const token = randomBytes(24).toString("hex");
  const session: WebAuthSession = {
    token,
    email,
    method,
    expiresAt: Date.now() + WEB_SESSION_TTL_MS
  };
  webAuthSessions.set(token, session);
  return session;
}

function isAllowedEmail(email: string): boolean {
  if (WEB_ALLOWED_EMAILS.size === 0) {
    return true;
  }
  return WEB_ALLOWED_EMAILS.has(email.toLowerCase());
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) {
    return false;
  }
  if (WEB_ALLOWED_ORIGINS.size === 0) {
    return false;
  }

  try {
    const normalized = new URL(origin).origin;
    return WEB_ALLOWED_ORIGINS.has(normalized);
  } catch {
    return false;
  }
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) {
    return true;
  }

  if (!isAllowedOrigin(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  return true;
}

async function verifyGoogleIdToken(idToken: string): Promise<string | null> {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("id_token", idToken);

  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string;
  };

  const email = (data.email ?? "").trim().toLowerCase();
  const verified = String(data.email_verified ?? "false").toLowerCase() === "true";
  if (!email || !verified) {
    return null;
  }
  if (WEB_GOOGLE_CLIENT_ID && data.aud !== WEB_GOOGLE_CLIENT_ID) {
    return null;
  }
  if (!isAllowedEmail(email)) {
    return null;
  }

  return email;
}


function pruneChatJobs(): void {
  chatJobStore.prune(CHAT_JOB_MAX);
}

function subscribeChatJob(jobId: string, res: ServerResponse): void {
  const set = chatJobSubscribers.get(jobId) ?? new Set<ServerResponse>();
  set.add(res);
  chatJobSubscribers.set(jobId, set);

  res.on("close", () => {
    const current = chatJobSubscribers.get(jobId);
    if (!current) {
      return;
    }
    current.delete(res);
    if (current.size === 0) {
      chatJobSubscribers.delete(jobId);
    }
  });
}

function emitSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function notifyChatJob(job: ChatJobRecord): void {
  const subs = chatJobSubscribers.get(job.id);
  if (!subs || subs.size === 0) {
    return;
  }

  const base = {
    id: job.id,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.result?.sessionName ?? job.sessionId,
    updatedAt: job.updatedAt
  };

  if (job.status === "completed" && job.result) {
    for (const res of subs) {
      emitSse(res, "done", {
        ...base,
        done: true,
        success: true,
        result: job.result
      });
      res.end();
    }
    chatJobSubscribers.delete(job.id);
    return;
  }

  if (job.status === "failed") {
    for (const res of subs) {
      emitSse(res, "done", {
        ...base,
        done: true,
        success: false,
        error: job.error ?? "job failed"
      });
      res.end();
    }
    chatJobSubscribers.delete(job.id);
    return;
  }

  for (const res of subs) {
    emitSse(res, "update", {
      ...base,
      done: false
    });
  }
}

function scheduleChatWorkers(): void {
  while (activeJobWorkers < CHAT_JOB_WORKERS) {
    const job = chatJobStore.claimNextPending();
    if (!job) {
      return;
    }
    activeJobWorkers += 1;
    notifyChatJob(job);

    void (async () => {
      try {
        const session = store.getSession(job.sessionId);
        if (!session) {
          const failed = chatJobStore.markFailed(job.id, `Session not found: ${job.sessionId}`);
          if (failed) {
            notifyChatJob(failed);
            pruneChatJobs();
          }
          return;
        }

        const result = await runPrompt(job.chatId, session, job.prompt);
        const completed = chatJobStore.markCompleted(job.id, result);
        if (completed) {
          notifyChatJob(completed);
          pruneChatJobs();
        }
      } catch (err) {
        const failed = chatJobStore.markFailed(job.id, String(err));
        if (failed) {
          notifyChatJob(failed);
          pruneChatJobs();
        }
      } finally {
        activeJobWorkers -= 1;
        scheduleChatWorkers();
      }
    })();
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeCommand(line: string): string {
  if (line.startsWith(":")) {
    return `/${line.slice(1)}`;
  }
  return line;
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "text/plain") return ".txt";
  return "";
}

async function pruneWebUploads(maxFiles: number): Promise<void> {
  await mkdir(WEB_UPLOAD_DIR, { recursive: true });
  const entries = await readdir(WEB_UPLOAD_DIR, { withFileTypes: true });
  const files: Array<{ fullPath: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.resolve(WEB_UPLOAD_DIR, entry.name);
    const info = await stat(fullPath);
    files.push({ fullPath, mtimeMs: info.mtimeMs });
  }

  if (files.length < maxFiles) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removeCount = files.length - maxFiles + 1;
  for (let i = 0; i < removeCount; i += 1) {
    await unlink(files[i].fullPath).catch(() => {
      // ignore stale file errors
    });
  }
}

async function saveWebAttachment(attachment: ChatAttachment): Promise<string> {
  const contentBase64 = (attachment.contentBase64 ?? "").trim();
  if (!contentBase64) {
    throw new Error("attachment.contentBase64 is required");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length) {
    throw new Error("attachment is empty");
  }
  if (bytes.length > WEB_UPLOAD_MAX_BYTES) {
    throw new Error(`attachment too large (max ${WEB_UPLOAD_MAX_BYTES} bytes)`);
  }

  const mimeType = (attachment.mimeType ?? "").trim().toLowerCase();
  const extFromName = path.extname(attachment.fileName ?? "");
  const ext = sanitizeFilenamePart((extFromName || extensionFromMimeType(mimeType) || ".bin").toLowerCase()) || ".bin";

  await pruneWebUploads(WEB_UPLOAD_MAX_FILES);

  const fileName = `web_${Date.now()}_${Math.floor(Math.random() * 100000)}${ext}`;
  const localPath = path.resolve(WEB_UPLOAD_DIR, fileName);
  await writeFile(localPath, bytes);
  return localPath;
}

function formatResult(output: string, error: string | null, maxChars: number): string {
  const merged = [output.trim(), error ? `ERR:\n${error}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!merged) {
    return "(no output)";
  }

  if (merged.length <= maxChars) {
    return merged;
  }

  return `${merged.slice(0, maxChars)}\n\n[truncated ${merged.length - maxChars} chars]`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function defaultChatId(): string {
  return Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
}

function ensureAllowed(chatId: string): boolean {
  return config.allowedChatIds.size === 0 || config.allowedChatIds.has(chatId);
}

function buildReplyWithHeaders(
  session: Session,
  interactionId: number | null,
  result: { exitCode: number | null; durationMs: number },
  body: string
): string {
  if (!interactionLogger.isEnabled()) {
    return body;
  }

  const lines: string[] = [];
  if (interactionId !== null) {
    lines.push(`Req#: ${interactionId}`);
  }
  lines.push(sessionSummary(session));
  if ((result.exitCode ?? 0) !== 0) {
    lines.push(`Exit: ${result.exitCode ?? "null"}`);
  }
  if (result.durationMs > 20000) {
    lines.push(`Time: ${result.durationMs}ms`);
  }
  return `${lines.join("\n")}\n\n${body}`;
}

function getState(chatId: string): { session: Session; logEnabled: boolean } {
  const session = store.getOrCreateSessionByChat(chatId, "web");
  return { session, logEnabled: interactionLogger.isEnabled() };
}

async function handleCronCommand(chatId: string, cmdLine: string, session: Session): Promise<CommandResult> {
  await cronStore.reload();

  const rest = cmdLine.replace(/^\/cron\s*/, "").trim();
  if (!rest || rest === "help") {
    return {
      reply: [
        "Usage:",
        "/cron list",
        '/cron add --session A --cron "*/5 * * * *" --prompt "status report" [--tz Asia/Seoul]',
        '/cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "one shot"',
        "/cron remove <job_id>",
        "/cron enable <job_id>",
        "/cron disable <job_id>"
      ].join("\n"),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const parsed = parseArgs(rest);
  const sub = parsed.positional[0]?.toLowerCase();

  if (sub === "list") {
    const jobs = cronStore.list().filter((j) => j.chatId === chatId);
    return {
      reply: jobs.length
        ? jobs
            .map(
              (j) =>
                `${j.id} | ${j.enabled ? "on" : "off"}${j.runOnce ? " | once" : ""} | session=${j.sessionTarget} | cron=${j.cron}` +
                `${j.timezone ? ` tz=${j.timezone}` : ""} | next=${j.nextRunAt} | last=${j.lastRunAt ?? "-"} | status=${j.lastStatus ?? "-"}`
            )
            .join("\n")
        : TEXT.noCronJobs,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }


  if (sub === "once") {
    const sessionTarget = parsed.flags.session;
    const at = parsed.flags.at;
    const prompt = parsed.flags.prompt;

    if (!sessionTarget || !at || !prompt) {
      return {
        reply: 'Missing --session, --at or --prompt. Example: /cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "status report"',
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    store.ensureSessionForTarget(chatId, sessionTarget);

    const oneShot = buildOneShotCron(at);
    const job = await cronStore.create({
      chatId,
      sessionTarget,
      cron: oneShot.cron,
      prompt,
      timezone: null,
      runOnce: true
    });

    return {
      reply: `Created one-shot ${job.id}
runAt=${oneShot.runAt.toISOString()}
next=${job.nextRunAt}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (sub === "add") {
    const sessionTarget = parsed.flags.session;
    const cron = parsed.flags.cron;
    const prompt = parsed.flags.prompt;
    const timezone = parsed.flags.tz ?? null;

    if (!sessionTarget || !cron || !prompt) {
      return {
        reply: 'Missing --session, --cron or --prompt. Example: /cron add --session A --cron "*/5 * * * *" --prompt "status report"',
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    store.ensureSessionForTarget(chatId, sessionTarget);

    const job = await cronStore.create({ chatId, sessionTarget, cron, prompt, timezone });
    return {
      reply: `Created ${job.id}\nnext=${job.nextRunAt}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const id = parsed.positional[1];
  if (!id) {
    return {
      reply: "Missing job id.",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const existing = cronStore.get(id);
  if (!existing) {
    return {
      reply: `Not found: ${id}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }
  if (existing.chatId !== chatId) {
    return {
      reply: "Access denied for this job.",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (sub === "remove") {
    await cronStore.remove(id);
    return { reply: `Removed ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }
  if (sub === "enable") {
    await cronStore.setEnabled(id, true);
    return { reply: `Enabled ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }
  if (sub === "disable") {
    await cronStore.setEnabled(id, false);
    return { reply: `Disabled ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }

  return {
    reply: TEXT.unknownCron,
    sessionSlot: session.shortId,
    sessionName: session.id,
    logEnabled: interactionLogger.isEnabled()
  };
}

async function runPrompt(chatId: string, session: Session, prompt: string): Promise<CommandResult> {
  if (sessionLocks.has(session.id)) {
    return {
      reply: `Session ${session.shortId} is busy. Try again after current run.`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  sessionLocks.add(session.id);
  try {
    const planMode = store.getPlanMode(session.id);
    const effectivePrompt = applyPlanModePrompt(prompt, planMode);

    const result = await runCodex({
      codexCommand: codexCommandResolved,
      codexArgsTemplate: config.codexArgsTemplate,
      prompt: effectivePrompt,
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      timeoutMs: config.codexTimeoutMs,
      workdir: config.codexWorkdir,
      codexNodeOptions: config.codexNodeOptions,
      reasoningEffort: store.getReasoningEffort(session.id)
    });

    if (result.codexSessionId && result.codexSessionId !== session.codexSessionId) {
      store.setCodexSessionId(session.id, result.codexSessionId);
    }

    store.appendRun(session.id, {
      id: `r_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      input: prompt,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    const interactionId = await interactionLogger.append({
      channel: "web",
      sessionId: session.id,
      chatId,
      input: prompt,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    const body = formatResult(result.output, result.error, config.maxOutputChars);
    return {
      reply: buildReplyWithHeaders(session, interactionId, { exitCode: result.exitCode, durationMs: result.durationMs }, body),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  } finally {
    sessionLocks.delete(session.id);
  }
}

async function handleCommand(chatId: string, session: Session, cmdLine: string): Promise<CommandResult | null> {
  const parts = cmdLine.split(" ").filter(Boolean);
  const cmd = parts[0]?.toLowerCase();

  if (!cmd || cmd === "/help") {
    return {
      reply: [
        "Commands:",
        "/help",
        "/new",
        `/session <${SLOT_TARGET_HINT}>`,
        "/history [n]",
        "/where",
        "/whoami",
        LOG_COMMAND,
        "/plan <on|off|status>",
        "/reason <none|low|medium|high|status>",
        "/cron ...",
        "/slot <list|show|bind>"
      ].join("\n"),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/new") {
    const next = store.createAndActivateSession(chatId, "web");
    return {
      reply: `Switched to session slot ${next.shortId}`,
      sessionSlot: next.shortId,
      sessionName: next.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/session") {
    const target = parts[1];
    if (!target) {
      return {
        reply: `Usage: /session <${SLOT_TARGET_HINT}>`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    const next = store.setActiveSession(chatId, target, "web");
    return {
      reply: `Switched to session slot ${next.shortId}`,
      sessionSlot: next.shortId,
      sessionName: next.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/where") {
    return {
      reply: sessionSummary(session),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/whoami") {
    return {
      reply: `chat_id: ${chatId}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/history") {
    const limit = Number(parts[1] ?? "5");
    const rows = store.listHistory(session.id, Number.isNaN(limit) ? 5 : limit);
    return {
      reply: rows.length
        ? rows
            .map((r) => `${r.id} | ${r.timestamp} | exit=${r.exitCode ?? "null"} | ${r.durationMs}ms | ${r.input.slice(0, 60)}`)
            .join("\n")
        : TEXT.noHistory,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/log") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Interaction log: ${interactionLogger.isEnabled() ? "ON" : "OFF"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "on") {
      await interactionLogger.setEnabled(true);
      return {
        reply: TEXT.logOn,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "off") {
      await interactionLogger.setEnabled(false);
      return {
        reply: TEXT.logOff,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    return {
      reply: TEXT.logUsage,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/plan") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Plan mode: ${store.getPlanMode(session.id) ? "ON" : "OFF"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "on") {
      store.setPlanMode(session.id, true);
      return {
        reply: "Plan mode: ON",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "off") {
      store.setPlanMode(session.id, false);
      return {
        reply: "Plan mode: OFF",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    return {
      reply: "Usage: /plan <on|off|status>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }


  if (cmd === "/reason") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Reasoning effort: ${store.getReasoningEffort(session.id).toUpperCase()}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (mode === "none" || mode === "low" || mode === "medium" || mode === "high") {
      const next = store.setReasoningEffort(session.id, mode);
      return {
        reply: `Reasoning effort: ${next.toUpperCase()}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    return {
      reply: "Usage: /reason <none|low|medium|high|status>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/slot") {
    const sub = (parts[1] ?? "list").toLowerCase();
    if (sub === "list") {
      const rows = store.listSlotBindings(chatId);
      return {
        reply: rows.length
          ? rows.map((r) => `${r.slotId} | session=${r.sessionId} | codex=${r.codexSessionId ?? "-"}`).join("\n")
          : "No slots found.",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (sub === "show") {
      const slot = (parts[2] ?? "").toUpperCase();
      if (!slot) {
        return {
          reply: "Usage: /slot show <A-Z>",
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      const id = store.resolveSessionId(slot, chatId);
      if (!id) {
        return {
          reply: `No session in slot ${slot}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      const target = store.getSession(id);
      if (!target) {
        return {
          reply: `No session in slot ${slot}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      return {
        reply: `${sessionSummary(target)}\nCodex Session: ${target.codexSessionId ?? "-"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (sub === "bind") {
      const slot = (parts[2] ?? "").toUpperCase();
      const codexSessionId = parts[3] ?? "";
      if (!slot || !codexSessionId) {
        return {
          reply: "Usage: /slot bind <A-Z> <codex_session_id>",
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      try {
        const bound = store.bindCodexSession(chatId, slot, codexSessionId);
        return {
          reply: `Bound ${bound.shortId} -> ${bound.codexSessionId}\nSession Name: ${bound.id}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      } catch (err) {
        return {
          reply: String(err),
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }
    }

    return {
      reply: "Usage: /slot <list|show|bind>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/cron") {
    return handleCronCommand(chatId, cmdLine, session);
  }

  return null;
}

async function handleApiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  let payload: ChatRequest;
  try {
    payload = JSON.parse(await readBody(req)) as ChatRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const message = (payload.message ?? "").trim();
  const hasAttachment = Boolean(payload.attachment?.contentBase64);

  if (!message && !hasAttachment) {
    json(res, 400, { error: "message or attachment is required" });
    return;
  }

  const chatId = WEB_CHAT_ID;

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const requestedSlot = (payload.slot ?? "").trim().toUpperCase();
    const session = requestedSlot
      ? store.ensureSessionForTarget(chatId, requestedSlot)
      : getState(chatId).session;

    let effectivePrompt = message;
    if (hasAttachment) {
      const localPath = await saveWebAttachment(payload.attachment ?? {});
      effectivePrompt = [
        "User uploaded a file from web chat.",
        `Local file path: ${localPath}`,
        "Open and analyze the file directly.",
        message ? `User request: ${message}` : "If no explicit request, summarize the file contents."
      ].join("\n");
    }

    const normalized = normalizeCommand(effectivePrompt);

    if (!hasAttachment && normalized.startsWith("/")) {
      const cmdResult = await handleCommand(chatId, session, normalized);
      if (cmdResult) {
        json(res, 200, cmdResult);
        return;
      }
      json(res, 400, { error: "Unknown command" });
      return;
    }

    const job = chatJobStore.createPending({
      chatId,
      sessionId: session.id,
      sessionSlot: session.shortId,
      prompt: normalized
    });
    pruneChatJobs();
    json(res, 202, {
      queued: true,
      jobId: job.id,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    });
    scheduleChatWorkers();
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiChatJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const jobId = (url.searchParams.get("id") ?? "").trim();
  if (!jobId) {
    json(res, 400, { error: "id is required" });
    return;
  }

  const job = chatJobStore.get(jobId);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  if (job.chatId !== WEB_CHAT_ID) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  if (job.status === "completed" && job.result) {
    json(res, 200, {
      done: true,
      success: true,
      result: job.result
    });
    return;
  }

  if (job.status === "failed") {
    json(res, 200, {
      done: true,
      success: false,
      error: job.error ?? "job failed"
    });
    return;
  }

  json(res, 200, {
    done: false,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.sessionId
  });
}

async function handleApiChatJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const slot = (url.searchParams.get("slot") ?? "").trim().toUpperCase();
  const chatId = WEB_CHAT_ID;

  if (!slot) {
    json(res, 400, { error: "slot is required" });
    return;
  }

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  const items = chatJobStore.listRecentBySlot(chatId, slot, 30);
  json(res, 200, { items });
}

async function handleApiChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const jobId = (url.searchParams.get("jobId") ?? "").trim();
  if (!jobId) {
    json(res, 400, { error: "jobId is required" });
    return;
  }

  const job = chatJobStore.get(jobId);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  if (job.chatId !== WEB_CHAT_ID) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  subscribeChatJob(jobId, res);

  emitSse(res, "connected", {
    id: job.id,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.result?.sessionName ?? job.sessionId,
    updatedAt: job.updatedAt
  });

  notifyChatJob(job);

  if (job.status === "completed" || job.status === "failed") {
    return;
  }

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, CHAT_SSE_HEARTBEAT_MS);

  res.on("close", () => {
    clearInterval(heartbeat);
  });
}

async function handleApiState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const { session, logEnabled } = getState(chatId);
    json(res, 200, {
      chatId,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled,
      auth: {
        email: auth.email,
        method: auth.method
      }
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = getAuthSession(req);
  json(res, 200, {
    authenticated: Boolean(session),
    email: session?.email ?? null,
    method: session?.method ?? null,
    googleClientId: WEB_GOOGLE_CLIENT_ID || null,
    googleEnabled: Boolean(WEB_GOOGLE_CLIENT_ID),
    devPasswordEnabled: true,
    devPasswordLocked,
    devPasswordFailedAttempts,
    devPasswordRemainingAttempts: Math.max(0, WEB_DEV_MAX_FAILED_ATTEMPTS - devPasswordFailedAttempts),
    allowedEmailsConfigured: WEB_ALLOWED_EMAILS.size > 0
  });
}

async function handleApiAuthGoogle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: AuthRequest;
  try {
    payload = JSON.parse(await readBody(req)) as AuthRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const idToken = (payload.idToken ?? "").trim();
  if (!idToken) {
    json(res, 400, { error: "idToken is required" });
    return;
  }

  try {
    const email = await verifyGoogleIdToken(idToken);
    if (!email) {
      json(res, 401, { error: "Google authentication failed" });
      return;
    }

    const session = createAuthSession(email, "google");
    setAuthCookie(res, session.token);
    json(res, 200, { ok: true, email: session.email, method: session.method });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiAuthDev(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (devPasswordLocked) {
    json(res, 423, { error: "Developer login is locked. Restart server to unlock." });
    return;
  }

  let payload: AuthRequest;
  try {
    payload = JSON.parse(await readBody(req)) as AuthRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const password = payload.password ?? "";
  if (!password) {
    json(res, 400, { error: "password is required" });
    return;
  }

  if (password !== WEB_DEV_PASSWORD) {
    devPasswordFailedAttempts += 1;
    if (devPasswordFailedAttempts >= WEB_DEV_MAX_FAILED_ATTEMPTS) {
      devPasswordLocked = true;
      console.warn("[jclaw-web] developer login locked after too many failed attempts; restart server to unlock.");
      json(res, 423, { error: "Developer login locked after 3 failed attempts. Restart server to unlock." });
      return;
    }

    json(res, 401, {
      error: "Invalid development password",
      remainingAttempts: WEB_DEV_MAX_FAILED_ATTEMPTS - devPasswordFailedAttempts
    });
    return;
  }

  devPasswordFailedAttempts = 0;
  const session = createAuthSession("dev-login@local", "dev");
  setAuthCookie(res, session.token);
  json(res, 200, { ok: true, email: session.email, method: session.method });
}

async function handleApiAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = parseCookies(req).get(WEB_AUTH_COOKIE);
  if (token) {
    webAuthSessions.delete(token);
  }
  clearAuthCookie(res);
  json(res, 200, { ok: true });
}

async function handleApiSessionHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const slot = (url.searchParams.get("slot") ?? "").trim().toUpperCase();
  const limitRaw = Number(url.searchParams.get("limit") ?? "60");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(300, Math.floor(limitRaw))) : 60;

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    let session: Session | null = null;
    if (slot) {
      const resolved = store.resolveSessionId(slot, chatId);
      session = resolved ? store.getSession(resolved) : null;
    } else {
      session = getState(chatId).session;
    }

    if (!session) {
      json(res, 200, { slot, sessionName: null, items: [] });
      return;
    }

    const rows = store.listHistory(session.id, limit);
    json(res, 200, {
      slot: session.shortId,
      sessionName: session.id,
      items: rows
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  const webRoot = path.resolve(process.cwd(), "web");
  const candidate = pathname === "/" ? "index.html" : `.${pathname}`;
  const filePath = path.resolve(webRoot, candidate);

  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export async function startWebServer(): Promise<void> {
  await store.init();
  await interactionLogger.init();
  await cronStore.init();
  await chatJobStore.init();

  const resolved = await resolveCodexCommand(config.codexCommand);
  codexCommandResolved = resolved.command;

  scheduleChatWorkers();

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      json(res, 400, { error: "Bad request" });
      return;
    }

    const corsAllowed = applyCors(req, res);
    if (!corsAllowed) {
      json(res, 403, { error: "Origin not allowed" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (req.method === "GET" && pathname === "/api/auth/status") {
      await handleApiAuthStatus(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/google") {
      await handleApiAuthGoogle(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/dev") {
      await handleApiAuthDev(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      await handleApiAuthLogout(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      await handleApiState(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/session-history") {
      await handleApiSessionHistory(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      await handleApiChat(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat-job") {
      await handleApiChatJob(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat/jobs") {
      await handleApiChatJobs(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat/stream") {
      await handleApiChatStream(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    console.log(`[jclaw-web] running at http://${WEB_HOST}:${WEB_PORT}`);
  });
}

if (require.main === module) {
  void startWebServer();
}
