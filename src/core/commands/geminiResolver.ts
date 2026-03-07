import path from "node:path";
import { fileExists, findNewestExecutableInVsCodeExtensions, isPathLike, runWhere } from "./commandResolver";

function defaultNpmGeminiShim(): string | null {
  const appData = process.env.APPDATA ?? "";
  if (!appData) {
    return null;
  }
  return path.join(appData, "npm", "gemini.cmd");
}

async function findGeminiFromVsCodeExtensions(): Promise<string | null> {
  return findNewestExecutableInVsCodeExtensions({
    prefix: "google.gemini-cli-",
    suffix: "-win32-x64",
    relativeExecutablePath: ["bin", "windows-x86_64", "gemini.exe"]
  });
}

function mergeScriptPrefix(argsTemplate: string, scriptPath: string): string {
  const quoted = scriptPath.includes(" ") ? `"${scriptPath}"` : scriptPath;
  const trimmed = argsTemplate.trim();
  if (!trimmed) {
    return quoted;
  }
  if (trimmed.startsWith(quoted)) {
    return trimmed;
  }
  return `${quoted} ${trimmed}`;
}

async function convertGeminiShim(commandPath: string, argsTemplate: string): Promise<{ command: string; argsTemplate: string } | null> {
  const ext = path.extname(commandPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return null;
  }

  const dp0 = path.dirname(commandPath);
  const scriptPath = path.join(dp0, "node_modules", "@google", "gemini-cli", "dist", "index.js");
  if (!(await fileExists(scriptPath))) {
    return null;
  }

  const nodeFromWhere = await runWhere("node");
  return {
    command: nodeFromWhere ?? "node",
    argsTemplate: mergeScriptPrefix(argsTemplate, scriptPath)
  };
}

export async function resolveGeminiRunner(
  inputCommand: string,
  inputArgsTemplate: string
): Promise<{ command: string; argsTemplate: string; source: string }> {
  const preferred = inputCommand.trim();

  const tryNormalize = async (command: string, source: string): Promise<{ command: string; argsTemplate: string; source: string }> => {
    const normalized = await convertGeminiShim(command, inputArgsTemplate);
    if (normalized) {
      return { ...normalized, source: `${source}-shim` };
    }
    return { command, argsTemplate: inputArgsTemplate, source };
  };

  if (preferred && preferred !== "auto") {
    if (isPathLike(preferred)) {
      const absolute = path.isAbsolute(preferred) ? preferred : path.resolve(preferred);
      if (!(await fileExists(absolute))) {
        throw new Error(`Configured GEMINI_COMMAND path does not exist: ${absolute}`);
      }
      return tryNormalize(absolute, "env-path");
    }

    const located = await runWhere(preferred);
    if (located) {
      return tryNormalize(located, "env-where");
    }
  }

  const fromWhere = await runWhere("gemini");
  if (fromWhere) {
    return tryNormalize(fromWhere, "where");
  }

  const fromVsCode = await findGeminiFromVsCodeExtensions();
  if (fromVsCode) {
    return { command: fromVsCode, argsTemplate: inputArgsTemplate, source: "vscode-extension" };
  }

  const npmShim = defaultNpmGeminiShim();
  if (npmShim && (await fileExists(npmShim))) {
    return tryNormalize(npmShim, "npm-shim-default");
  }

  throw new Error("Could not locate gemini executable. Set GEMINI_COMMAND to an absolute path or install @google/gemini-cli.");
}
