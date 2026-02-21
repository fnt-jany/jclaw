import { spawn } from "node:child_process";
import { parseArgsStringToArgv } from "string-argv";

export type RunInput = {
  codexNodeOptions: string;
  codexCommand: string;
  codexArgsTemplate: string;
  prompt: string;
  sessionId: string;
  codexSessionId: string | null;
  timeoutMs: number;
  workdir: string;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
};

export type RunResult = {
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  codexSessionId: string | null;
};

function extractCodexSessionId(stdout: string, stderr: string): string | null {
  const joined = `${stdout}\n${stderr}`;
  const match = joined.match(/session id:\s*([0-9a-f-]{16,})/i);
  return match?.[1] ?? null;
}

function buildArgs(input: RunInput): string[] {
  const argsString = input.codexArgsTemplate
    .replaceAll("{prompt}", input.prompt)
    .replaceAll("{session_id}", input.sessionId)
    .replaceAll("{codex_session_id}", input.codexSessionId ?? "");

  const parsed = parseArgsStringToArgv(argsString);

  if (input.codexSessionId && parsed[0] === "exec" && !parsed.includes("resume")) {
    // Derive resume options from the raw template so prompt text is never mistaken as an option value.
    const templateTokens = parseArgsStringToArgv(input.codexArgsTemplate).slice(1);
    const options = templateTokens.filter((token) => token.startsWith("-"));
    return ["exec", "resume", ...options, input.codexSessionId, input.prompt];
  }

  return parsed;
}


export async function runCodex(input: RunInput): Promise<RunResult> {
  const started = Date.now();
  const args = buildArgs(input);

  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    let settled = false;

    try {
      child = spawn(input.codexCommand, args, {
        env: {
          ...process.env,
          ...(input.codexNodeOptions ? { NODE_OPTIONS: input.codexNodeOptions } : {})
        },
        cwd: input.workdir,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        output: "",
        error: `Failed to execute command: ${message}`,
        exitCode: null,
        durationMs: Date.now() - started,
        codexSessionId: null
      });
      return;
    }


    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({
          output: stdout,
          error: `Timed out after ${input.timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
          exitCode: null,
          durationMs: Date.now() - started,
          codexSessionId: extractCodexSessionId(stdout, stderr)
        });
      }
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      input.onStdoutChunk?.(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      input.onStderrChunk?.(text);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          output: stdout,
          error: `Failed to execute command: ${err.message}`,
          exitCode: null,
          durationMs: Date.now() - started,
          codexSessionId: extractCodexSessionId(stdout, stderr)
        });
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);

        const trimmedStderr = stderr.trim();
        const errorText = code === 0 ? null : (trimmedStderr.length ? trimmedStderr : null);

        resolve({
          output: stdout,
          error: errorText,
          exitCode: code,
          durationMs: Date.now() - started,
          codexSessionId: extractCodexSessionId(stdout, stderr)
        });
      }
    });
  });
}



