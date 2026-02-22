import dotenv from "dotenv";
import path from "node:path";
import { startTelegramBot } from "../apps/telegram/bot";
import { loadConfig } from "../core/config/env";
import { appendTelegramCrashLogSync } from "../core/logging/telegramCrashLog";
import { acquireProcessLock } from "../core/runtime/processLock";
import { BUILD_TIME_ISO } from "../generated/buildInfo";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const crashLogPath = path.join(dataDir, "telegram-crash-logs.json");
const lockPath = path.join(dataDir, "telegram-bot.lock");

const RETRY_DELAY_MS = 5000;

const releaseLock = acquireProcessLock(lockPath, "jclaw telegram bot");
process.on("exit", releaseLock);

function isRetryable(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("Promise timed out") ||
    msg.includes("429") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET")
  );
}

function recordCrash(source: string, err: unknown): void {
  try {
    appendTelegramCrashLogSync(crashLogPath, source, err);
  } catch (logErr) {
    console.error("[jclaw] failed to persist telegram crash log:", logErr);
  }
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

async function notifyProcessBooted(): Promise<void> {
  if (!config.telegramBotToken || config.allowedChatIds.size === 0) {
    return;
  }

  const startedAt = new Date().toISOString();
  const targets = Array.from(config.allowedChatIds);
  console.log(`[jclaw] startup process notify targets: ${targets.join(",")}`);
  const text = [
    "[jclaw] Telegram process booted",
    `build: ${BUILD_TIME_ISO} (KST ${formatKst(BUILD_TIME_ISO)})`,
    `boot: ${startedAt} (KST ${formatKst(startedAt)})`
  ].join("\n");

  for (const chatId of targets) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      });
      if (!response.ok) {
        const body = await response.text();
        console.error(`[jclaw] startup notify failed for ${chatId}: ${response.status} ${body}`);
      } else {
        console.log(`[jclaw] startup process notification sent to ${chatId}`);
      }
    } catch (err) {
      console.error(`[jclaw] startup notify failed for ${chatId}:`, err);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("uncaughtException", (err) => {
  recordCrash("uncaughtException", err);
  console.error("[jclaw] uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  recordCrash("unhandledRejection", reason);
  console.error("[jclaw] unhandled rejection:", reason);
  process.exit(1);
});

async function boot(): Promise<void> {
  while (true) {
    try {
      await startTelegramBot();
      return;
    } catch (err) {
      recordCrash("boot", err);
      console.error("[jclaw] telegram bot failed:", err);
      if (!isRetryable(err)) {
        process.exit(1);
      }
      console.error(`[jclaw] retrying telegram bot in ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

void (async () => {
  await notifyProcessBooted();
  await boot();
})();
