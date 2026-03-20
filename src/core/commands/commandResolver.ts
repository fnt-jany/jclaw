import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\") || /\.[a-z0-9]+$/i.test(command);
}

export async function runWhere(command: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";

  return new Promise((resolve) => {
    const child = spawn(locator, [command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });

    child.on("error", () => resolve(null));
    child.on("close", async (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const firstLine = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (!firstLine) {
        resolve(null);
        return;
      }

      if (process.platform !== "win32") {
        resolve(firstLine);
        return;
      }

      // where.exe can return extension-less shim names; normalize to real executable script where possible.
      const ext = path.extname(firstLine).toLowerCase();
      if (!ext) {
        const cmdPath = `${firstLine}.cmd`;
        if (await fileExists(cmdPath)) {
          resolve(cmdPath);
          return;
        }

        const exePath = `${firstLine}.exe`;
        if (await fileExists(exePath)) {
          resolve(exePath);
          return;
        }
      }

      resolve(firstLine);
    });
  });
}

export async function findNewestExecutableInVsCodeExtensions(options: {
  prefix: string;
  suffix: string;
  relativeExecutablePath: string[];
}): Promise<string | null> {
  const base = path.join(process.env.USERPROFILE ?? "", ".vscode", "extensions");
  if (!(await fileExists(base))) {
    return null;
  }

  const dirs = await readdir(base, { withFileTypes: true });
  const candidates = dirs
    .filter((d) => d.isDirectory() && d.name.startsWith(options.prefix) && d.name.endsWith(options.suffix))
    .map((d) => path.join(base, d.name, ...options.relativeExecutablePath));

  const existing: Array<{ candidate: string; mtimeMs: number }> = [];
  for (const candidate of candidates) {
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

  if (!existing.length) {
    return null;
  }

  existing.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return existing[0].candidate;
}

