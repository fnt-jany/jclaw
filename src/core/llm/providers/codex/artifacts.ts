import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

async function walkAndDelete(root: string, sessionId: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkAndDelete(fullPath, sessionId);
      continue;
    }

    if (entry.isFile() && entry.name.includes(sessionId)) {
      await unlink(fullPath).catch(() => undefined);
    }
  }
}

export async function deleteCodexSessionFiles(sessionId: string): Promise<void> {
  if (!sessionId) {
    return;
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!home) {
    return;
  }

  const root = path.join(home, ".codex", "sessions");
  await walkAndDelete(root, sessionId).catch(() => undefined);
}
