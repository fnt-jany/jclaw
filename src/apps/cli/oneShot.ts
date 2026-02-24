import dotenv from "dotenv";
import path from "node:path";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { applyPlanModePrompt } from "../../core/codex/promptMode";
import { resolveCodexCommand } from "../../core/commands/resolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { DEFAULT_LOCAL_CHAT_ID, SLOT_TARGET_HINT } from "../../shared/constants";
import { sessionSummary } from "../../shared/types";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);

type CliArgs = {
  sessionId: string | null;
  chatId: string;
  prompt: string;
};

function parseArgs(argv: string[], defaultChatId: string): CliArgs {
  const args = [...argv];
  let sessionId: string | null = null;
  let chatId = defaultChatId;

  for (let i = 0; i < args.length; ) {
    if (args[i] === "--session") {
      sessionId = args[i + 1] ?? null;
      args.splice(i, 2);
      continue;
    }
    if (args[i] === "--chat") {
      chatId = args[i + 1] ?? defaultChatId;
      args.splice(i, 2);
      continue;
    }
    i += 1;
  }

  return {
    sessionId,
    chatId,
    prompt: args.join(" ").trim()
  };
}

export async function startCliOneShot(): Promise<void> {
  const defaultChatId = Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
  const parsed = parseArgs(process.argv.slice(2), defaultChatId);

  if (!parsed.prompt) {
    console.error(`Usage: npm run cli -- [--chat <chat_id>] [--session <${SLOT_TARGET_HINT}>] <prompt>`);
    process.exit(1);
  }

  const store = new SessionStore(config.dbFile);
  const interactionLogPath = path.join(path.dirname(config.dataFile), "interactions.json");
  const interactionLogger = new InteractionLogger(interactionLogPath);
  await store.init();
  await interactionLogger.init();

  const resolved = await resolveCodexCommand(config.codexCommand);

  let resolvedSessionId: string | null = null;
  if (parsed.sessionId) {
    try {
      resolvedSessionId = store.resolveSessionId(parsed.sessionId, parsed.chatId);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }
  }

  let session = resolvedSessionId ? store.getSession(resolvedSessionId) : null;
  if (parsed.sessionId && !session) {
    console.error(`Session not found in chat '${parsed.chatId}': ${parsed.sessionId}`);
    process.exit(1);
  }

  if (!session) {
    session = store.getOrCreateSessionByChat(parsed.chatId, "cli");
  }

  const planMode = store.getPlanMode(session.id);
  const effectivePrompt = applyPlanModePrompt(parsed.prompt, planMode);

  const result = await runCodex({
    codexCommand: resolved.command,
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
    input: parsed.prompt,
    output: result.output,
    error: result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  });

  const interactionId = await interactionLogger.append({
    channel: "cli",
    sessionId: session.id,
    chatId: parsed.chatId,
    input: parsed.prompt,
    output: result.output,
    error: result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  });

  if (!interactionLogger.isEnabled()) {
    process.stdout.write(result.output || "");
  } else {
    const headerLines: string[] = [];
    if (interactionId !== null) {
      headerLines.push(`Req#: ${interactionId}`);
    }
    headerLines.push(sessionSummary(session));
    headerLines.push(`Chat: ${parsed.chatId}`);
    if ((result.exitCode ?? 0) !== 0) {
      headerLines.push(`Exit: ${result.exitCode ?? "null"}`);
    }
    if (result.durationMs > 20000) {
      headerLines.push(`Time: ${result.durationMs}ms`);
    }

    process.stdout.write(`${headerLines.join("\n")}\n\n${result.output || "(no output)"}`);
  }

  if (result.error) {
    process.stderr.write(`\n${result.error}\n`);
  }

  process.exit(result.exitCode ?? 1);
}

if (require.main === module) {
  void startCliOneShot();
}


