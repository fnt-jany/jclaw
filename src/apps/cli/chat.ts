import dotenv from "dotenv";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../../core/config/env";
import { SessionStore, Session } from "../../core/session/sessionStore";
import { assertDirectoryExists, formatDirectoryListing, getEffectiveSessionWorkdir, resolveSessionCdTarget } from "../../core/session/workdir";
import { cancelSessionRuns, runLlm } from "../../core/llm/execute";
import { resolveRunnerForSession } from "../../core/llm/router";
import { formatAllModelCatalogs, formatModelCatalog, hasModelCatalog } from "../../core/llm/modelCatalog";
import { applyPlanModePrompt } from "../../core/llm/promptMode";
import { resolveCodexCommand } from "../../core/commands/codexResolver";
import { resolveGeminiRunner } from "../../core/commands/geminiResolver";
import { resolveClaudeRunner } from "../../core/commands/claudeResolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { DEFAULT_LOCAL_CHAT_ID, LOG_COMMAND, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";
import { sessionSummary } from "../../shared/types";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);

type ChatArgs = {
  sessionId: string | null;
  chatId: string;
};

function parseArgs(argv: string[], defaultChatId: string): ChatArgs {
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

  return { sessionId, chatId };
}

function printHelp(): void {
  output.write(
    [
      "Commands:",
      "/help                Show this help",
      "/where               Show current slot and session name",
      "/new                 Start a new chat in the current slot",
      `/session <${SLOT_TARGET_HINT}>    Switch session`,
      `${LOG_COMMAND} Toggle interaction logging`,
      "/plan <on|off|status> Toggle plan mode",
      "/cancel              Cancel the running request in current slot",
      "/pwd                 Show effective workdir",
      "/ls                  List files in effective workdir",
      "/cd <path|..>        Change effective workdir",
      "/reason <none|low|medium|high|status> Set reasoning effort",
      "/workdir <path|status|clear> Set workdir override for this slot",
      "/model <name|status|clear> Set model override for this slot",
      "/models [current|all|codex|gemini|claude] Show model arguments",
      "/slot <list|show|bind> Manage slot-provider-thread mapping",
      "/exit                Quit chat mode"
    ].join("\n") + "\n"
  );
}

function normalizeCommand(line: string): string {
  if (line.startsWith(":")) {
    return `/${line.slice(1)}`;
  }
  const trimmed = line.trim();
  if (/^pwd$/i.test(trimmed)) {
    return "/pwd";
  }
  if (/^ls$/i.test(trimmed)) {
    return "/ls";
  }
  if (/^cd\.\.$/i.test(trimmed)) {
    return "/cd ..";
  }
  if (/^cd\s+/i.test(trimmed)) {
    return `/${trimmed}`;
  }
  return line;
}

async function runPrompt(
  prompt: string,
  chatId: string,
  session: Session,
  store: SessionStore,
  interactionLogger: InteractionLogger,
  codexCommand: string,
  geminiRunner: { command: string; argsTemplate: string },
  claudeRunner: { command: string; argsTemplate: string }
): Promise<void> {
  const planMode = store.getPlanMode(session.id);
  const effectivePrompt = applyPlanModePrompt(prompt, planMode);

  const runner = resolveRunnerForSession(session, config, codexCommand, geminiRunner, claudeRunner);
  const result = await runLlm({
    codexCommand: runner.command,
    codexArgsTemplate: runner.argsTemplate,
    prompt: effectivePrompt,
    sessionId: session.id,
    threadId: session.threadId,
    timeoutMs: config.codexTimeoutMs,
    workdir: getEffectiveSessionWorkdir(store, session.id, config.codexWorkdir),
    codexNodeOptions: config.codexNodeOptions,
    reasoningEffort: store.getReasoningEffort(session.id),
    provider: runner.provider,
    modelOverride: store.getSessionModelOverride(session.id)
  });

  const resolvedThreadId = result.threadId;
  if (resolvedThreadId && resolvedThreadId !== session.threadId) {
    store.setSessionThread(session.id, runner.provider, resolvedThreadId);
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
    channel: "cli",
    sessionId: session.id,
    chatId,
    input: prompt,
    output: result.output,
    error: result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  });

  if (!interactionLogger.isEnabled()) {
    output.write(`${result.output || "(no output)"}\n`);
  } else {
    const headerLines: string[] = [];
    if (interactionId !== null) {
      headerLines.push(`Req#: ${interactionId}`);
    }
    headerLines.push(sessionSummary(session));
    headerLines.push(`Chat: ${chatId}`);
    if ((result.exitCode ?? 0) !== 0) {
      headerLines.push(`Exit: ${result.exitCode ?? "null"}`);
    }
    if (result.durationMs > 20000) {
      headerLines.push(`Time: ${result.durationMs}ms`);
    }

    output.write(`${headerLines.join("\n")}\n\n${result.output || "(no output)"}\n`);
  }

  if (result.error) {
    output.write(`\n${result.error}\n`);
  }
}

