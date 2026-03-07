import dotenv from "dotenv";
import path from "node:path";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runLlm } from "../../core/llm/execute";
import { resolveRunnerForSession } from "../../core/llm/router";
import { applyPlanModePrompt } from "../../core/llm/promptMode";
import { resolveCodexCommand } from "../../core/commands/codexResolver";
import { resolveGeminiRunner } from "../../core/commands/geminiResolver";
import { resolveClaudeRunner } from "../../core/commands/claudeResolver";
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
let geminiRunnerResolved = { command: "", argsTemplate: "" };
let claudeRunnerResolved = { command: "", argsTemplate: "" };

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

    const runner = resolveRunnerForSession(session, config, codexCommandResolved, geminiRunnerResolved, claudeRunnerResolved);
    const startedAt = Date.now();
    const logChunk = (stream: "stdout" | "stderr", chunk: string): void => {
      const single = chunk.replace(/\r?\n/g, "\\n").trim();
      if (!single) {
        return;
      }
      const clipped = single.length > 260 ? `${single.slice(0, 260)}...[+${single.length - 260} chars]` : single;
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`[jclaw-cron] chunk job=${job.id} slot=${session.shortId} session=${session.id} elapsed=${elapsedSec}s stream=${stream} msg=${clipped}`);
    };

    const result = await runLlm({
      codexCommand: runner.command,
      codexArgsTemplate: runner.argsTemplate,
      prompt: effectivePrompt,
      sessionId: session.id,
      threadId: session.threadId,
      timeoutMs: config.codexTimeoutMs,
      workdir: config.codexWorkdir,
      codexNodeOptions: config.codexNodeOptions,
      reasoningEffort: sessionStore.getReasoningEffort(session.id),
      provider: runner.provider,
      modelOverride: sessionStore.getSessionModelOverride(session.id),
      onStdoutChunk: (chunk) => logChunk("stdout", chunk),
      onStderrChunk: (chunk) => logChunk("stderr", chunk)
    });

    const resolvedThreadId = result.threadId;
    if (resolvedThreadId && resolvedThreadId !== session.threadId) {
      sessionStore.setSessionThread(session.id, runner.provider, resolvedThreadId);
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
  const geminiResolved = await resolveGeminiRunner(config.geminiCommand, config.geminiArgsTemplate);
  geminiRunnerResolved = { command: geminiResolved.command, argsTemplate: geminiResolved.argsTemplate };
  console.log(`[cron] gemini command resolved: ${geminiResolved.command} (${geminiResolved.source})`);
  const claudeResolved = await resolveClaudeRunner(config.claudeCommand, config.claudeArgsTemplate);
  claudeRunnerResolved = { command: claudeResolved.command, argsTemplate: claudeResolved.argsTemplate };
  console.log(`[cron] claude command resolved: ${claudeResolved.command} (${claudeResolved.source})`);

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

