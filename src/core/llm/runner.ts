import { execFile, spawn } from "node:child_process";
import { parseArgsStringToArgv } from "string-argv";
import type { ReasoningEffort } from "../session/sessionStore";
import type { LlmProviderId } from "./types";

export type RunLlmProcessInput = {
  codexNodeOptions: string;
  codexCommand: string;
  codexArgsTemplate: string;
  prompt: string;
  sessionId: string;
  threadId?: string | null;
  timeoutMs: number;
  workdir: string;
  reasoningEffort?: ReasoningEffort;
  provider?: LlmProviderId;
  modelOverride?: string;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  progressIntervalMs?: number;
  onProgress?: (progress: { elapsedMs: number; stdoutChars: number; stderrChars: number }) => void;
  inactivityTimeoutMs?: number;
  completionGraceMs?: number;
};

export type RunLlmProcessResult = {
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  threadId: string | null;
};

type GeminiSessionRow = {
  title: string;
  id: string;
};

const activeSessionChildren = new Map<string, Set<ReturnType<typeof spawn>>>();

function registerActiveChild(sessionId: string, child: ReturnType<typeof spawn>): void {
  const set = activeSessionChildren.get(sessionId) ?? new Set<ReturnType<typeof spawn>>();
  set.add(child);
  activeSessionChildren.set(sessionId, set);
}

function unregisterActiveChild(sessionId: string, child: ReturnType<typeof spawn>): void {
  const set = activeSessionChildren.get(sessionId);
  if (!set) {
    return;
  }
  set.delete(child);
  if (set.size === 0) {
    activeSessionChildren.delete(sessionId);
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const child = execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    child.unref();
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore already-exited processes
  }
}

export function cancelLlmRuns(sessionId: string): boolean {
  const set = activeSessionChildren.get(sessionId);
  if (!set || set.size === 0) {
    return false;
  }

  for (const child of [...set]) {
    const pid = child.pid;
    if (typeof pid === "number" && pid > 0) {
      terminateProcessTree(pid);
    } else {
      try {
        child.kill();
      } catch {
        // ignore kill errors for already-exited processes
      }
    }
  }

  return true;
}

function getDefaultCodexModel(): string {
  return (process.env.CODEX_DEFAULT_MODEL ?? "gpt-5.4").trim() || "gpt-5.4";
}

function extractCodexSessionId(stdout: string, stderr: string): string | null {
  const joined = `${stdout}\n${stderr}`;
  const match = joined.match(/session id:\s*([0-9a-f-]{16,})/i);
  return match?.[1] ?? null;
}

function parseGeminiSessions(listOutput: string): GeminiSessionRow[] {
  const rows: GeminiSessionRow[] = [];
  const lines = listOutput.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s+(.+?)\s+\([^)]*\)\s+\[([0-9a-f-]{16,})\]\s*$/i);
    if (!match) {
      continue;
    }

    rows.push({
      title: match[1],
      id: match[2]
    });
  }

  return rows;
}

function pickGeminiSessionId(listOutput: string, tag: string | null): string | null {
  const rows = parseGeminiSessions(listOutput);
  if (rows.length === 0) {
    return null;
  }

  if (tag) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].title.includes(tag)) {
        return rows[i].id;
      }
    }
  }

  return rows[rows.length - 1].id;
}

