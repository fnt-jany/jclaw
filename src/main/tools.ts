import dotenv from "dotenv";
import path from "node:path";
import { loadConfig } from "../core/config/env";
import { SessionStore } from "../core/session/sessionStore";
import { SlotBindingService } from "../core/tools/slotBindingService";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);

function parseArg(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx < 0) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function usage(): void {
  console.log([
    "Usage:",
    "  npm run ops:slots -- list --chat <chat_id>",
    "  npm run ops:slots -- bind --chat <chat_id> --slot <A-Z> --thread <thread_id> [--provider <provider>]",
    "  npm run ops:slots -- export --chat <chat_id> [--out data/manual-slot-bindings.json]",
    "  npm run ops:slots -- import --file data/manual-slot-bindings.json [--chat <chat_id>]"
  ].join("\n"));
}

function defaultChatId(): string {
  return Array.from(config.allowedChatIds)[0] ?? "windows-cli";
}

async function runSlots(args: string[]): Promise<void> {
  const cmd = (args[0] ?? "list").toLowerCase();

  const store = new SessionStore(config.dbFile);
  await store.init();
  const service = new SlotBindingService(store);

  if (cmd === "list") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const rows = service.list(chatId);
    if (!rows.length) {
      console.log("No slots found.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.slotId} | session=${row.sessionId} | provider=${row.provider} | thread=${row.threadId ?? "-"}`);
    }
    return;
  }

  if (cmd === "bind") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const slot = (parseArg(args, "--slot") ?? "").toUpperCase();
    const threadId = parseArg(args, "--thread") ?? parseArg(args, "--codex");
    const providerInput = (parseArg(args, "--provider") ?? "codex").toLowerCase();

    if (!slot || !threadId || !providerInput) {
      usage();
      process.exit(1);
      return;
    }

    const session = service.bind(chatId, slot, providerInput, threadId);
    console.log(`Bound slot ${session.shortId} -> provider=${session.provider}, thread=${session.threadId ?? "-"}`);
    console.log(`session=${session.id}`);
    return;
  }

  if (cmd === "export") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const outFile = parseArg(args, "--out") ?? path.join(dataDir, "manual-slot-bindings.json");
    const result = await service.exportToFile(chatId, outFile);
    console.log(`Exported ${result.count} bindings -> ${result.filePath}`);
    return;
  }

  if (cmd === "import") {
    const file = parseArg(args, "--file") ?? path.join(dataDir, "manual-slot-bindings.json");
    const overrideChatId = parseArg(args, "--chat") ?? undefined;
    const result = await service.importFromFile(file, overrideChatId);
    console.log(`Imported ${result.applied} bindings for chat=${result.chatId}`);
    return;
  }

  usage();
  process.exit(1);
}

async function main(): Promise<void> {
  const sub = (process.argv[2] ?? "slots").toLowerCase();
  const args = process.argv.slice(3);

  if (sub === "slots") {
    await runSlots(args);
    return;
  }

  usage();
  process.exit(1);
}

void main();