export async function startCliChat(): Promise<void> {
  const defaultChatId = Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
  const parsed = parseArgs(process.argv.slice(2), defaultChatId);

  const store = new SessionStore(config.dbFile);
  const interactionLogPath = path.join(path.dirname(config.dataFile), "interactions.json");
  const interactionLogger = new InteractionLogger(interactionLogPath);
  await store.init();
  await interactionLogger.init();

  const resolved = await resolveCodexCommand(config.codexCommand);
  const geminiResolved = await resolveGeminiRunner(config.geminiCommand, config.geminiArgsTemplate);
  const geminiRunner = { command: geminiResolved.command, argsTemplate: geminiResolved.argsTemplate };
  const claudeResolved = await resolveClaudeRunner(config.claudeCommand, config.claudeArgsTemplate);
  const claudeRunner = { command: claudeResolved.command, argsTemplate: claudeResolved.argsTemplate };

  let session: Session;
  if (parsed.sessionId) {
    const resolvedId = store.resolveSessionId(parsed.sessionId, parsed.chatId);
    if (!resolvedId) {
      throw new Error(`Session not found in chat '${parsed.chatId}': ${parsed.sessionId}`);
    }
    const found = store.getSession(resolvedId);
    if (!found) {
      throw new Error(`Session not found in chat '${parsed.chatId}': ${parsed.sessionId}`);
    }
    session = found;
    store.setActiveSession(parsed.chatId, resolvedId, "cli");
  } else {
    session = store.getOrCreateSessionByChat(parsed.chatId, "cli");
  }

  output.write(`jclaw chat mode started (chat=${parsed.chatId}, slot=${session.shortId})\n`);
  printHelp();

  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const original = (await rl.question(`[${session.shortId}] > `)).trim();
      if (!original) {
        continue;
      }

      const line = normalizeCommand(original);

      if (line === "/exit") {
        break;
      }
      if (line === "/help") {
        printHelp();
        continue;
      }
      if (line === "/where") {
        output.write(`${sessionSummary(session)}\n`);
        continue;
      }
      if (line === "/cancel") {
        output.write(cancelSessionRuns(session.id) ? `Cancelled running request in session ${session.shortId}
` : `No running request in session ${session.shortId}
`);
        continue;
      }

      if (line === "/new") {
        session = store.createAndActivateSession(parsed.chatId, "cli");
        output.write(`Switched to slot ${session.shortId} (${session.id})\n`);
        continue;
      }
      if (line.startsWith("/session ")) {
        const target = line.slice(9).trim();
        if (!target) {
          output.write(`Usage: /session <${SLOT_TARGET_HINT}>\n`);
          continue;
        }
        try {
          session = store.setActiveSession(parsed.chatId, target, "cli");
          output.write(`Switched to slot ${session.shortId} (${session.id})\n`);
        } catch (err) {
          output.write(`${String(err)}\n`);
        }
        continue;
      }
      if (line.startsWith("/log")) {
        const arg = line.split(" ").filter(Boolean)[1]?.toLowerCase() ?? "status";
        if (arg === "status") {
          output.write(`Interaction log: ${interactionLogger.isEnabled() ? "ON" : "OFF"}\n`);
          continue;
        }
        if (arg === "on") {
          await interactionLogger.setEnabled(true);
          output.write(`${TEXT.logOn}\n`);
          continue;
        }
        if (arg === "off") {
          await interactionLogger.setEnabled(false);
          output.write(`${TEXT.logOff}\n`);
          continue;
        }
        output.write(`${TEXT.logUsage}\n`);
        continue;
      }

      if (line.startsWith("/plan")) {
        const arg = line.split(" ").filter(Boolean)[1]?.toLowerCase() ?? "status";
        if (arg === "status") {
          output.write(`Plan mode: ${store.getPlanMode(session.id) ? "ON" : "OFF"}\n`);
          continue;
        }
        if (arg === "on") {
          store.setPlanMode(session.id, true);
          output.write("Plan mode: ON\n");
          continue;
        }
        if (arg === "off") {
          store.setPlanMode(session.id, false);
          output.write("Plan mode: OFF\n");
          continue;
        }
        output.write("Usage: /plan <on|off|status>\n");
        continue;
      }

      if (line.startsWith("/model")) {
        const arg = line.slice(6).trim();
        if (!arg || arg.toLowerCase() === "status") {
          const current = store.getSessionModelOverride(session.id);
          output.write(`Model override: ${current || "(default)"}\n`);
          continue;
        }
        if (arg.toLowerCase() === "clear") {
          store.setSessionModelOverride(session.id, "");
          output.write("Model override: (default)\n");
          continue;
        }
        const saved = store.setSessionModelOverride(session.id, arg);
        output.write(`Model override: ${saved}\n`);
        continue;
      }

      if (line.startsWith("/reason")) {
        const arg = line.split(" ").filter(Boolean)[1]?.toLowerCase() ?? "status";
        if (arg === "status") {
          output.write(`Reasoning effort: ${store.getReasoningEffort(session.id).toUpperCase()}\n`);
          continue;
        }
        if (arg === "none" || arg === "low" || arg === "medium" || arg === "high") {
          const next = store.setReasoningEffort(session.id, arg);
          output.write(`Reasoning effort: ${next.toUpperCase()}\n`);
          continue;
        }
        output.write("Usage: /reason <none|low|medium|high|status>\n");
        continue;
      }

      if (line.startsWith("/pwd")) {
        output.write(`Workdir: ${getEffectiveSessionWorkdir(store, session.id, config.codexWorkdir)}\n`);
        continue;
      }

      if (line.startsWith("/ls")) {
        const target = getEffectiveSessionWorkdir(store, session.id, config.codexWorkdir);
        try {
          output.write([target, "", await formatDirectoryListing(target)].join("\n") + "\n");
        } catch (err) {
          output.write(`${err instanceof Error ? err.message : String(err)}\n`);
        }
        continue;
      }

      if (line.startsWith("/cd")) {
        const arg = line.slice(3).trim();
        if (!arg) {
          output.write("Usage: /cd <path|..>\n");
          continue;
        }
        try {
          const next = await resolveSessionCdTarget(getEffectiveSessionWorkdir(store, session.id, config.codexWorkdir), arg);
          await assertDirectoryExists(next);
          store.setSessionWorkdirOverride(session.id, next);
          output.write(`Workdir: ${next}\n`);
        } catch (err) {
          output.write(`${err instanceof Error ? err.message : String(err)}\n`);
        }
        continue;
      }

      if (line.startsWith("/workdir")) {
        const arg = line.slice(8).trim();
        if (!arg || arg.toLowerCase() === "status") {
          output.write(`Workdir: ${getEffectiveSessionWorkdir(store, session.id, config.codexWorkdir)}\n`);
          continue;
        }
        if (arg.toLowerCase() === "clear") {
          store.setSessionWorkdirOverride(session.id, "");
          output.write(`Workdir: ${config.codexWorkdir}\n`);
          continue;
        }
        const saved = store.setSessionWorkdirOverride(session.id, path.resolve(arg));
        output.write(`Workdir: ${saved}\n`);
        continue;
      }

      if (line.startsWith("/models")) {
        const target = line.slice(7).trim().toLowerCase() || "current";
        const provider = resolveRunnerForSession(session, config, resolved.command, geminiRunner, claudeRunner).provider;

        if (target === "all") {
          output.write(`${formatAllModelCatalogs()}\n`);
          continue;
        }
        if (target === "current") {
          output.write([`Current provider: ${provider}`, formatModelCatalog(provider), "Usage: /model <name>"].join("\n") + "\n");
          continue;
        }
        if (hasModelCatalog(target)) {
          output.write(`${formatModelCatalog(target)}\n`);
          continue;
        }

        output.write("Usage: /models [current|all|codex|gemini|claude]\n");
        continue;
      }

      if (line.startsWith("/slot")) {
        const parts = line.split(" ").filter(Boolean);
        const sub = (parts[1] ?? "list").toLowerCase();

        if (sub === "list") {
          const rows = store.listSlotBindings(parsed.chatId);
          if (!rows.length) {
            output.write("No slots found.\n");
          } else {
            output.write(rows.map((r) => `${r.slotId} | session=${r.sessionId} | provider=${r.provider} | thread=${r.threadId ?? "-"}`).join("\n") + "\n");
          }
          continue;
        }

        if (sub === "show") {
          const slot = (parts[2] ?? "").toUpperCase();
          if (!slot) {
            output.write("Usage: /slot show <A-Z>\n");
            continue;
          }
          const id = store.resolveSessionId(slot, parsed.chatId);
          if (!id) {
            output.write(`No session in slot ${slot}\n`);
            continue;
          }
          const target = store.getSession(id);
          if (!target) {
            output.write(`No session in slot ${slot}\n`);
            continue;
          }
          output.write(`${sessionSummary(target)}\nProvider: ${target.provider}\nThread: ${target.threadId ?? "-"}\n`);
          continue;
        }

        if (sub === "bind") {
          const slot = (parts[2] ?? "").toUpperCase();
          const threadId = parts[3] ?? "";
          const providerInput = (parts[4] ?? "codex").toLowerCase();
          const isValidProvider = providerInput === "codex" || providerInput === "gemini" || providerInput === "claude";
          if (!slot || !threadId || !isValidProvider) {
            output.write("Usage: /slot bind <A-Z> <thread_id> [codex|gemini|claude]\n");
            continue;
          }
          try {
            const bound = store.bindSessionThread(parsed.chatId, slot, providerInput, threadId);
            output.write(`Bound ${bound.shortId} -> provider=${bound.provider}, thread=${bound.threadId ?? "-"}\nSession Name: ${bound.id}\n`);
          } catch (err) {
            output.write(`${String(err)}\n`);
          }
          continue;
        }

        output.write("Usage: /slot <list|show|bind>\n");
        continue;
      }

      await runPrompt(line, parsed.chatId, session, store, interactionLogger, resolved.command, geminiRunner, claudeRunner);
      const refreshed = store.getSession(session.id);
      if (refreshed) {
        session = refreshed;
      }
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  void startCliChat();
}




