import dotenv from "dotenv";
import path from "node:path";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { listUnhandledTelegramCrashLogs, markTelegramCrashLogsProcessed } from "../../core/logging/telegramCrashLog";
import { CronStore } from "../../core/cron/store";
import { buildOneShotCron } from "../../core/cron/oneshot";
import { parseArgs } from "../../core/commands/args";
import { LOG_COMMAND, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";
import { sessionSummary } from "../../shared/types";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");
const crashLogPath = path.join(dataDir, "telegram-crash-logs.json");

const store = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const cronStore = new CronStore(config.dbFile);
const sessionLocks = new Set<string>();

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

function buildCrashLogPrompt(rows: Array<{ id: string; timestamp: string; source: string; message: string; stack: string }>): string {
  const header = [
    "Review these Telegram crash logs.",
    "Summarize likely cause, immediate checks, and prevention steps.",
    ""
  ];

  const body = rows.map((row, idx) => {
    const stackLines = row.stack
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
      .join("\n");

    return [
      `${idx + 1}) id=${row.id}`,
      `time=${row.timestamp}`,
      `source=${row.source}`,
      `message=${row.message}`,
      "stack=",
      stackLines || "(empty)",
      ""
    ].join("\n");
  });

  return [...header, ...body].join("\n");
}

async function requestCrashLogHandlingToSectionJ(resolvedCodexCommand: string): Promise<void> {
  const pending = listUnhandledTelegramCrashLogs(crashLogPath);
  if (!pending.length) {
    return;
  }

  const chatId = Array.from(config.allowedChatIds)[0];
  if (!chatId) {
    console.error("[jclaw] pending telegram crash logs found, but ALLOWED_CHAT_IDS is empty.");
    return;
  }

  const session = store.ensureSessionForTarget(chatId, "J");
  const prompt = buildCrashLogPrompt(pending);
  const result = await runCodex({
    codexCommand: resolvedCodexCommand,
    codexArgsTemplate: config.codexArgsTemplate,
    prompt,
    sessionId: session.id,
    codexSessionId: session.codexSessionId,
    timeoutMs: config.codexTimeoutMs,
    workdir: config.codexWorkdir,
    codexNodeOptions: config.codexNodeOptions
  });

  if (result.codexSessionId && result.codexSessionId !== session.codexSessionId) {
    store.setCodexSessionId(session.id, result.codexSessionId);
  }

  store.appendRun(session.id, {
    id: `r_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    timestamp: new Date().toISOString(),
    input: "[system] process telegram crash logs",
    output: result.output,
    error: result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  });

  const note = result.error
    ? `requested-to-section-J (error: ${result.error.slice(0, 160)})`
    : `requested-to-section-J (exit=${result.exitCode ?? "null"})`;

  markTelegramCrashLogsProcessed(
    crashLogPath,
    pending.map((row) => row.id),
    note
  );

  console.log(`[jclaw] requested crash-log handling to session J for ${pending.length} item(s)`);
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
    await ctx.reply(`Running in session ${session.shortId}...`);

    await ctx.reply("processing...");
    let progressQueue: Promise<void> = Promise.resolve();
    let chunkBuffer = "";

    const enqueueProcessing = (): void => {
      progressQueue = progressQueue.then(async () => {
        try {
          await ctx.reply("processing...");
        } catch {
          // ignore transient telegram send errors for progress pings
        }
      });
    };

    const isProgressLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      return (
        /^thinking\b/i.test(trimmed) ||
        /^exec\b/i.test(trimmed) ||
        /^OpenAI Codex\b/i.test(trimmed) ||
        /^mcp startup\b/i.test(trimmed) ||
        /^tokens used\b/i.test(trimmed)
      );
    };

    const onChunk = (chunk: string): void => {
      chunkBuffer += chunk;
      const lines = chunkBuffer.split(/\r?\n/);
      chunkBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (isProgressLine(line)) {
          enqueueProcessing();
        }
      }
    };

    const heartbeat = setInterval(() => {
      enqueueProcessing();
    }, 25000);

    try {
      const result = await runCodex({
        codexCommand: resolvedCodexCommand,
        codexArgsTemplate: config.codexArgsTemplate,
        prompt,
        sessionId: session.id,
        codexSessionId: session.codexSessionId,
        timeoutMs: config.codexTimeoutMs,
        workdir: config.codexWorkdir,
        codexNodeOptions: config.codexNodeOptions,
        onStdoutChunk: onChunk,
        onStderrChunk: onChunk
      });

      clearInterval(heartbeat);
      if (chunkBuffer && isProgressLine(chunkBuffer)) {
        enqueueProcessing();
      }
      await progressQueue;

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
        await ctx.reply(completionMessage);
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

        await ctx.reply(`${headerLines.join("\n")}\n\n${completionMessage}`);
      }
    } finally {
      clearInterval(heartbeat);
      sessionLocks.delete(session.id);
    }
  }

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "Commands:",
        "/help",
        "/new - create and switch to a new session",
        `/session <${SLOT_TARGET_HINT}> - switch session`,
        "/history [n] - show recent runs",
        "/where - show active session",
        "/whoami - show your chat id",
        `${LOG_COMMAND} - toggle interaction log`,
        "/cron ... - schedule prompts",
        "/slot <list|show|bind> - manage slot-codex mapping",
        "/admin <status|restart> - admin controls",
        "Plain text is treated as execution prompt",
        "Session slots rotate A->B->...->Z->A"
      ].join("\n")
    );
  });

  bot.command("new", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    const session = store.createAndActivateSession(chatId, "telegram");
    await ctx.reply(`Switched to new session: ${session.shortId}`);
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

  bot.command("where", async (ctx) => {
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

  bot.command("admin", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId || !isAllowed(chatId)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (!isAdmin(chatId)) {
      await ctx.reply("Admin only.");
      return;
    }

    const parts = (ctx.message as { text?: string }).text?.split(" ").filter(Boolean) ?? [];
    const sub = (parts[1] ?? "status").toLowerCase();

    if (sub === "status") {
      await ctx.reply(`Bot status: running
PID: ${process.pid}`);
      return;
    }

    if (sub === "restart") {
      await ctx.reply("Restarting bot process...");
      setTimeout(() => process.exit(0), 500);
      return;
    }

    await ctx.reply("Usage: /admin <status|restart>");
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

  await requestCrashLogHandlingToSectionJ(resolved.command);

  const bot = new Telegraf(config.telegramBotToken);
  attachHandlers(bot, resolved.command);

  await bot.telegram.setMyCommands([
    { command: "help", description: "Show help" },
    { command: "new", description: "Create and switch session" },
    { command: "session", description: "Switch session A-Z" },
    { command: "history", description: "Show recent runs" },
    { command: "where", description: "Show active session" },
    { command: "whoami", description: "Show your chat id" },
    { command: "log", description: "Toggle interaction logging" },
    { command: "slot", description: "Manage slot bindings" },
    { command: "cron", description: "Manage scheduled prompts" },
    { command: "admin", description: "Admin controls" }
  ]);

  await bot.launch();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

if (require.main === module) {
  void startTelegramBot();
}


