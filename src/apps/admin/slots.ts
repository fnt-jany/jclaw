import dotenv from "dotenv";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../../core/config/env";
import { SessionStore } from "../../core/session/sessionStore";
import { SLOT_IDS, type SlotId } from "../../shared/constants";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);

type BindingRow = {
  slotId: SlotId;
  codexSessionId: string;
  sessionId?: string;
};

type BindingFile = {
  chatId: string;
  bindings: BindingRow[];
};

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
    "  npm run admin:slots -- list --chat <chat_id>",
    "  npm run admin:slots -- bind --chat <chat_id> --slot <A-Z> --codex <codex_session_id>",
    "  npm run admin:slots -- export --chat <chat_id> [--out data/manual-slot-bindings.json]",
    "  npm run admin:slots -- import --file data/manual-slot-bindings.json [--chat <chat_id>]"
  ].join("\n"));
}

function defaultChatId(): string {
  return Array.from(config.allowedChatIds)[0] ?? "windows-cli";
}

export async function startAdminSlots(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "list").toLowerCase();

  const store = new SessionStore(config.dbFile);
  await store.init();

  if (cmd === "list") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const rows = store.listSlotBindings(chatId);
    if (!rows.length) {
      console.log("No slots found.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.slotId} | session=${row.sessionId} | codex=${row.codexSessionId ?? "-"}`);
    }
    return;
  }

  if (cmd === "bind") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const slot = (parseArg(args, "--slot") ?? "").toUpperCase();
    const codex = parseArg(args, "--codex");
    if (!slot || !codex) {
      usage();
      process.exit(1);
      return;
    }
    if (!SLOT_IDS.includes(slot as SlotId)) {
      throw new Error(`Invalid slot id: ${slot}`);
    }

    const session = store.bindCodexSession(chatId, slot, codex);
    console.log(`Bound slot ${session.shortId} -> ${session.codexSessionId}`);
    console.log(`session=${session.id}`);
    return;
  }

  if (cmd === "export") {
    const chatId = parseArg(args, "--chat") ?? defaultChatId();
    const outFile = parseArg(args, "--out") ?? path.join(dataDir, "manual-slot-bindings.json");
    const bindings = store
      .listSlotBindings(chatId)
      .filter((row) => row.codexSessionId)
      .map((row) => ({
        slotId: row.slotId,
        codexSessionId: row.codexSessionId as string,
        sessionId: row.sessionId
      }));

    const payload: BindingFile = { chatId, bindings };
    await writeFile(path.resolve(outFile), JSON.stringify(payload, null, 2), "utf8");
    console.log(`Exported ${bindings.length} bindings -> ${path.resolve(outFile)}`);
    return;
  }

  if (cmd === "import") {
    const file = parseArg(args, "--file") ?? path.join(dataDir, "manual-slot-bindings.json");
    const raw = await readFile(path.resolve(file), "utf8");
    const parsed = JSON.parse(raw) as BindingFile;
    const overrideChatId = parseArg(args, "--chat");
    const chatId = overrideChatId ?? parsed.chatId;

    if (!chatId) {
      throw new Error("Missing chat id. Provide --chat or chatId in file.");
    }

    let applied = 0;
    for (const row of parsed.bindings ?? []) {
      const slot = String(row.slotId).toUpperCase();
      if (!SLOT_IDS.includes(slot as SlotId)) {
        console.log(`skip invalid slot: ${row.slotId}`);
        continue;
      }
      if (!row.codexSessionId) {
        console.log(`skip empty codex session: ${slot}`);
        continue;
      }
      store.bindCodexSession(chatId, slot, row.codexSessionId);
      applied += 1;
    }

    console.log(`Imported ${applied} bindings for chat=${chatId}`);
    return;
  }

  usage();
  process.exit(1);
}

if (require.main === module) {
  void startAdminSlots();
}
