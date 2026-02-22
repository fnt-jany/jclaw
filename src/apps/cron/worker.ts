import dotenv from "dotenv";
import path from "node:path";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { applyPlanModePrompt } from "../../core/codex/promptMode";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronJob, CronStore } from "../../core/cron/store";
import { sendCronTelegramNotification } from "../../core/telegram/notify";

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

async function notifyCronResult(input: {
  job: CronJob;
  sessionName: string | null;
  status: "ok" | "error";
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
}): Promise<void> {
  if (!config.cronNotifyTelegram || !config.telegramBotToken) {
    return;
  }

  try {
    await sendCronTelegramNotification({
      botToken: config.telegramBotToken,
      chatId: input.job.chatId,
      maxChars: config.cronNotifyMaxChars,
      verbose: config.cronNotifyVerbose,
      job: input.job,
      sessionName: input.sessionName,
      status: input.status,
      prompt: input.job.prompt,
      output: input.output,
      error: input.error,
      exitCode: input.exitCode,
      durationMs: input.durationMs
    });
  } catch (err) {
    console.error(`[cron] telegram notify failed for ${input.job.id}:`, err);
  }
}

async function markFailureAndNotify(job: CronJob, sessionName: string | null, reason: string): Promise<void> {
  await cronStore.markRunResult(job.id, false, reason);
  await notifyCronResult({
    job,
    sessionName,
    status: "error",
    output: "",
    error: reason,
    exitCode: null,
    durationMs: 0
  });
  if (job.runOnce) {
    await cronStore.remove(job.id);
  }
}

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

    let session;
    try {
      session = sessionStore.ensureSessionForTarget(job.chatId, job.sessionTarget);
    } catch (err) {
      await markFailureAndNotify(job, null, String(err));
      return;
    }

    const planMode = sessionStore.getPlanMode(session.id);
    const effectivePrompt = applyPlanModePrompt(job.prompt, planMode);

    const result = await runCodex({
      codexCommand: codexCommandResolved,
      codexArgsTemplate: config.codexArgsTemplate,
      prompt: effectivePrompt,
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

    const ok = (result.exitCode ?? 1) === 0;
    await cronStore.markRunResult(job.id, ok, result.error);
    await notifyCronResult({
      job,
      sessionName: session.id,
      status: ok ? "ok" : "error",
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });
    if (job.runOnce) {
      await cronStore.remove(job.id);
    }

    console.log(`[cron] job ${job.id} ran for slot ${session.shortId} (exit=${result.exitCode ?? "null"})`);
  } catch (err) {
    const job = cronStore.get(jobId);
    if (job) {
      await markFailureAndNotify(job, null, String(err));
    } else {
      await cronStore.markRunResult(jobId, false, String(err));
    }
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

  console.log(`[cron] worker started; poll=${pollMs}ms notify=${config.cronNotifyTelegram ? "on" : "off"}`);
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

