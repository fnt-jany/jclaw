import dotenv from "dotenv";
import path from "node:path";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { applyPlanModePrompt } from "../../core/codex/promptMode";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronStore } from "../../core/cron/store";
import { buildOneShotCron } from "../../core/cron/oneshot";
import { parseArgs } from "../../core/commands/args";
import { LOG_COMMAND, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";
import { sessionSummary } from "../../shared/types";
import { BUILD_TIME_ISO } from "../../generated/buildInfo";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");

const store = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const cronStore = new CronStore(config.dbFile);
const sessionLocks = new Set<string>();
let startupNotificationSent = false;
const telegramUploadDir = path.join(dataDir, "telegram_uploads");
const TELEGRAM_UPLOAD_MAX_FILES = Math.max(1, Number(process.env.TELEGRAM_UPLOAD_MAX_FILES ?? "200") || 200);

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/heic") return ".heic";
  if (normalized === "image/heif") return ".heif";
  return "";
}

async function pruneTelegramUploads(maxFiles: number): Promise<void> {
  await mkdir(telegramUploadDir, { recursive: true });
  const entries = await readdir(telegramUploadDir, { withFileTypes: true });
  const files: Array<{ fullPath: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = path.resolve(telegramUploadDir, entry.name);
    const info = await stat(fullPath);
    files.push({ fullPath, mtimeMs: info.mtimeMs });
  }

  if (files.length < maxFiles) {
    return;
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removeCount = files.length - maxFiles + 1;
  for (let i = 0; i < removeCount; i += 1) {
    await unlink(files[i].fullPath).catch(() => {
      // ignore stale/delete race
    });
  }
}

async function downloadTelegramFile(fileId: string, suggestedExt: string): Promise<string> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const infoRes = await fetch(url);
  if (!infoRes.ok) {
    throw new Error(`Failed to query Telegram file info (${infoRes.status})`);
  }

  const info = (await infoRes.json()) as { ok?: boolean; result?: { file_path?: string } };
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) {
    throw new Error("Telegram file path is missing");
  }

  const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`Failed to download Telegram file (${fileRes.status})`);
  }

  const bytes = Buffer.from(await fileRes.arrayBuffer());
  const extFromPath = path.extname(filePath);
  const ext = sanitizeFilenamePart((extFromPath || suggestedExt || "").toLowerCase()) || ".bin";
  const name = `tg_${Date.now()}_${Math.floor(Math.random() * 100000)}${ext}`;

  await pruneTelegramUploads(TELEGRAM_UPLOAD_MAX_FILES);
  const localPath = path.resolve(telegramUploadDir, name);
  await writeFile(localPath, bytes);
  return localPath;
}

function isAllowed(chatId: string): boolean {
  return config.allowedChatIds.size === 0 || config.allowedChatIds.has(chatId);
}

