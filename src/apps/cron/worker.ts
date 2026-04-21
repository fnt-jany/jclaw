import dotenv from "dotenv";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { getEffectiveSessionWorkdir } from "../../core/session/workdir";
import { runLlm } from "../../core/llm/execute";
import { resolveRunnerForSession } from "../../core/llm/router";
import { resolveLlmProviderForSession } from "../../core/llm/registry";
import { applyPlanModePrompt } from "../../core/llm/promptMode";
import { resolveCodexCommand } from "../../core/commands/codexResolver";
import { resolveGeminiRunner } from "../../core/commands/geminiResolver";
import { resolveClaudeRunner } from "../../core/commands/claudeResolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronJob, CronStore } from "../../core/cron/store";
import { sendCronTelegramNotification } from "../../core/telegram/notify";
import { getCronWakePort } from "../../core/cron/wakeup";

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");
const activePollMs = Math.max(5000, Number(process.env.JCLAW_CRON_ACTIVE_POLL_MS ?? "30000") || 30000);
const wakePort = getCronWakePort();

const cronStore = new CronStore(config.dbFile);
const sessionStore = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const runningJobs = new Set<string>();
let wakeTimer: NodeJS.Timeout | null = null;

let codexCommandResolved: string | null = null;
let geminiRunnerResolved: { command: string; argsTemplate: string } | null = null;
let claudeRunnerResolved: { command: string; argsTemplate: string } | null = null;

async function ensureCodexCommandResolved(): Promise<string> {
  if (codexCommandResolved) {
    return codexCommandResolved;
  }

  const resolved = await resolveCodexCommand(config.codexCommand);
  codexCommandResolved = resolved.command;
  console.log(`[cron] codex command resolved: ${resolved.command} (${resolved.source})`);
  return codexCommandResolved;
}

async function ensureGeminiRunnerResolved(): Promise<{ command: string; argsTemplate: string }> {
  if (geminiRunnerResolved) {
    return geminiRunnerResolved;
  }

  const resolved = await resolveGeminiRunner(config.geminiCommand, config.geminiArgsTemplate);
  geminiRunnerResolved = { command: resolved.command, argsTemplate: resolved.argsTemplate };
  console.log(`[cron] gemini command resolved: ${resolved.command} (${resolved.source})`);
  return geminiRunnerResolved;
}

async function ensureClaudeRunnerResolved(): Promise<{ command: string; argsTemplate: string }> {
  if (claudeRunnerResolved) {
    return claudeRunnerResolved;
  }

  const resolved = await resolveClaudeRunner(config.claudeCommand, config.claudeArgsTemplate);
  claudeRunnerResolved = { command: resolved.command, argsTemplate: resolved.argsTemplate };
  console.log(`[cron] claude command resolved: ${resolved.command} (${resolved.source})`);
  return claudeRunnerResolved;
}

function clearWakeTimer(): void {
  if (!wakeTimer) {
    return;
  }
  clearTimeout(wakeTimer);
  wakeTimer = null;
}

async function scheduleNextWake(reason: string): Promise<void> {
  clearWakeTimer();
  await cronStore.reload();

  const hasEnabledJobs = cronStore.list().some((job) => job.enabled);
  if (!hasEnabledJobs) {
    console.log(`[cron] idle; awaiting wake notify (${reason})`);
    return;
  }

  console.log(`[cron] next wake in ${activePollMs}ms (${reason}; mode=active)`);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void tick();
  }, activePollMs);
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = (req.socket.remoteAddress ?? "").trim();
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function handleWakeRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!isLoopbackRequest(req)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Loopback only" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
  clearWakeTimer();
  void tick();
}

async function notifyWebSessionUpdate(input: { slot: string; sessionId: string; source: string; trigger: string }): Promise<void> {
  const port = Number(process.env.JCLAW_WEB_PORT ?? "3100") || 3100;
  const url = `http://127.0.0.1:${port}/api/internal/session-event`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot: input.slot,
        sessionId: input.sessionId,
        source: input.source,
        trigger: input.trigger,
        ts: new Date().toISOString()
      })
    });
  } catch (err) {
    console.error(`[cron] web notify failed for slot ${input.slot}:`, err);
  }
}

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

    const provider = resolveLlmProviderForSession(session, config);
    const runner = resolveRunnerForSession(
      session,
      config,
      await ensureCodexCommandResolved(),
      provider === "gemini" ? await ensureGeminiRunnerResolved() : { command: "", argsTemplate: "" },
      provider === "claude" ? await ensureClaudeRunnerResolved() : { command: "", argsTemplate: "" }
    );
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
      workdir: getEffectiveSessionWorkdir(sessionStore, session.id, config.codexWorkdir),
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

    await notifyWebSessionUpdate({
      slot: session.shortId,
      sessionId: session.id,
      source: "cron",
      trigger: job.id
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
    await scheduleNextWake(`job ${job.id} completed`);
  } catch (err) {
    const job = cronStore.get(jobId);
    if (job) {
      await markFailureAndNotify(job, null, String(err));
    } else {
      await cronStore.markRunResult(jobId, false, String(err));
    }
    console.error(`[cron] job ${jobId} failed:`, err);
    await scheduleNextWake(`job ${jobId} failed`);
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
  await scheduleNextWake(jobs.length > 0 ? `dispatched ${jobs.length} due job(s)` : "idle");
}

export async function startCronWorker(): Promise<void> {
  const wakeServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${wakePort}`}`).pathname;
    if (req.method === "POST" && pathname === "/wake") {
      handleWakeRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await sessionStore.init();
  await cronStore.init();
  await interactionLogger.init();

  await ensureCodexCommandResolved();
  await new Promise<void>((resolve, reject) => {
    wakeServer.once("error", reject);
    wakeServer.listen(wakePort, "127.0.0.1", () => resolve());
  });

  console.log(`[cron] worker started; active_poll=${activePollMs}ms wake_port=${wakePort} notify=${config.cronNotifyTelegram ? "on" : "off"}`);
  await tick();

  process.once("SIGINT", () => {
    clearWakeTimer();
    wakeServer.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    clearWakeTimer();
    wakeServer.close();
    process.exit(0);
  });
}

if (require.main === module) {
  void startCronWorker();
}

