import { startTelegramBot } from "../apps/telegram/bot";

const RETRY_DELAY_MS = 5000;

function isRetryable(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("Promise timed out") ||
    msg.includes("429") ||
    msg.includes("409") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(): Promise<void> {
  while (true) {
    try {
      await startTelegramBot();
      return;
    } catch (err) {
      console.error("[jclaw] telegram bot failed:", err);
      if (!isRetryable(err)) {
        process.exit(1);
      }
      console.error(`[jclaw] retrying telegram bot in ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

void boot();
