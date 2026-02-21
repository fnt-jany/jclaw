import dotenv from "dotenv";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../../core/config/env";
import { SessionStore, Session } from "../../core/session/sessionStore";
import { runCodex } from "../../core/codex/runner";
import { resolveCodexCommand } from "../../core/commands/resolver";
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
      "/new                 Create/switch to next slot (A->Z cycle)",
      `/session <${SLOT_TARGET_HINT}>    Switch session`,
      `${LOG_COMMAND} Toggle interaction logging`,
      "/slot <list|show|bind> Manage slot-codex mapping",
      "/exit                Quit chat mode"
    ].join("\n") + "\n"
  );
}

function normalizeCommand(line: string): string {
  if (line.startsWith(":")) {
    return `/${line.slice(1)}`;
  }
  return line;
}

async function runPrompt(
  prompt: string,
  chatId: string,
  session: Session,
  store: SessionStore,
  interactionLogger: InteractionLogger,
  codexCommand: string
): Promise<void> {
  const result = await runCodex({
    codexCommand,
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

      if (line.startsWith("/slot")) {
        const parts = line.split(" ").filter(Boolean);
        const sub = (parts[1] ?? "list").toLowerCase();

        if (sub === "list") {
          const rows = store.listSlotBindings(parsed.chatId);
          if (!rows.length) {
            output.write("No slots found.\n");
          } else {
            output.write(rows.map((r) => `${r.slotId} | session=${r.sessionId} | codex=${r.codexSessionId ?? "-"}`).join("\n") + "\n");
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
          output.write(`${sessionSummary(target)}\nCodex Session: ${target.codexSessionId ?? "-"}\n`);
          continue;
        }

        if (sub === "bind") {
          const slot = (parts[2] ?? "").toUpperCase();
          const codexSessionId = parts[3] ?? "";
          if (!slot || !codexSessionId) {
            output.write("Usage: /slot bind <A-Z> <codex_session_id>\n");
            continue;
          }
          try {
            const bound = store.bindCodexSession(parsed.chatId, slot, codexSessionId);
            output.write(`Bound ${bound.shortId} -> ${bound.codexSessionId}\nSession Name: ${bound.id}\n`);
          } catch (err) {
            output.write(`${String(err)}\n`);
          }
          continue;
        }

        output.write("Usage: /slot <list|show|bind>\n");
        continue;
      }

      await runPrompt(line, parsed.chatId, session, store, interactionLogger, resolved.command);
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


