import dotenv from "dotenv";
import path from "node:path";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronStore } from "../../core/cron/store";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");
const pollMs = Number(process.env.JCLAW_CRON_POLL_MS ?? "10000");

const cronStore = new CronStore(config.dbFile);
const sessionStore = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const runningJobs = new Set<string>();

let codexCommandResolved = "";

async function executeJob(jobId: string): Promise<void> {
  if (runningJobs.has(jobId)) {
    return;
  }

  runningJobs.add(jobId);
  try {
    await sessionStore.init();
    await cronStore.reload();
    const job = cronStore.get(jobId);
    if (!job || !job.enabled) {
      return;
    }

    let resolvedSessionId: string | null = null;
    try {
      resolvedSessionId = sessionStore.resolveSessionId(job.sessionTarget, job.chatId);
    } catch (err) {
      await cronStore.markRunResult(job.id, false, String(err));
      return;
    }

    if (!resolvedSessionId) {
      await cronStore.markRunResult(job.id, false, `Session not found: ${job.sessionTarget}`);
      return;
    }

    const session = sessionStore.getSession(resolvedSessionId);
    if (!session) {
      await cronStore.markRunResult(job.id, false, `Session not found: ${resolvedSessionId}`);
      return;
    }

    const result = await runCodex({
      codexCommand: codexCommandResolved,
      codexArgsTemplate: config.codexArgsTemplate,
      prompt: job.prompt,
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      timeoutMs: config.codexTimeoutMs,
      workdir: config.codexWorkdir,
      codexNodeOptions: config.codexNodeOptions
    });

    if (result.codexSessionId && result.codexSessionId !== session.codexSessionId) {
      sessionStore.setCodexSessionId(session.id, result.codexSessionId);
    }

    sessionStore.appendRun(session.id, {
      id: `r_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      input: `[cron:${job.id}] ${job.prompt}`,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    await interactionLogger.append({
      channel: "cron",
      sessionId: session.id,
      chatId: job.chatId,
      input: `[cron:${job.id}] ${job.prompt}`,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    await cronStore.markRunResult(job.id, (result.exitCode ?? 1) === 0, result.error);
    console.log(`[cron] job ${job.id} ran for slot ${session.shortId} (exit=${result.exitCode ?? "null"})`);
  } catch (err) {
    await cronStore.markRunResult(jobId, false, String(err));
    console.error(`[cron] job ${jobId} failed:`, err);
  } finally {
    runningJobs.delete(jobId);
  }
}

async function tick(): Promise<void> {
  await cronStore.reload();
  const jobs = cronStore.dueJobs(new Date());
  for (const job of jobs) {
    void executeJob(job.id);
  }
}

export async function startCronWorker(): Promise<void> {
  await sessionStore.init();
  await cronStore.init();
  await interactionLogger.init();

  const resolved = await resolveCodexCommand(config.codexCommand);
  codexCommandResolved = resolved.command;

  console.log(`[cron] worker started; poll=${pollMs}ms`);
  await tick();
  const timer = setInterval(() => {
    void tick();
  }, pollMs);

  process.once("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

if (require.main === module) {
  void startCronWorker();
}

