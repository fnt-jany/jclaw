import path from "node:path";
import { fileExists, findNewestExecutableInVsCodeExtensions, isPathLike, runWhere } from "./commandResolver";

function defaultNpmClaudeShim(): string | null {
  const appData = process.env.APPDATA ?? "";
  if (!appData) {
    return null;
  }
  return path.join(appData, "npm", "claude.cmd");
}

async function findClaudeFromVsCodeExtensions(): Promise<string | null> {
  return findNewestExecutableInVsCodeExtensions({
    prefix: "anthropic.claude-code-",
    suffix: "-win32-x64",
    relativeExecutablePath: ["bin", "windows-x86_64", "claude.exe"]
  });
}

export async function resolveClaudeRunner(
  inputCommand: string,
  inputArgsTemplate: string
): Promise<{ command: string; argsTemplate: string; source: string }> {
  const preferred = inputCommand.trim();

  if (preferred && preferred !== "auto") {
    if (isPathLike(preferred)) {
      const absolute = path.isAbsolute(preferred) ? preferred : path.resolve(preferred);
      if (!(await fileExists(absolute))) {
        throw new Error(`Configured CLAUDE_COMMAND path does not exist: ${absolute}`);
      }
      return { command: absolute, argsTemplate: inputArgsTemplate, source: "env-path" };
    }

    const located = await runWhere(preferred);
    if (located) {
      return { command: located, argsTemplate: inputArgsTemplate, source: "env-where" };
    }

    return { command: preferred, argsTemplate: inputArgsTemplate, source: "env-literal" };
  }

  const fromWhere = await runWhere("claude");
  if (fromWhere) {
    return { command: fromWhere, argsTemplate: inputArgsTemplate, source: "where" };
  }

  const fromVsCode = await findClaudeFromVsCodeExtensions();
  if (fromVsCode) {
    return { command: fromVsCode, argsTemplate: inputArgsTemplate, source: "vscode-extension" };
  }

  const npmShim = defaultNpmClaudeShim();
  if (npmShim && (await fileExists(npmShim))) {
    return { command: npmShim, argsTemplate: inputArgsTemplate, source: "npm-shim-default" };
  }

  // Keep startup resilient even if Claude CLI is not installed yet.
  return { command: "claude", argsTemplate: inputArgsTemplate, source: "default-literal" };
}
