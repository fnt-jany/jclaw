import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

async function shouldDelete(filePath: string, fileName: string, sessionId: string): Promise<boolean> {
  if (fileName.includes(sessionId) || fileName.includes(sessionId.slice(0, 8))) {
    return true;
  }

  if (!fileName.toLowerCase().endsWith(".json")) {
    return false;
  }

  try {
    const info = await stat(filePath);
    if (info.size <= 0 || info.size > 5 * 1024 * 1024) {
      return false;
    }
    const content = await readFile(filePath, "utf8");
    return content.includes(sessionId);
  } catch {
    return false;
  }
}

async function walkAndDelete(root: string, sessionId: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkAndDelete(fullPath, sessionId).catch(() => undefined);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (await shouldDelete(fullPath, entry.name, sessionId)) {
      await unlink(fullPath).catch(() => undefined);
    }
  }
}

export async function deleteGeminiSessionFiles(sessionId: string): Promise<void> {
  if (!sessionId) {
    return;
  }

  const userProfile = process.env.USERPROFILE ?? "";
  if (!userProfile) {
    return;
  }

  const root = path.join(userProfile, ".gemini");
  await walkAndDelete(root, sessionId).catch(() => undefined);
}
