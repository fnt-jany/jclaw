import path from "node:path";
import { fileExists, findNewestExecutableInVsCodeExtensions, isPathLike, runWhere } from "./commandResolver";

async function findFromVsCodeExtensions(): Promise<string | null> {
  return findNewestExecutableInVsCodeExtensions({
    prefix: "openai.chatgpt-",
    suffix: "-win32-x64",
    relativeExecutablePath: ["bin", "windows-x86_64", "codex.exe"]
  });
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

  throw new Error("Could not locate codex executable. Set CODEX_COMMAND to an absolute codex.exe path in .env.");
}