function normalizeChunkForLog(chunk: string, maxLen = 280): string {
  const singleLine = chunk.replace(/\r?\n/g, "\\n").trim();
  if (!singleLine) {
    return "(empty)";
  }
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLen)}...[+${singleLine.length - maxLen} chars]`;
}

function prependAfterCommandPrefix(args: string[], prepend: string[]): string[] {
  let idx = 0;
  while (idx < args.length && !args[idx].startsWith("-")) {
    idx += 1;
  }
  return [...args.slice(0, idx), ...prepend, ...args.slice(idx)];
}

function buildGeminiListArgs(argsTemplate: string): string[] {
  const tokens = parseArgsStringToArgv(argsTemplate);
  let idx = 0;
  while (idx < tokens.length && !tokens[idx].startsWith("-")) {
    idx += 1;
  }
  return [...tokens.slice(0, idx), "--list-sessions"];
}


function spawnLlmCommand(command: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  windowsHide: boolean;
  stdio: ["ignore" | "pipe", "pipe", "pipe"];
}): ReturnType<typeof spawn> {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command.trim())) {
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], {
      ...options,
      shell: false
    });
  }

  return spawn(command, args, {
    ...options,
    shell: false
  });
}

function hasCompletionHint(provider: LlmProviderId, chunk: string): boolean {
  return provider === "codex" && /tokens used/i.test(chunk);
}

async function captureProcessSnapshot(pid: number | undefined): Promise<string | null> {
  if (!pid || pid <= 0) {
    return null;
  }

  const script = [
    `$target = ${pid}`,
    "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine",
    "$rows = $procs | Where-Object { $_.ProcessId -eq $target -or $_.ParentProcessId -eq $target } | Sort-Object ProcessId",
    "$rows | ForEach-Object {\"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)\"}"
  ].join("; ");

  return new Promise<string | null>((resolve) => {
    let out = "";
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });

    const timer = setTimeout(() => {
      ps.kill();
      resolve(null);
    }, 2500);

    ps.stdout.on("data", (chunk) => {
      out += String(chunk);
    });

    ps.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    ps.on("close", () => {
      clearTimeout(timer);
      const trimmed = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      resolve(trimmed || null);
    });
  });
}

async function getLatestGeminiSessionId(input: RunLlmProcessInput, tag: string | null): Promise<string | null> {
  const args = buildGeminiListArgs(input.codexArgsTemplate);

  return new Promise<string | null>((resolve) => {
    let out = "";
    const child = spawnLlmCommand(input.codexCommand, args, {
      env: {
        ...process.env,
        ...(input.codexNodeOptions ? { NODE_OPTIONS: input.codexNodeOptions } : {})
      },
      cwd: input.workdir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 15000);

    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(pickGeminiSessionId(out, tag));
    });
  });
}

function buildArgs(input: RunLlmProcessInput, prompt: string): { args: string[]; stdinPrompt: string | null } {
  const provider = input.provider ?? "codex";
  const resolvedThreadId = input.threadId ?? null;
  const reasoningArgs =
    input.reasoningEffort && input.reasoningEffort !== "none"
      ? ["-c", `model_reasoning_effort=\"${input.reasoningEffort}\"`]
      : [];
  const argsString = input.codexArgsTemplate
    .replaceAll("{prompt}", prompt)
    .replaceAll("{session_id}", input.sessionId)
    .replaceAll("{codex_session_id}", resolvedThreadId ?? "")
    .replaceAll("{thread_id}", resolvedThreadId ?? "");

  const parsed = parseArgsStringToArgv(argsString);
  const modelOverride = (input.modelOverride ?? "").trim() || (provider === "codex" ? getDefaultCodexModel() : "");

  const applyModelOverride = (args: string[]): string[] => {
    if (!modelOverride) {
      return args;
    }

    if (provider === "codex") {
      if (args.includes("-m") || args.includes("--model")) {
        return args;
      }
      return ["-m", modelOverride, ...args];
    }

    if (provider === "claude" || provider === "gemini") {
      if (args.includes("-m") || args.includes("--model")) {
        return args;
      }
      return [...args, "--model", modelOverride];
    }

    return args;
  };

  const finalizeCodexArgs = (args: string[]): { args: string[]; stdinPrompt: string | null } => {
    const targetIndex = args.lastIndexOf(prompt);
    if (targetIndex < 0) {
      return { args: applyModelOverride(args), stdinPrompt: null };
    }

    const next = [...args];
    next[targetIndex] = "-";
    return { args: applyModelOverride(next), stdinPrompt: prompt };
  };

  if (provider === "gemini") {
    const hasResume = parsed.includes("--resume") || parsed.includes("-r");
    if (resolvedThreadId && !hasResume && !parsed.includes("--list-sessions") && !parsed.includes("--delete-session")) {
      return { args: applyModelOverride(prependAfterCommandPrefix(parsed, ["--resume", resolvedThreadId])), stdinPrompt: null };
    }
    return { args: applyModelOverride(parsed), stdinPrompt: null };
  }

  if (provider === "codex" && resolvedThreadId && parsed[0] === "exec" && !parsed.includes("resume")) {
    const templateTokens = parseArgsStringToArgv(input.codexArgsTemplate).slice(1);
    const options = templateTokens.filter((token) => token.startsWith("-"));
    return finalizeCodexArgs(["exec", "resume", ...options, ...reasoningArgs, resolvedThreadId, prompt]);
  }

  if (provider === "codex" && parsed[0] === "exec" && reasoningArgs.length > 0) {
    return finalizeCodexArgs([parsed[0], ...reasoningArgs, ...parsed.slice(1)]);
  }

  if (provider === "codex") {
    return finalizeCodexArgs(parsed);
  }

  return { args: applyModelOverride(parsed), stdinPrompt: null };
}