function isAdmin(chatId: string): boolean {
  if (config.adminChatIds.size === 0) {
    return isAllowed(chatId);
  }
  return config.adminChatIds.has(chatId);
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

function chatIdOf(ctx: Context): string | null {
  return ctx.chat?.id?.toString() ?? null;
}

function formatKst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

async function notifyBotStarted(bot: Telegraf): Promise<void> {
  if (startupNotificationSent) {
    return;
  }

  const targets = config.allowedChatIds.size > 0
    ? Array.from(config.allowedChatIds)
    : [];

  if (!targets.length) {
    console.log("[jclaw] startup notify skipped: ALLOWED_CHAT_IDS is empty");
    return;
  }

  const startedAt = new Date().toISOString();
  const message = [
    "[jclaw] Telegram bot started",
    `build (KST): ${formatKst(BUILD_TIME_ISO)}`,
    `started (KST): ${formatKst(startedAt)}`
  ].join("\n");

  console.log(`[jclaw] startup notify targets: ${targets.join(",")}`);

  for (const chatId of targets) {
    try {
      const sent = await bot.telegram.sendMessage(chatId, message);
      console.log(`[jclaw] startup notification sent to ${chatId} (message_id=${sent.message_id})`);
    } catch (err) {
      console.error(`[jclaw] failed to send startup notification to ${chatId}:`, err);
    }
  }

  startupNotificationSent = true;
}

async function handleCronCommand(chatId: string, text: string): Promise<string> {
  await cronStore.reload();

  const rest = text.replace(/^\/cron\s*/, "").trim();
  if (!rest || rest === "help") {
    return [
      "Usage:",
      "/cron list",
      '/cron add --session A --cron "*/5 * * * *" --prompt "status report" [--tz Asia/Seoul]',
      '/cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "one shot"',
      "/cron remove <job_id>",
      "/cron enable <job_id>",
      "/cron disable <job_id>"
    ].join("\n");
  }

  const parsed = parseArgs(rest);
  const sub = parsed.positional[0]?.toLowerCase();

  if (sub === "list") {
    const jobs = cronStore.list().filter((j) => j.chatId === chatId);
    if (!jobs.length) {
      return TEXT.noCronJobs;
    }

    return jobs
      .map(
        (j) =>
          `${j.id} | ${j.enabled ? "on" : "off"}${j.runOnce ? " | once" : ""} | session=${j.sessionTarget} | cron=${j.cron}` +
          `${j.timezone ? ` tz=${j.timezone}` : ""} | next=${j.nextRunAt} | last=${j.lastRunAt ?? "-"} | status=${j.lastStatus ?? "-"}`
      )
      .join("\n");
  }


  if (sub === "once") {
    const sessionTarget = parsed.flags.session;
    const at = parsed.flags.at;
    const prompt = parsed.flags.prompt;

    if (!sessionTarget || !at || !prompt) {
      return 'Missing --session, --at or --prompt. Example: /cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "status report"';
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

    return `Created one-shot ${job.id}
runAt=${oneShot.runAt.toISOString()}
next=${job.nextRunAt}`;
  }

  if (sub === "add") {
    const sessionTarget = parsed.flags.session;
    const cron = parsed.flags.cron;
    const prompt = parsed.flags.prompt;
    const timezone = parsed.flags.tz ?? null;

    if (!sessionTarget || !cron || !prompt) {
      return 'Missing --session, --cron or --prompt. Example: /cron add --session A --cron "*/5 * * * *" --prompt "status report"';
    }

    store.ensureSessionForTarget(chatId, sessionTarget);

    const job = await cronStore.create({
      chatId,
      sessionTarget,
      cron,
      prompt,
      timezone
    });

    return `Created ${job.id}\nnext=${job.nextRunAt}`;
  }

  const id = parsed.positional[1];
  if (!id) {
    return "Missing job id.";
  }

  const existing = cronStore.get(id);
  if (!existing) {
    return `Not found: ${id}`;
  }
  if (existing.chatId !== chatId) {
    return "Access denied for this job.";
  }

  if (sub === "remove") {
    await cronStore.remove(id);
    return `Removed ${id}`;
  }
  if (sub === "enable") {
    await cronStore.setEnabled(id, true);
    return `Enabled ${id}`;
  }
  if (sub === "disable") {
    await cronStore.setEnabled(id, false);
    return `Disabled ${id}`;
  }

  return TEXT.unknownCron;
}

function attachHandlers(bot: Telegraf, resolvedCodexCommand: string): void {
  async function executePrompt(ctx: Context, prompt: string): Promise<void> {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    if (sessionLocks.has(session.id)) {
      await ctx.reply(`Session ${session.shortId} is busy. Try again after current run.`);
      return;
    }

    sessionLocks.add(session.id);
    try {
      await ctx.reply(`Running in session ${session.shortId}...`);
    } catch {
      sessionLocks.delete(session.id);
      return;
    }

    void (async () => {
      const TYPING_MIN_INTERVAL_MS = 4000;
      let lastTypingAt = 0;
      let typingInFlight = false;

      const maybeSendTyping = (): void => {
        const now = Date.now();
        if (typingInFlight || now - lastTypingAt < TYPING_MIN_INTERVAL_MS) {
          return;
        }

        typingInFlight = true;
        lastTypingAt = now;
        void bot.telegram
          .sendChatAction(chatId, "typing")
          .catch(() => {
            // ignore transient typing send errors
          })
          .finally(() => {
            typingInFlight = false;
          });
      };

      const onChunk = (): void => {
        maybeSendTyping();
      };

      try {
        const planMode = store.getPlanMode(session.id);
        const effectivePrompt = applyPlanModePrompt(prompt, planMode);
        maybeSendTyping();

        const result = await runCodex({
          codexCommand: resolvedCodexCommand,
          codexArgsTemplate: config.codexArgsTemplate,
          prompt: effectivePrompt,
          sessionId: session.id,
          codexSessionId: session.codexSessionId,
          timeoutMs: config.codexTimeoutMs,
          workdir: config.codexWorkdir,
          codexNodeOptions: config.codexNodeOptions,
          onStdoutChunk: onChunk,
          onStderrChunk: onChunk
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
          channel: "telegram",
          sessionId: session.id,
          chatId,
          input: prompt,
          output: result.output,
          error: result.error,
          exitCode: result.exitCode,
          durationMs: result.durationMs
        });

        const completionMessage = formatResult(result.output, result.error, config.maxOutputChars);

        if (!interactionLogger.isEnabled()) {
          await bot.telegram.sendMessage(chatId, completionMessage);
        } else {
          const headerLines: string[] = [];
          if (interactionId !== null) {
            headerLines.push(`Req#: ${interactionId}`);
          }
          headerLines.push(sessionSummary(session));
          if ((result.exitCode ?? 0) !== 0) {
            headerLines.push(`Exit: ${result.exitCode ?? "null"}`);
          }
          if (result.durationMs > 20000) {
            headerLines.push(`Time: ${result.durationMs}ms`);
          }

          await bot.telegram.sendMessage(chatId, `${headerLines.join("\n")}\n\n${completionMessage}`);
        }
      } catch (err) {
        await bot.telegram.sendMessage(chatId, `Failed to process prompt: ${String(err)}`);
      } finally {
        sessionLocks.delete(session.id);
      }
    })();
  }


  function buildHelpText(): string {
    return [
      "Commands:",
      "/help - show help",
      "e - show help",
      "/new (/n) - start a new chat in current session slot",
      `/session <${SLOT_TARGET_HINT}> (/s) - switch session (create if empty)`,
      "/history [n] (/h, /y) - show recent runs",
      "/where (/w) - show active session",
      "/whoami (/i) - show your chat id",
      `${LOG_COMMAND} (/l) - toggle interaction log`,
      "/cron ... (/c) - schedule prompts",
      "/slot <list|show|bind> (/t) - manage slot-codex mapping",
      "/plan <on|off|status> (/p) - toggle plan mode",
      "/status (/a) - bot status (admin)",
      "/restart (/r) - bot restart (admin)",
      "Plain text is treated as execution prompt",
      "Session slots rotate A->B->...->Z->A"
    ].join("\n");
  }

  bot.command("help", async (ctx) => {
    await ctx.reply(buildHelpText());
  });

  bot.command("h", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const limit = Number(parts[1] ?? "5");
    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    const rows = store.listHistory(session.id, Number.isNaN(limit) ? 5 : limit);

    if (!rows.length) {
      await ctx.reply(TEXT.noHistory);
      return;
    }

    const lines = rows.map(
      (r) => `${r.id} | ${r.timestamp} | exit=${r.exitCode ?? "null"} | ${r.durationMs}ms | ${r.input.slice(0, 60)}`
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const current = store.getOrCreateSessionByChat(chatId, "telegram");
    const session = store.recreateSessionAtSlot(chatId, current.shortId, "telegram");
    await ctx.reply(`Started new chat in session: ${session.shortId}`);
  });

  bot.command("n", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const current = store.getOrCreateSessionByChat(chatId, "telegram");
    const session = store.recreateSessionAtSlot(chatId, current.shortId, "telegram");
    await ctx.reply(`Started new chat in session: ${session.shortId}`);
  });

  bot.command("session", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const id = parts[1];
    if (!id) {
      await ctx.reply(`Usage: /session <${SLOT_TARGET_HINT}>`);
      return;
    }

    try {
      const session = store.setActiveSession(chatId, id, "telegram");
      await ctx.reply(`Switched to session: ${session.shortId}`);
    } catch (err) {
      await ctx.reply(String(err));
    }
  });

  bot.command("s", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const id = parts[1];
    if (!id) {
      await ctx.reply(`Usage: /session <${SLOT_TARGET_HINT}>`);
      return;
    }

    try {
      const session = store.setActiveSession(chatId, id, "telegram");
      await ctx.reply(`Switched to session: ${session.shortId}`);
    } catch (err) {
      await ctx.reply(String(err));
    }
  });

  bot.command("where", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    await ctx.reply(`Active session: ${session.shortId}`);
  });

  bot.command("w", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    await ctx.reply(`Active session: ${session.shortId}`);
  });

  bot.command("whoami", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) {
      await ctx.reply("No chat id available.");
      return;
    }

    await ctx.reply(`chat_id: ${chatId}`);
  });

  bot.command("i", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) {
      await ctx.reply("No chat id available.");
      return;
    }

    await ctx.reply(`chat_id: ${chatId}`);
  });

  bot.command("log", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const arg = (parts[1] ?? "status").toLowerCase();

    if (arg === "status") {
      await ctx.reply(`Interaction log: ${interactionLogger.isEnabled() ? "ON" : "OFF"}`);
      return;
    }

    if (arg === "on") {
      await interactionLogger.setEnabled(true);
      await ctx.reply(TEXT.logOn);
      return;
    }

    if (arg === "off") {
      await interactionLogger.setEnabled(false);
      await ctx.reply(TEXT.logOff);
      return;
    }

    await ctx.reply(TEXT.logUsage);
  });

  bot.command("l", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const arg = (parts[1] ?? "status").toLowerCase();

    if (arg === "status") {
      await ctx.reply(`Interaction log: ${interactionLogger.isEnabled() ? "ON" : "OFF"}`);
      return;
    }

    if (arg === "on") {
      await interactionLogger.setEnabled(true);
      await ctx.reply(TEXT.logOn);
      return;
    }

    if (arg === "off") {
      await interactionLogger.setEnabled(false);
      await ctx.reply(TEXT.logOff);
      return;
    }

    await ctx.reply(TEXT.logUsage);
  });

  bot.command("plan", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const mode = (parts[1] ?? "status").toLowerCase();

    if (mode === "status") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      await ctx.reply(`Plan mode (${current.shortId}): ${store.getPlanMode(current.id) ? "ON" : "OFF"}`);
      return;
    }

    if (mode === "on") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      store.setPlanMode(current.id, true);
      await ctx.reply(`Plan mode (${current.shortId}): ON`);
      return;
    }

    if (mode === "off") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      store.setPlanMode(current.id, false);
      await ctx.reply(`Plan mode (${current.shortId}): OFF`);
      return;
    }

    await ctx.reply("Usage: /plan <on|off|status>");
  });

  bot.command("p", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const mode = (parts[1] ?? "status").toLowerCase();

    if (mode === "status") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      await ctx.reply(`Plan mode (${current.shortId}): ${store.getPlanMode(current.id) ? "ON" : "OFF"}`);
      return;
    }

    if (mode === "on") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      store.setPlanMode(current.id, true);
      await ctx.reply(`Plan mode (${current.shortId}): ON`);
      return;
    }

    if (mode === "off") {
      const current = store.getOrCreateSessionByChat(chatId, "telegram");
      store.setPlanMode(current.id, false);
      await ctx.reply(`Plan mode (${current.shortId}): OFF`);
      return;
    }

    await ctx.reply("Usage: /plan <on|off|status>");
  });

  bot.command("slot", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const sub = (parts[1] ?? "list").toLowerCase();

    if (sub === "list") {
      const rows = store.listSlotBindings(chatId);
      if (!rows.length) {
        await ctx.reply("No slots found.");
        return;
      }
      await ctx.reply(rows.map((r) => `${r.slotId} | session=${r.sessionId} | codex=${r.codexSessionId ?? "-"}`).join("\n"));
      return;
    }

    if (sub === "show") {
      const slot = (parts[2] ?? "").toUpperCase();
      if (!slot) {
        await ctx.reply("Usage: /slot show <A-Z>");
        return;
      }
      const id = store.resolveSessionId(slot, chatId);
      if (!id) {
        await ctx.reply(`No session in slot ${slot}`);
        return;
      }
      const session = store.getSession(id);
      if (!session) {
        await ctx.reply(`No session in slot ${slot}`);
        return;
      }
      await ctx.reply(`${sessionSummary(session)}\nCodex Session: ${session.codexSessionId ?? "-"}`);
      return;
    }

    if (sub === "bind") {
      const slot = (parts[2] ?? "").toUpperCase();
      const codexSessionId = parts[3] ?? "";
      if (!slot || !codexSessionId) {
        await ctx.reply("Usage: /slot bind <A-Z> <codex_session_id>");
        return;
      }
      try {
        const session = store.bindCodexSession(chatId, slot, codexSessionId);
        await ctx.reply(`Bound ${session.shortId} -> ${session.codexSessionId}\nSession Name: ${session.id}`);
      } catch (err) {
        await ctx.reply(String(err));
      }
      return;
    }

    await ctx.reply("Usage: /slot <list|show|bind>");
  });

  bot.command("t", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const sub = (parts[1] ?? "list").toLowerCase();

    if (sub === "list") {
      const rows = store.listSlotBindings(chatId);
      if (!rows.length) {
        await ctx.reply("No slots found.");
        return;
      }
      await ctx.reply(rows.map((r) => `${r.slotId} | session=${r.sessionId} | codex=${r.codexSessionId ?? "-"}`).join("\n"));
      return;
    }

    if (sub === "show") {
      const slot = (parts[2] ?? "").toUpperCase();
      if (!slot) {
        await ctx.reply("Usage: /slot show <A-Z>");
        return;
      }
      const id = store.resolveSessionId(slot, chatId);
      if (!id) {
        await ctx.reply(`No session in slot ${slot}`);
        return;
      }
      const session = store.getSession(id);
      if (!session) {
        await ctx.reply(`No session in slot ${slot}`);
        return;
      }
      await ctx.reply(`${sessionSummary(session)}\nCodex Session: ${session.codexSessionId ?? "-"}`);
      return;
    }

    if (sub === "bind") {
      const slot = (parts[2] ?? "").toUpperCase();
      const codexSessionId = parts[3] ?? "";
      if (!slot || !codexSessionId) {
        await ctx.reply("Usage: /slot bind <A-Z> <codex_session_id>");
        return;
      }
      try {
        const session = store.bindCodexSession(chatId, slot, codexSessionId);
        await ctx.reply(`Bound ${session.shortId} -> ${session.codexSessionId}\nSession Name: ${session.id}`);
      } catch (err) {
        await ctx.reply(String(err));
      }
      return;
    }

    await ctx.reply("Usage: /slot <list|show|bind>");
  });

  bot.command("cron", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const text = (ctx.message as { text?: string }).text ?? "/cron";
    try {
      const reply = await handleCronCommand(chatId, text);
      await ctx.reply(reply);
    } catch (err) {
      await ctx.reply(String(err));
    }
  });

  bot.command("c", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const text = (ctx.message as { text?: string }).text ?? "/cron";
    try {
      const reply = await handleCronCommand(chatId, text);
      await ctx.reply(reply);
    } catch (err) {
      await ctx.reply(String(err));
    }
  });

  bot.command("status", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (!isAdmin(chatId)) {
      await ctx.reply("Admin only.");
      return;
    }

    await ctx.reply(`Bot status: running
PID: ${process.pid}`);
  });

  bot.command("a", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (!isAdmin(chatId)) {
      await ctx.reply("Admin only.");
      return;
    }

    await ctx.reply(`Bot status: running
PID: ${process.pid}`);
  });

  bot.command("restart", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (!isAdmin(chatId)) {
      await ctx.reply("Admin only.");
      return;
    }

    await ctx.reply("Restarting bot process...");
    setTimeout(() => process.exit(0), 500);
  });

  bot.command("r", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (!isAdmin(chatId)) {
      await ctx.reply("Admin only.");
      return;
    }

    await ctx.reply("Restarting bot process...");
    setTimeout(() => process.exit(0), 500);
  });

  bot.command("history", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const limit = Number(parts[1] ?? "5");
    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    const rows = store.listHistory(session.id, Number.isNaN(limit) ? 5 : limit);

    if (!rows.length) {
      await ctx.reply(TEXT.noHistory);
      return;
    }

    const lines = rows.map(
      (r) => `${r.id} | ${r.timestamp} | exit=${r.exitCode ?? "null"} | ${r.durationMs}ms | ${r.input.slice(0, 60)}`
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("y", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const limit = Number(parts[1] ?? "5");
    const session = store.getOrCreateSessionByChat(chatId, "telegram");
    const rows = store.listHistory(session.id, Number.isNaN(limit) ? 5 : limit);

    if (!rows.length) {
      await ctx.reply(TEXT.noHistory);
      return;
    }

    const lines = rows.map(
      (r) => `${r.id} | ${r.timestamp} | exit=${r.exitCode ?? "null"} | ${r.durationMs}ms | ${r.input.slice(0, 60)}`
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.on("photo", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const message = ctx.message as { photo?: Array<{ file_id: string }>; caption?: string };
    const photos = message.photo ?? [];
    const picked = photos[photos.length - 1];
    if (!picked?.file_id) {
      await ctx.reply("Photo file id is missing.");
      return;
    }

    try {
      const localPath = await downloadTelegramFile(picked.file_id, ".jpg");
      const caption = (message.caption ?? "").trim();
      const prompt = [
        "User sent an image from Telegram.",
        `Local file path: ${localPath}`,
        "Open and analyze the image file directly.",
        caption ? `User request: ${caption}` : "If no explicit request, summarize what is in the image."
      ].join("\n");

      await executePrompt(ctx, prompt);
    } catch (err) {
      await ctx.reply(`Failed to download photo: ${String(err)}`);
    }
  });

  bot.on("document", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const message = ctx.message as {
      document?: { file_id: string; mime_type?: string; file_name?: string };
      caption?: string;
    };
    const document = message.document;
    if (!document?.file_id) {
      await ctx.reply("Document file id is missing.");
      return;
    }

    const mimeType = (document.mime_type ?? "").toLowerCase();
    if (mimeType && !mimeType.startsWith("image/")) {
      await ctx.reply("Only image documents are supported right now.");
      return;
    }

    try {
      const extFromName = path.extname(document.file_name ?? "");
      const ext = extFromName || extensionFromMimeType(mimeType) || ".bin";
      const localPath = await downloadTelegramFile(document.file_id, ext);
      const caption = (message.caption ?? "").trim();
      const prompt = [
        "User sent an image file from Telegram.",
        `Local file path: ${localPath}`,
        "Open and analyze the image file directly.",
        caption ? `User request: ${caption}` : "If no explicit request, summarize what is in the image."
      ].join("\n");

      await executePrompt(ctx, prompt);
    } catch (err) {
      await ctx.reply(`Failed to download document image: ${String(err)}`);
    }
  });

  bot.hears(/^e$/i, async (ctx) => {
    await ctx.reply(buildHelpText());
  });

  bot.on("text", async (ctx) => {
    const text = (ctx.message as { text?: string }).text ?? "";
    if (text.startsWith("/")) {
      return;
    }

    await executePrompt(ctx, text);
  });
}

export async function startTelegramBot(): Promise<void> {
  if (!config.telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment.");
  }

  await store.init();
  await interactionLogger.init();
  await cronStore.init();

  const resolved = await resolveCodexCommand(config.codexCommand);
  console.log(`[jclaw] codex command resolved: ${resolved.command} (${resolved.source})`);


  const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 600000 });
  attachHandlers(bot, resolved.command);

  await bot.telegram.setMyCommands([
    { command: "help", description: "Show help" },
    { command: "new", description: "Start new chat in current slot" },
    { command: "session", description: "Switch session A-Z" },
    { command: "history", description: "Show recent runs" },
    { command: "where", description: "Show active session" },
    { command: "whoami", description: "Show your chat id" },
    { command: "log", description: "Toggle interaction logging" },
    { command: "plan", description: "Toggle plan mode" },
    { command: "slot", description: "Manage slot bindings" },
    { command: "cron", description: "Manage scheduled prompts" },
    { command: "status", description: "Admin bot status" },
    { command: "restart", description: "Admin restart bot" },
    { command: "h", description: "Alias: history" },
    { command: "n", description: "Alias: new" },
    { command: "s", description: "Alias: session" },
    { command: "w", description: "Alias: where" },
    { command: "i", description: "Alias: whoami" },
    { command: "l", description: "Alias: log" },
    { command: "p", description: "Alias: plan" },
    { command: "t", description: "Alias: slot" },
    { command: "c", description: "Alias: cron" },
    { command: "a", description: "Alias: status" },
    { command: "r", description: "Alias: restart" },
    { command: "y", description: "Alias: history" }
  ]);

  await bot.launch();
  await notifyBotStarted(bot);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

if (require.main === module) {
  void startTelegramBot();
}



