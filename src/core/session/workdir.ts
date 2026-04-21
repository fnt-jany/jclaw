import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { SessionStore } from "./sessionStore";

export function getEffectiveSessionWorkdir(store: SessionStore, sessionId: string, fallbackWorkdir: string): string {
  return store.getSessionWorkdirOverride(sessionId) || fallbackWorkdir;
}

async function listSubdirectories(targetPath: string): Promise<string[]> {
  const entries = await readdir(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export async function resolveSessionCdTarget(currentWorkdir: string, rawValue: string): Promise<string> {
  const value = rawValue.trim();
  if (!value) {
    return currentWorkdir;
  }
  if (value === "..") {
    return path.resolve(currentWorkdir, "..");
  }
  if (/^\d+$/.test(value)) {
    const directories = await listSubdirectories(currentWorkdir);
    const index = Number(value) - 1;
    if (index < 0 || index >= directories.length) {
      throw new Error(`Directory index out of range: ${value}`);
    }
    return path.resolve(currentWorkdir, directories[index]);
  }
  return path.resolve(currentWorkdir, value);
}

export async function assertDirectoryExists(targetPath: string): Promise<void> {
  const info = await stat(targetPath);
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }
}

export async function formatDirectoryListing(targetPath: string, limit = 50): Promise<string> {
  const names = await listSubdirectories(targetPath);

  if (names.length === 0) {
    return "(no directories)";
  }

  const visible = names.slice(0, limit).map((name, index) => `${index + 1}. ${name}`);
  if (names.length > limit) {
    visible.push(`... (${names.length - limit} more)`);
  }
  return visible.join("\n");
}