export async function runLlmProcess(input: RunLlmProcessInput): Promise<RunLlmProcessResult> {
  const started = Date.now();
  const provider = input.provider ?? "codex";
  const resolvedThreadId = input.threadId ?? null;
  const geminiLookupTag = provider === "gemini" && !resolvedThreadId ? `[JCLAW:${input.sessionId}:${started}]` : null;
  const effectivePrompt = geminiLookupTag ? `${geminiLookupTag} ${input.prompt}` : input.prompt;
  const built = buildArgs(input, effectivePrompt);
  const args = built.args;
  const stdinPrompt = built.stdinPrompt;

  return new Promise<RunLlmProcessResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastActivityAt: number | null = null;
    let lastActivityStream: "stdout" | "stderr" | null = null;
    let lastActivityChunk = "";
    let completionHintAt: number | null = null;
    const progressIntervalMs = Math.max(1000, input.progressIntervalMs ?? 15000);
    const configuredInactivityTimeoutMs = Number.parseInt(process.env.LLM_INACTIVITY_TIMEOUT_MS ?? "", 10);
    const inactivityTimeoutMs = Math.max(
      1000,
      input.inactivityTimeoutMs ??
        (Number.isFinite(configuredInactivityTimeoutMs) ? configuredInactivityTimeoutMs : 600000)
    );
    const completionGraceMs = Math.max(5000, input.completionGraceMs ?? 15000);
    const progressTimer =
      input.onProgress
        ? setInterval(() => {
            if (!settled) {
              input.onProgress?.({
                elapsedMs: Date.now() - started,
                stdoutChars: stdout.length,
                stderrChars: stderr.length
              });
            }
          }, progressIntervalMs)
        : null;

    try {
      child = spawnLlmCommand(input.codexCommand, args, {
        env: {
          ...process.env,
          ...(input.codexNodeOptions ? { NODE_OPTIONS: input.codexNodeOptions } : {})
        },
        cwd: input.workdir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      registerActiveChild(input.sessionId, child);
      child.once("close", () => unregisterActiveChild(input.sessionId, child));

      if (stdinPrompt !== null) {
        child.stdin?.write(stdinPrompt);
      }
      child.stdin?.end();
    } catch (err) {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        output: "",
        error: `Failed to execute command: ${message}`,
        exitCode: null,
        durationMs: Date.now() - started,
        threadId: null
      });
      return;
    }

    const inactivityTimer = setInterval(() => {
      if (settled) {
        return;
      }

      const now = Date.now();
      const lastAt = lastActivityAt ?? started;
      const idleMs = now - lastAt;

      if (completionHintAt && idleMs >= completionGraceMs) {
        settled = true;
        clearTimeout(timer);
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        clearInterval(inactivityTimer);
        child.kill();

        resolve({
          output: stdout,
          error: null,
          exitCode: 0,
          durationMs: Date.now() - started,
          threadId: extractCodexSessionId(stdout, stderr)
        });
        return;
      }

      if (idleMs < inactivityTimeoutMs) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      clearInterval(inactivityTimer);
      child.kill();

      void (async () => {
        const lastActivityAtIso = lastActivityAt ? new Date(lastActivityAt).toISOString() : "none";
        const lastActivityPreview = normalizeChunkForLog(lastActivityChunk);
        const proc = await captureProcessSnapshot(child.pid);
        resolve({
          output: stdout,
          error:
            `Inactivity timed out after ${inactivityTimeoutMs}ms` +
            `\nlast_activity_stream=${lastActivityStream ?? "none"}` +
            `\nlast_activity_at=${lastActivityAtIso}` +
            `\nsince_last_activity_ms=${idleMs}` +
            `\nlast_activity_chunk=${lastActivityPreview}` +
            (completionHintAt ? `\ncompletion_hint_at=${new Date(completionHintAt).toISOString()}` : "") +
            (proc ? `\nprocess_snapshot=${proc}` : "") +
            (stderr ? `\n${stderr}` : ""),
          exitCode: null,
          durationMs: Date.now() - started,
          threadId: extractCodexSessionId(stdout, stderr)
        });
      })();
    }, 1000);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        clearInterval(inactivityTimer);
        child.kill();
        const timeoutAt = Date.now();
        const sinceLastActivityMs = lastActivityAt ? timeoutAt - lastActivityAt : timeoutAt - started;

        void (async () => {
          const lastActivityAtIso = lastActivityAt ? new Date(lastActivityAt).toISOString() : "none";
          const lastActivityPreview = normalizeChunkForLog(lastActivityChunk);
          const proc = await captureProcessSnapshot(child.pid);
          resolve({
            output: stdout,
            error:
              `Timed out after ${input.timeoutMs}ms` +
              `\nlast_activity_stream=${lastActivityStream ?? "none"}` +
              `\nlast_activity_at=${lastActivityAtIso}` +
              `\nsince_last_activity_ms=${sinceLastActivityMs}` +
              `\nlast_activity_chunk=${lastActivityPreview}` +
              (completionHintAt ? `\ncompletion_hint_at=${new Date(completionHintAt).toISOString()}` : "") +
              (proc ? `\nprocess_snapshot=${proc}` : "") +
              (stderr ? `\n${stderr}` : ""),
            exitCode: null,
            durationMs: Date.now() - started,
            threadId: extractCodexSessionId(stdout, stderr)
          });
        })();
      }
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lastActivityAt = Date.now();
      lastActivityStream = "stdout";
      lastActivityChunk = text;
      if (hasCompletionHint(provider, text)) {
        completionHintAt = Date.now();
      }
      input.onStdoutChunk?.(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      lastActivityAt = Date.now();
      lastActivityStream = "stderr";
      lastActivityChunk = text;
      if (hasCompletionHint(provider, text)) {
        completionHintAt = Date.now();
      }
      input.onStderrChunk?.(text);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        clearInterval(inactivityTimer);
        resolve({
          output: stdout,
          error: `Failed to execute command: ${err.message}`,
          exitCode: null,
          durationMs: Date.now() - started,
          threadId: extractCodexSessionId(stdout, stderr)
        });
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        clearInterval(inactivityTimer);

        const trimmedStderr = stderr.trim();
        const errorText = code === 0 ? null : (trimmedStderr.length ? trimmedStderr : null);

        void (async () => {
          let sessionId = extractCodexSessionId(stdout, stderr);

          if (provider === "gemini" && code === 0) {
            if (resolvedThreadId) {
              sessionId = resolvedThreadId;
            } else {
              const created = await getLatestGeminiSessionId(input, geminiLookupTag);
              if (created) {
                sessionId = created;
              }
            }
          }

          resolve({
            output: stdout,
            error: errorText,
            exitCode: code,
            durationMs: Date.now() - started,
            threadId: sessionId
          });
        })();
      }
    });
  });
}




