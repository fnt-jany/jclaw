import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\") || command.endsWith(".exe");
}

async function runWhere(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("where.exe", [command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });

    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const firstLine = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(firstLine ?? null);
    });
  });
}

async function findFromVsCodeExtensions(): Promise<string | null> {
  const base = path.join(process.env.USERPROFILE ?? "", ".vscode", "extensions");
  if (!(await fileExists(base))) {
    return null;
  }

  const dirs = await readdir(base, { withFileTypes: true });
  const matches = dirs
    .filter((d) => d.isDirectory() && d.name.startsWith("openai.chatgpt-") && d.name.endsWith("-win32-x64"))
    .map((d) => path.join(base, d.name, "bin", "windows-x86_64", "codex.exe"));

  const existing: Array<{ candidate: string; mtimeMs: number }> = [];
  for (const candidate of matches) {
    if (!(await fileExists(candidate))) {
      continue;
    }

    try {
      const info = await stat(candidate);
      existing.push({ candidate, mtimeMs: info.mtimeMs });
    } catch {
      existing.push({ candidate, mtimeMs: 0 });
    }
  }

  if (existing.length === 0) {
    return null;
  }

  existing.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return existing[0].candidate;
}

export async function resolveCodexCommand(input: string): Promise<{ command: string; source: string }> {
  const preferred = input.trim();

  if (preferred && preferred !== "auto") {
    if (isPathLike(preferred)) {
      const absolute = path.isAbsolute(preferred) ? preferred : path.resolve(preferred);
      if (await fileExists(absolute)) {
        return { command: absolute, source: "env-path" };
      }
      throw new Error(`Configured CODEX_COMMAND path does not exist: ${absolute}`);
    }

    const located = await runWhere(preferred);
    if (located) {
      return { command: located, source: "where" };
    }
  }

  const fromWhere = await runWhere("codex");
  if (fromWhere) {
    return { command: fromWhere, source: "where" };
  }

  const fromVsCode = await findFromVsCodeExtensions();
  if (fromVsCode) {
    return { command: fromVsCode, source: "vscode-extension" };
  }

  throw new Error(
    "Could not locate codex executable. Set CODEX_COMMAND to an absolute codex.exe path in .env."
  );
}
