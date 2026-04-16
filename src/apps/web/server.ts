import dotenv from "dotenv";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../core/config/env";
import { SessionStore, Session } from "../../core/session/sessionStore";
import { cancelSessionRuns, runLlm } from "../../core/llm/execute";
import { resolveRunnerForSession } from "../../core/llm/router";
import { formatAllModelCatalogs, formatModelCatalog, hasModelCatalog } from "../../core/llm/modelCatalog";
import { applyPlanModePrompt } from "../../core/llm/promptMode";
import { resolveCodexCommand } from "../../core/commands/codexResolver";
import { resolveGeminiRunner } from "../../core/commands/geminiResolver";
import { resolveClaudeRunner } from "../../core/commands/claudeResolver";
import { InteractionLogger } from "../../core/logging/interactionLogger";
import { CronStore } from "../../core/cron/store";
import { buildOneShotCron } from "../../core/cron/oneshot";
import { notifyCronWorkerWake } from "../../core/cron/wakeup";
import { parseArgs } from "../../core/commands/args";
import { DEFAULT_LOCAL_CHAT_ID, LOG_COMMAND, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";
import { CommandResult, sessionSummary } from "../../shared/types";
import { ChatJobStore, ChatJobRecord } from "../../core/chat/jobStore";
import { sendTelegramTextNotification } from "../../core/telegram/notify";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const dataDir = path.dirname(config.dataFile);
const interactionLogPath = path.join(dataDir, "interactions.json");
const store = new SessionStore(config.dbFile);
const interactionLogger = new InteractionLogger(interactionLogPath);
const cronStore = new CronStore(config.dbFile);
const chatJobStore = new ChatJobStore(config.dbFile);
const sessionLocks = new Set<string>();

let codexCommandResolved = "";
let geminiRunnerResolved = { command: "", argsTemplate: "" };
let claudeRunnerResolved = { command: "", argsTemplate: "" };

const WEB_PORT = Number(process.env.JCLAW_WEB_PORT ?? "3100");
const WEB_HOST = process.env.JCLAW_WEB_HOST ?? "127.0.0.1";
const DEFAULT_WEB_SERVER_LABEL = (process.env.JCLAW_SERVER_LABEL ?? process.env.HOSTNAME ?? "local").trim() || "local";
const SERVER_THEME_IDS = ["auto", "coast", "forest", "orchid", "cobalt", "amber"] as const;
type ServerThemeId = (typeof SERVER_THEME_IDS)[number];
const DEFAULT_WEB_SERVER_THEME: ServerThemeId = "auto";
const WEB_SERVER_LABEL_PATH = path.join(dataDir, "server-label.txt");
const WEB_SERVER_THEME_PATH = path.join(dataDir, "server-theme.txt");
let webServerLabel = DEFAULT_WEB_SERVER_LABEL;
let webServerTheme: ServerThemeId = DEFAULT_WEB_SERVER_THEME;

type ChatAttachment = {
  fileName?: string;
  mimeType?: string;
  contentBase64?: string;
  uploadId?: string;
};

type PendingWebUpload = {
  id: string;
  localPath: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
};

type ChatRequest = {
  chatId?: string;
  slot?: string;
  message?: string;
  attachment?: ChatAttachment;
  attachments?: ChatAttachment[];
};

type AuthRequest = {
  idToken?: string;
  password?: string;
};

type ServerLabelUpdateRequest = {
  label?: string;
  theme?: string;
};

type CodexUpdateRequest = {
  killRunning?: boolean;
};

type WebAuthSession = {
  token: string;
  email: string;
  method: "google" | "dev";
  expiresAt: number;
};

const WEB_CHAT_ID = process.env.WEB_CHAT_ID?.trim() || defaultChatId();
const WEB_AUTH_COOKIE = "jclaw_web_auth";
const WEB_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const WEB_DEV_PASSWORD = process.env.WEB_DEV_PASSWORD ?? "3437";
const WEB_DEV_MAX_FAILED_ATTEMPTS = 3;
const WEB_GOOGLE_CLIENT_ID = (process.env.WEB_GOOGLE_CLIENT_ID ?? "").trim();
const WEB_AUTH_COOKIE_SAMESITE = (process.env.WEB_AUTH_COOKIE_SAMESITE ?? "Lax").trim();
const WEB_AUTH_COOKIE_SECURE = (process.env.WEB_AUTH_COOKIE_SECURE ?? (process.env.NODE_ENV === "production" ? "true" : "false")).trim().toLowerCase() === "true";
const WEB_ALLOWED_ORIGINS = new Set(
  (process.env.WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const WEB_UPLOAD_DIR = path.join(dataDir, "web_uploads");
const WEB_UPLOAD_MAX_FILES = Math.max(1, Number(process.env.WEB_UPLOAD_MAX_FILES ?? "50") || 50);
const WEB_UPLOAD_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.WEB_UPLOAD_MAX_BYTES ?? String(15 * 1024 * 1024)) || 15 * 1024 * 1024);
const WEB_REQUEST_MAX_BYTES = Math.max(2 * 1024 * 1024, Math.ceil(WEB_UPLOAD_MAX_BYTES * 1.5) + 16 * 1024);

const WEB_ALLOWED_EMAILS = new Set(
  (process.env.WEB_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
);
const webAuthSessions = new Map<string, WebAuthSession>();
const chatJobSubscribers = new Map<string, Set<ServerResponse>>();
const sessionEventSubscribers = new Map<string, Set<ServerResponse>>();
const pendingWebUploads = new Map<string, PendingWebUpload>();
const CHAT_JOB_MAX = Math.max(200, Number(process.env.WEB_CHAT_JOB_MAX ?? "2000") || 2000);
const CHAT_JOB_WORKERS = Math.max(1, Number(process.env.WEB_CHAT_JOB_WORKERS ?? "1") || 1);
const CHAT_SSE_HEARTBEAT_MS = Math.max(10000, Number(process.env.WEB_CHAT_SSE_HEARTBEAT_MS ?? "15000") || 15000);
const WEB_CHAT_RESUME_INCOMPLETE_JOBS = !["0", "false", "no", "off"].includes((process.env.WEB_CHAT_RESUME_INCOMPLETE_JOBS ?? "true").trim().toLowerCase());
let activeJobWorkers = 0;
let devPasswordFailedAttempts = 0;
let devPasswordLocked = false;
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

type CodexVersionSnapshot = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  error: string | null;
};

type CodexUpdateLogEntry = {
  ts: string;
  level: "info" | "error" | "success";
  message: string;
};

type CodexUpdateStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  success: boolean | null;
  currentVersion: string | null;
  latestVersion: string | null;
  error: string | null;
  logs: CodexUpdateLogEntry[];
};

let codexVersionSnapshot: CodexVersionSnapshot = {
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  checkedAt: "",
  error: null
};

let codexUpdateStatus: CodexUpdateStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  success: null,
  currentVersion: null,
  latestVersion: null,
  error: null,
  logs: []
};

let claudeVersionSnapshot: CodexVersionSnapshot = {
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  checkedAt: "",
  error: null
};

let claudeUpdateStatus: CodexUpdateStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  success: null,
  currentVersion: null,
  latestVersion: null,
  error: null,
  logs: []
};

function normalizeServerLabel(value: string): string {
  return value.trim().slice(0, 40) || DEFAULT_WEB_SERVER_LABEL;
}

function normalizeServerTheme(value: string): ServerThemeId {
  const normalized = value.trim().toLowerCase();
  return (SERVER_THEME_IDS as readonly string[]).includes(normalized) ? (normalized as ServerThemeId) : DEFAULT_WEB_SERVER_THEME;
}

function getServerLabel(): string {
  return webServerLabel;
}

function getServerTheme(): ServerThemeId {
  return webServerTheme;
}

async function loadServerLabelConfig(): Promise<void> {
  try {
    const raw = await readFile(WEB_SERVER_LABEL_PATH, "utf8");
    webServerLabel = normalizeServerLabel(raw);
  } catch {
    webServerLabel = DEFAULT_WEB_SERVER_LABEL;
  }

  try {
    const rawTheme = await readFile(WEB_SERVER_THEME_PATH, "utf8");
    webServerTheme = normalizeServerTheme(rawTheme);
  } catch {
    webServerTheme = DEFAULT_WEB_SERVER_THEME;
  }
}

async function saveServerLabelConfig(value: string, theme: string): Promise<{ serverLabel: string; serverTheme: ServerThemeId }> {
  const nextLabel = normalizeServerLabel(value);
  const nextTheme = normalizeServerTheme(theme);
  await writeFile(WEB_SERVER_LABEL_PATH, `${nextLabel}
`, "utf8");
  await writeFile(WEB_SERVER_THEME_PATH, `${nextTheme}
`, "utf8");
  webServerLabel = nextLabel;
  webServerTheme = nextTheme;
  return { serverLabel: nextLabel, serverTheme: nextTheme };
}

function pruneExpiredWebAuthSessions(): void {
  const now = Date.now();
  for (const [token, session] of webAuthSessions.entries()) {
    if (session.expiresAt <= now) {
      webAuthSessions.delete(token);
    }
  }
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const raw = req.headers.cookie ?? "";
  const out = new Map<string, string>();

  for (const pair of raw.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = decodeURIComponent(trimmed.slice(0, idx).trim());
    const value = decodeURIComponent(trimmed.slice(idx + 1).trim());
    out.set(key, value);
  }

  return out;
}

function setAuthCookie(res: ServerResponse, token: string): void {
  const sameSite = WEB_AUTH_COOKIE_SAMESITE;
  const isSecure = WEB_AUTH_COOKIE_SECURE;
  const maxAgeSeconds = Math.floor(WEB_SESSION_TTL_MS / 1000);
  const parts = [
    `${WEB_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res: ServerResponse): void {
  const sameSite = WEB_AUTH_COOKIE_SAMESITE;
  const isSecure = WEB_AUTH_COOKIE_SECURE;
  const parts = [
    `${WEB_AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0"
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getAuthSession(req: IncomingMessage): WebAuthSession | null {
  pruneExpiredWebAuthSessions();
  const token = parseCookies(req).get(WEB_AUTH_COOKIE);
  if (!token) {
    return null;
  }
  const session = webAuthSessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    webAuthSessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): WebAuthSession | null {
  const session = getAuthSession(req);
  if (!session) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  return session;
}

function createAuthSession(email: string, method: "google" | "dev"): WebAuthSession {
  const token = randomBytes(24).toString("hex");
  const session: WebAuthSession = {
    token,
    email,
    method,
    expiresAt: Date.now() + WEB_SESSION_TTL_MS
  };
  webAuthSessions.set(token, session);
  return session;
}

function isAllowedEmail(email: string): boolean {
  if (WEB_ALLOWED_EMAILS.size === 0) {
    return true;
  }
  return WEB_ALLOWED_EMAILS.has(email.toLowerCase());
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) {
    return false;
  }
  if (WEB_ALLOWED_ORIGINS.size === 0) {
    return false;
  }

  try {
    const normalized = new URL(origin).origin;
    return WEB_ALLOWED_ORIGINS.has(normalized);
  } catch {
    return false;
  }
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) {
    return true;
  }

  if (!isAllowedOrigin(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  return true;
}

async function verifyGoogleIdToken(idToken: string): Promise<string | null> {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("id_token", idToken);

  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string;
  };

  const email = (data.email ?? "").trim().toLowerCase();
  const verified = String(data.email_verified ?? "false").toLowerCase() === "true";
  if (!email || !verified) {
    return null;
  }
  if (WEB_GOOGLE_CLIENT_ID && data.aud !== WEB_GOOGLE_CLIENT_ID) {
    return null;
  }
  if (!isAllowedEmail(email)) {
    return null;
  }

  return email;
}

type CommandRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type RunningCodexProcess = {
  pid: number;
  commandLine: string;
};

function spawnLocalCommand(command: string, args: string[], options: { cwd?: string } = {}): ReturnType<typeof spawn> {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command.trim())) {
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  return spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCommandCapture(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnLocalCommand(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          fail(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
        }, options.timeoutMs)
      : null;

    const finish = (result: CommandRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

function parseSemver(text: string): string | null {
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function resetCodexUpdateStatus(latestVersion: string | null): void {
  codexUpdateStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    success: null,
    currentVersion: codexVersionSnapshot.currentVersion,
    latestVersion,
    error: null,
    logs: []
  };
}

function pushCodexUpdateLog(level: CodexUpdateLogEntry["level"], message: string): void {
  codexUpdateStatus.logs.push({
    ts: new Date().toISOString(),
    level,
    message
  });
}

async function readCodexCurrentVersion(): Promise<string | null> {
  const result = await runCommandCapture(codexCommandResolved, ["--version"], { timeoutMs: 20000 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `codex --version failed with exit ${result.exitCode}`).trim());
  }
  return parseSemver(`${result.stdout}\n${result.stderr}`);
}

async function readLatestNpmPackageVersion(packageName: string): Promise<string | null> {
  const result = await runCommandCapture(NPM_COMMAND, ["view", packageName, "version"], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `npm view failed with exit ${result.exitCode}`).trim());
  }
  return parseSemver(result.stdout) ?? result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? null;
}

async function readCodexLatestVersion(): Promise<string | null> {
  return readLatestNpmPackageVersion("@openai/codex");
}

function isGlobalNpmPermissionError(output: string): boolean {
  return /EACCES|EPERM|permission denied|access is denied/i.test(output);
}

async function runGlobalNpmInstall(packageSpec: string): Promise<CommandRunResult> {
  const primary = await runCommandCapture(NPM_COMMAND, ["install", "-g", packageSpec], { timeoutMs: 10 * 60 * 1000 });
  const primaryOutput = `${primary.stdout}
${primary.stderr}`;
  if (primary.exitCode === 0 || process.platform === "win32" || !isGlobalNpmPermissionError(primaryOutput)) {
    return primary;
  }

  const sudoAttempt = await runCommandCapture("sudo", ["-n", NPM_COMMAND, "install", "-g", packageSpec], { timeoutMs: 10 * 60 * 1000 });
  if (sudoAttempt.exitCode !== 0) {
    const combined = `${sudoAttempt.stdout}
${sudoAttempt.stderr}`.trim();
    throw new Error(combined || (primary.stderr || primary.stdout || `npm install failed with exit ${primary.exitCode}`).trim());
  }
  return sudoAttempt;
}

async function readClaudeCurrentVersion(): Promise<string | null> {
  const result = await runCommandCapture(claudeRunnerResolved.command, ["--version"], { timeoutMs: 20000 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `claude --version failed with exit ${result.exitCode}`).trim());
  }
  return parseSemver(`${result.stdout}
${result.stderr}`);
}

async function readClaudeLatestVersion(): Promise<string | null> {
  return readLatestNpmPackageVersion(CLAUDE_NPM_PACKAGE);
}

function pushClaudeUpdateLog(level: CodexUpdateLogEntry["level"], message: string): void {
  claudeUpdateStatus.logs.push({
    ts: new Date().toISOString(),
    level,
    message
  });
}

function resetClaudeUpdateStatus(latestVersion: string | null): void {
  claudeUpdateStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    success: null,
    currentVersion: claudeVersionSnapshot.currentVersion,
    latestVersion,
    error: null,
    logs: []
  };
}

async function collectClaudeVersionSnapshot(): Promise<CodexVersionSnapshot> {
  const checkedAt = new Date().toISOString();

  try {
    const [currentVersion, latestVersion] = await Promise.all([
      readClaudeCurrentVersion(),
      readClaudeLatestVersion()
    ]);

    claudeVersionSnapshot = {
      currentVersion,
      latestVersion,
      updateAvailable: Boolean(currentVersion && latestVersion && currentVersion !== latestVersion),
      checkedAt,
      error: null
    };
  } catch (err) {
    claudeVersionSnapshot = {
      currentVersion: claudeVersionSnapshot.currentVersion,
      latestVersion: claudeVersionSnapshot.latestVersion,
      updateAvailable: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  claudeUpdateStatus.currentVersion = claudeVersionSnapshot.currentVersion;
  claudeUpdateStatus.latestVersion = claudeVersionSnapshot.latestVersion;
  return claudeVersionSnapshot;
}

function parseClaudeAuthStatus(rawText: string): { loggedIn: boolean } | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { loggedIn?: boolean };
    return { loggedIn: Boolean(parsed.loggedIn) };
  } catch {
    return null;
  }
}

async function runClaudeSmokeTests(latestVersion: string): Promise<void> {
  pushClaudeUpdateLog("info", `Testing Claude ${latestVersion}: version check`);
  const versionResult = await runCommandCapture(claudeRunnerResolved.command, ["--version"], { timeoutMs: 20000 });
  if (versionResult.exitCode !== 0) {
    throw new Error((versionResult.stderr || versionResult.stdout || "claude --version failed").trim());
  }
  pushClaudeUpdateLog("success", (versionResult.stdout || versionResult.stderr).trim());

  pushClaudeUpdateLog("info", "Testing Claude auth status");
  const authResult = await runCommandCapture(claudeRunnerResolved.command, ["auth", "status"], { timeoutMs: 20000 });
  const authText = `${authResult.stdout}
${authResult.stderr}`.trim();
  const authStatus = parseClaudeAuthStatus(authText);
  if (!authStatus) {
    throw new Error(authText || "claude auth status failed");
  }
  pushClaudeUpdateLog(authStatus.loggedIn ? "success" : "info", authText);

  if (!authStatus.loggedIn) {
    pushClaudeUpdateLog("info", "Claude is not logged in; skipped print smoke test.");
    return;
  }

  pushClaudeUpdateLog("info", "Testing Claude print smoke prompt");
  const printResult = await runCommandCapture(claudeRunnerResolved.command, ["-p", "reply with ok only"], {
    cwd: config.codexWorkdir,
    timeoutMs: 120000
  });
  if (printResult.exitCode !== 0) {
    throw new Error((printResult.stderr || printResult.stdout || "claude print smoke test failed").trim());
  }
  const output = `${printResult.stdout}
${printResult.stderr}`.trim();
  pushClaudeUpdateLog("success", output || "claude print smoke test passed");
}

function startClaudeUpdate(latestVersion: string): void {
  claudeUpdateStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: null,
    currentVersion: claudeVersionSnapshot.currentVersion,
    latestVersion,
    error: null,
    logs: []
  };

  void (async () => {
    try {
      pushClaudeUpdateLog("info", `Updating Claude to ${latestVersion}`);
      const installResult = await runGlobalNpmInstall(`${CLAUDE_NPM_PACKAGE}@${latestVersion}`);
      if (installResult.exitCode !== 0) {
        throw new Error((installResult.stderr || installResult.stdout || "claude update failed").trim());
      }
      const installOutput = `${installResult.stdout}
${installResult.stderr}`.trim();
      if (installOutput) {
        pushClaudeUpdateLog("success", installOutput);
      }

      await runClaudeSmokeTests(latestVersion);
      const snapshot = await collectClaudeVersionSnapshot();
      claudeUpdateStatus.running = false;
      claudeUpdateStatus.finishedAt = new Date().toISOString();
      claudeUpdateStatus.success = true;
      claudeUpdateStatus.error = null;
      claudeUpdateStatus.currentVersion = snapshot.currentVersion;
      claudeUpdateStatus.latestVersion = snapshot.latestVersion;
      pushClaudeUpdateLog("success", `Claude update finished: ${snapshot.currentVersion ?? latestVersion}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      claudeUpdateStatus.running = false;
      claudeUpdateStatus.finishedAt = new Date().toISOString();
      claudeUpdateStatus.success = false;
      claudeUpdateStatus.error = message;
      pushClaudeUpdateLog("error", message);
    }
  })();
}

async function collectCodexVersionSnapshot(): Promise<CodexVersionSnapshot> {
  const checkedAt = new Date().toISOString();

  try {
    const [currentVersion, latestVersion] = await Promise.all([
      readCodexCurrentVersion(),
      readCodexLatestVersion()
    ]);

    codexVersionSnapshot = {
      currentVersion,
      latestVersion,
      updateAvailable: Boolean(currentVersion && latestVersion && currentVersion !== latestVersion),
      checkedAt,
      error: null
    };
  } catch (err) {
    codexVersionSnapshot = {
      currentVersion: codexVersionSnapshot.currentVersion,
      latestVersion: codexVersionSnapshot.latestVersion,
      updateAvailable: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  codexUpdateStatus.currentVersion = codexVersionSnapshot.currentVersion;
  codexUpdateStatus.latestVersion = codexVersionSnapshot.latestVersion;
  return codexVersionSnapshot;
}

async function runCodexSmokeTests(latestVersion: string): Promise<void> {
  pushCodexUpdateLog("info", `Testing codex ${latestVersion}: version check`);
  const versionResult = await runCommandCapture(codexCommandResolved, ["--version"], { timeoutMs: 20000 });
  if (versionResult.exitCode !== 0) {
    throw new Error((versionResult.stderr || versionResult.stdout || "codex --version failed").trim());
  }
  pushCodexUpdateLog("success", (versionResult.stdout || versionResult.stderr).trim());

  pushCodexUpdateLog("info", "Testing login status");
  const loginResult = await runCommandCapture(codexCommandResolved, ["login", "status"], { timeoutMs: 30000 });
  if (loginResult.exitCode !== 0) {
    throw new Error((loginResult.stderr || loginResult.stdout || "codex login status failed").trim());
  }
  pushCodexUpdateLog("success", (loginResult.stdout || loginResult.stderr).trim());

  pushCodexUpdateLog("info", "Testing codex exec smoke prompt");
  const execResult = await runCommandCapture(
    codexCommandResolved,
    ["exec", "--skip-git-repo-check", "reply with ok only"],
    { cwd: config.codexWorkdir, timeoutMs: 120000 }
  );
  if (execResult.exitCode !== 0) {
    throw new Error((execResult.stderr || execResult.stdout || "codex exec smoke test failed").trim());
  }
  const execOutput = `${execResult.stdout}\n${execResult.stderr}`.trim();
  pushCodexUpdateLog("success", execOutput || "codex exec smoke test passed");
}

function startCodexUpdate(latestVersion: string): void {
  codexUpdateStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: null,
    currentVersion: codexVersionSnapshot.currentVersion,
    latestVersion,
    error: null,
    logs: []
  };

  void (async () => {
    try {
      const runningCodex = await listRunningCodexProcesses();
      if (runningCodex.length > 0) {
        const pidList = runningCodex.map((entry) => String(entry.pid)).join(", ");
        throw new Error(`Codex update blocked because Codex is currently running (pid=${pidList}). Stop active Codex sessions and retry. Windows locks codex.exe during npm global updates.`);
      }
      pushCodexUpdateLog("info", `Updating Codex to ${latestVersion}`);
      await assertCodexUpdateSafe();
      const installResult = await runGlobalNpmInstall(`@openai/codex@${latestVersion}`);
      if (installResult.exitCode !== 0) {
        throw new Error((installResult.stderr || installResult.stdout || "codex update failed").trim());
      }
      const installOutput = `${installResult.stdout}\n${installResult.stderr}`.trim();
      if (installOutput) {
        pushCodexUpdateLog("success", installOutput);
      }

      await runCodexSmokeTests(latestVersion);
      const snapshot = await collectCodexVersionSnapshot();
      codexUpdateStatus.running = false;
      codexUpdateStatus.finishedAt = new Date().toISOString();
      codexUpdateStatus.success = true;
      codexUpdateStatus.error = null;
      codexUpdateStatus.currentVersion = snapshot.currentVersion;
      codexUpdateStatus.latestVersion = snapshot.latestVersion;
      pushCodexUpdateLog("success", `Codex update finished: ${snapshot.currentVersion ?? latestVersion}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      codexUpdateStatus.running = false;
      codexUpdateStatus.finishedAt = new Date().toISOString();
      codexUpdateStatus.success = false;
      codexUpdateStatus.error = message;
      pushCodexUpdateLog("error", message);
    }
  })();
}

function pruneChatJobs(): void {
  chatJobStore.prune(CHAT_JOB_MAX);
}

function subscribeChatJob(jobId: string, res: ServerResponse): void {
  const set = chatJobSubscribers.get(jobId) ?? new Set<ServerResponse>();
  set.add(res);
  chatJobSubscribers.set(jobId, set);

  res.on("close", () => {
    const current = chatJobSubscribers.get(jobId);
    if (!current) {
      return;
    }
    current.delete(res);
    if (current.size === 0) {
      chatJobSubscribers.delete(jobId);
    }
  });
}

function emitSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function subscribeSessionEvents(slot: string, res: ServerResponse): void {
  const key = slot.trim().toUpperCase();
  const set = sessionEventSubscribers.get(key) ?? new Set<ServerResponse>();
  set.add(res);
  sessionEventSubscribers.set(key, set);

  res.on("close", () => {
    const current = sessionEventSubscribers.get(key);
    if (!current) {
      return;
    }
    current.delete(res);
    if (current.size === 0) {
      sessionEventSubscribers.delete(key);
    }
  });
}

function notifySessionEvent(slot: string, payload: unknown): void {
  const key = slot.trim().toUpperCase();
  const subs = sessionEventSubscribers.get(key);
  if (!subs || subs.size === 0) {
    return;
  }

  for (const res of subs) {
    emitSse(res, "session-update", payload);
  }
}

function notifyChatJob(job: ChatJobRecord): void {
  const subs = chatJobSubscribers.get(job.id);
  if (!subs || subs.size === 0) {
    return;
  }

  const base = {
    id: job.id,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.result?.sessionName ?? job.sessionId,
    updatedAt: job.updatedAt
  };

  if (job.status === "completed" && job.result) {
    for (const res of subs) {
      emitSse(res, "done", {
        ...base,
        done: true,
        success: true,
        result: job.result
      });
      res.end();
    }
    chatJobSubscribers.delete(job.id);
    return;
  }

  if (job.status === "failed") {
    for (const res of subs) {
      emitSse(res, "done", {
        ...base,
        done: true,
        success: false,
        error: job.error ?? "job failed"
      });
      res.end();
    }
    chatJobSubscribers.delete(job.id);
    return;
  }

  for (const res of subs) {
    emitSse(res, "update", {
      ...base,
      done: false
    });
  }
}

function scheduleChatWorkers(): void {
  while (activeJobWorkers < CHAT_JOB_WORKERS) {
    const job = chatJobStore.claimNextPending();
    if (!job) {
      return;
    }
    activeJobWorkers += 1;
    notifyChatJob(job);

    void (async () => {
      try {
        const session = store.getSession(job.sessionId);
        if (!session) {
          const failed = chatJobStore.markFailed(job.id, `Session not found: ${job.sessionId}`);
          if (failed) {
            notifyChatJob(failed);
            pruneChatJobs();
          }
          return;
        }

        const result = await runPrompt(job.chatId, session, job.prompt);
        const completed = chatJobStore.markCompleted(job.id, result);
        if (completed) {
          notifyChatJob(completed);
          pruneChatJobs();
        }
      } catch (err) {
        const failed = chatJobStore.markFailed(job.id, String(err));
        if (failed) {
          notifyChatJob(failed);
          pruneChatJobs();
        }
      } finally {
        activeJobWorkers -= 1;
        scheduleChatWorkers();
      }
    })();
  }
}

async function listRunningCodexProcesses(): Promise<RunningCodexProcess[]> {
  if (process.platform === "win32") {
    const script = [
      "$rows = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.Name -eq 'codex.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*@openai\\codex\\bin\\codex.js*')",
      "} | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
      "if (-not $rows) { '[]' } else { $rows }"
    ].join("; ");
    const result = await runCommandCapture("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || "failed to inspect running Codex processes").trim());
    }
    const raw = result.stdout.trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as { ProcessId?: number; CommandLine?: string } | Array<{ ProcessId?: number; CommandLine?: string }>;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item) => ({ pid: Number(item.ProcessId ?? 0), commandLine: String(item.CommandLine ?? "").trim() }))
      .filter((item) => item.pid > 0);
  }

  const result = await runCommandCapture("ps", ["-A", "-o", "pid=,command="], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || "failed to inspect running Codex processes").trim());
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return { pid: Number(match[1]), commandLine: match[2] } satisfies RunningCodexProcess;
    })
    .filter((item): item is RunningCodexProcess => Boolean(item))
    .filter((item) => /\bcodex\b/.test(item.commandLine));
}

async function killRunningCodexProcesses(): Promise<number[]> {
  const running = await listRunningCodexProcesses();
  if (running.length === 0) {
    return [];
  }

  const pids = Array.from(new Set(running.map((item) => item.pid)));
  if (process.platform === "win32") {
    const script = [
      `$ids = @(${pids.join(',')})`,
      "$killed = New-Object System.Collections.Generic.List[int]",
      "foreach ($id in $ids) {",
      "  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue",
      "  if (-not $proc) { continue }",
      "  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue",
      "  $killed.Add($id)",
      "}",
      "$killed | ConvertTo-Json -Compress"
    ].join('; ');
    const result = await runCommandCapture("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || "failed to stop running Codex processes").trim());
    }
  } else {
    for (const pid of pids) {
      const result = await runCommandCapture("kill", ["-9", String(pid)], { timeoutMs: 30000 });
      const output = `${result.stdout}
${result.stderr}`;
      if (result.exitCode !== 0 && !/No such process/i.test(output)) {
        throw new Error((result.stderr || result.stdout || `failed to stop running Codex process ${pid}`).trim());
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  return pids;
}

async function listRunningCodexProcessesWithRetries(retries = 3, delayMs = 750): Promise<RunningCodexProcess[]> {
  let latest = await listRunningCodexProcesses();
  for (let attempt = 1; attempt < retries && latest.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await listRunningCodexProcesses();
  }
  return latest;
}

async function assertCodexUpdateSafe(): Promise<void> {
  const running = await listRunningCodexProcesses();
  if (running.length === 0) {
    return;
  }
  const preview = running
    .slice(0, 4)
    .map((item) => `pid=${item.pid} ${item.commandLine}`)
    .join("\n");
  throw new Error(
    [
      "Codex update is blocked because Codex is currently running on this PC.",
      "Stop active Codex sessions and retry.",
      `Running Codex processes: ${running.length}`,
      preview
    ].join("\n")
  );
}


function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeCommand(line: string): string {
  if (line.startsWith(":")) {
    return `/${line.slice(1)}`;
  }
  return line;
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "text/plain") return ".txt";
  return "";
}

async function pruneWebUploads(maxFiles: number): Promise<void> {
  await mkdir(WEB_UPLOAD_DIR, { recursive: true });
  const entries = await readdir(WEB_UPLOAD_DIR, { withFileTypes: true });
  const files: Array<{ fullPath: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.resolve(WEB_UPLOAD_DIR, entry.name);
    const info = await stat(fullPath);
    files.push({ fullPath, mtimeMs: info.mtimeMs });
  }

  if (files.length < maxFiles) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const removeCount = files.length - maxFiles + 1;
  for (let i = 0; i < removeCount; i += 1) {
    await unlink(files[i].fullPath).catch(() => {
      // ignore stale file errors
    });
  }
}


function createPendingUploadId(): string {
  return `wu_${randomBytes(6).toString('hex')}`;
}

function registerPendingWebUpload(localPath: string, attachment: ChatAttachment): PendingWebUpload {
  const upload: PendingWebUpload = {
    id: createPendingUploadId(),
    localPath,
    fileName: String(attachment.fileName ?? path.basename(localPath)).trim() || path.basename(localPath),
    mimeType: String(attachment.mimeType ?? '').trim() || 'application/octet-stream',
    createdAt: new Date().toISOString()
  };
  pendingWebUploads.set(upload.id, upload);
  return upload;
}

function resolvePendingWebUploads(uploadIds: string[]): PendingWebUpload[] {
  const resolved: PendingWebUpload[] = [];
  for (const uploadId of uploadIds) {
    const upload = pendingWebUploads.get(uploadId);
    if (!upload) {
      throw new Error(`upload not found: ${uploadId}`);
    }
    resolved.push(upload);
  }
  return resolved;
}

async function deletePendingWebUpload(uploadId: string): Promise<void> {
  const upload = pendingWebUploads.get(uploadId);
  if (!upload) {
    return;
  }
  pendingWebUploads.delete(uploadId);
  await unlink(upload.localPath).catch(() => {
    // ignore stale file errors
  });
}

function clearPendingWebUploads(uploadIds: string[]): void {
  for (const uploadId of uploadIds) {
    pendingWebUploads.delete(uploadId);
  }
}

async function saveWebAttachment(attachment: ChatAttachment): Promise<string> {
  const contentBase64 = (attachment.contentBase64 ?? "").trim();
  if (!contentBase64) {
    throw new Error("attachment.contentBase64 is required");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length) {
    throw new Error("attachment is empty");
  }
  if (bytes.length > WEB_UPLOAD_MAX_BYTES) {
    throw new Error(`attachment too large (max ${WEB_UPLOAD_MAX_BYTES} bytes)`);
  }

  const mimeType = (attachment.mimeType ?? "").trim().toLowerCase();
  const extFromName = path.extname(attachment.fileName ?? "");
  const ext = sanitizeFilenamePart((extFromName || extensionFromMimeType(mimeType) || ".bin").toLowerCase()) || ".bin";

  await pruneWebUploads(WEB_UPLOAD_MAX_FILES);

  const fileName = `web_${Date.now()}_${Math.floor(Math.random() * 100000)}${ext}`;
  const localPath = path.resolve(WEB_UPLOAD_DIR, fileName);
  await writeFile(localPath, bytes);
  return localPath;
}

function formatResult(output: string, error: string | null, maxChars: number): string {
  const merged = [output.trim(), error ? `ERR:\n${error}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!merged) {
    return "(no output)";
  }

  if (merged.length <= maxChars) {
    return merged;
  }

  return `${merged.slice(0, maxChars)}\n\n[truncated ${merged.length - maxChars} chars]`;
}

async function handleApiUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  let payload: ChatAttachment;
  try {
    payload = JSON.parse(await readBody(req)) as ChatAttachment;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  try {
    const localPath = await saveWebAttachment(payload);
    const upload = registerPendingWebUpload(localPath, payload);
    const sizeBytes = (await stat(localPath)).size;
    json(res, 200, {
      uploadId: upload.id,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes
    });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
}

async function handleApiUploadDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  let payload: { uploadId?: string };
  try {
    payload = JSON.parse(await readBody(req)) as { uploadId?: string };
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const uploadId = String(payload.uploadId ?? '').trim();
  if (!uploadId) {
    json(res, 400, { error: 'uploadId is required' });
    return;
  }

  await deletePendingWebUpload(uploadId);
  json(res, 200, { ok: true });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
      if (data.length > WEB_REQUEST_MAX_BYTES) {
        reject(new Error(`Body too large (max ${WEB_REQUEST_MAX_BYTES} bytes)`));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function defaultChatId(): string {
  return Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
}

function ensureAllowed(chatId: string): boolean {
  return config.allowedChatIds.size === 0 || config.allowedChatIds.has(chatId);
}

function getSessionNick(session: Session): string {
  return store.getSessionNickname(session.id);
}

function buildSlotNickMap(chatId: string): Record<string, string> {
  const rows = store.listSlotBindings(chatId);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const nick = store.getSessionNickname(row.sessionId).trim();
    if (nick) {
      out[row.slotId] = nick;
    }
  }
  return out;
}

const KST_TIME_ZONE = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function parseKstDateRange(fromDateRaw: string, toDateRaw: string): { fromDate: string; toDate: string; startIso: string; endIsoExclusive: string } {
  const fromDate = fromDateRaw.trim();
  const toDate = toDateRaw.trim();
  const pattern = /^\d{4}-\d{2}-\d{2}$/;

  if (!pattern.test(fromDate) || !pattern.test(toDate)) {
    throw new Error("fromDate and toDate must use YYYY-MM-DD.");
  }

  const startIso = kstDateStartToIso(fromDate);
  const endStartIso = kstDateStartToIso(toDate);
  const startMs = Date.parse(startIso);
  const endStartMs = Date.parse(endStartIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endStartMs)) {
    throw new Error("Invalid date range.");
  }
  if (endStartMs < startMs) {
    throw new Error("toDate must be the same as or after fromDate.");
  }

  return {
    fromDate,
    toDate,
    startIso,
    endIsoExclusive: new Date(endStartMs + 24 * 60 * 60 * 1000).toISOString()
  };
}

function kstDateStartToIso(value: string): string {
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - KST_OFFSET_MS;
  const date = new Date(utcMs + KST_OFFSET_MS);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid date.");
  }
  return new Date(utcMs).toISOString();
}

function buildReplyWithHeaders(
  session: Session,
  interactionId: number | null,
  result: { exitCode: number | null; durationMs: number },
  body: string
): string {
  if (!interactionLogger.isEnabled()) {
    return body;
  }

  const lines: string[] = [];
  if (interactionId !== null) {
    lines.push(`Req#: ${interactionId}`);
  }
  lines.push(sessionSummary(session));
  if ((result.exitCode ?? 0) !== 0) {
    lines.push(`Exit: ${result.exitCode ?? "null"}`);
  }
  if (result.durationMs > 20000) {
    lines.push(`Time: ${result.durationMs}ms`);
  }
  return `${lines.join("\n")}\n\n${body}`;
}

function getState(chatId: string): { session: Session; logEnabled: boolean } {
  const session = store.getOrCreateSessionByChat(chatId, "web");
  return { session, logEnabled: interactionLogger.isEnabled() };
}

async function handleCronCommand(chatId: string, cmdLine: string, session: Session): Promise<CommandResult> {
  await cronStore.reload();

  const rest = cmdLine.replace(/^\/cron\s*/, "").trim();
  if (!rest || rest === "help") {
    return {
      reply: [
        "Usage:",
        "/cron list",
        '/cron add --session A --cron "*/5 * * * *" --prompt "status report" [--tz Asia/Seoul]',
        '/cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "one shot"',
        "/cron remove <job_id>",
        "/cron enable <job_id>",
        "/cron disable <job_id>"
      ].join("\n"),
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const parsed = parseArgs(rest);
  const sub = parsed.positional[0]?.toLowerCase();

  if (sub === "list") {
    const jobs = cronStore.list().filter((j) => j.chatId === chatId);
    return {
      reply: jobs.length
        ? jobs
            .map(
              (j) =>
                `${j.id} | ${j.enabled ? "on" : "off"}${j.runOnce ? " | once" : ""} | session=${j.sessionTarget} | cron=${j.cron}` +
                `${j.timezone ? ` tz=${j.timezone}` : ""} | next=${j.nextRunAt} | last=${j.lastRunAt ?? "-"} | status=${j.lastStatus ?? "-"}`
            )
            .join("\n")
        : TEXT.noCronJobs,
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      logEnabled: interactionLogger.isEnabled()
    };
  }


  if (sub === "once") {
    const sessionTarget = parsed.flags.session;
    const at = parsed.flags.at;
    const prompt = parsed.flags.prompt;

    if (!sessionTarget || !at || !prompt) {
      return {
        reply: 'Missing --session, --at or --prompt. Example: /cron once --session A --at "2026-02-21T16:00:00+09:00" --prompt "status report"',
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: getSessionNick(session),
        logEnabled: interactionLogger.isEnabled()
      };
    }

    store.ensureSessionForTarget(chatId, sessionTarget);

    const oneShot = buildOneShotCron(at);
    const job = await cronStore.create({
      chatId,
      sessionTarget,
      cron: oneShot.cron,
      prompt,
      timezone: null,
      runOnce: true
    });

    return {
      reply: `Created one-shot ${job.id}
runAt=${oneShot.runAt.toISOString()}
next=${job.nextRunAt}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (sub === "add") {
    const sessionTarget = parsed.flags.session;
    const cron = parsed.flags.cron;
    const prompt = parsed.flags.prompt;
    const timezone = parsed.flags.tz ?? null;

    if (!sessionTarget || !cron || !prompt) {
      return {
        reply: 'Missing --session, --cron or --prompt. Example: /cron add --session A --cron "*/5 * * * *" --prompt "status report"',
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: getSessionNick(session),
        logEnabled: interactionLogger.isEnabled()
      };
    }

    store.ensureSessionForTarget(chatId, sessionTarget);

    const job = await cronStore.create({ chatId, sessionTarget, cron, prompt, timezone });
    try {
      await notifyCronWorkerWake(`web cron add ${job.id}`);
    } catch (err) {
      await cronStore.remove(job.id);
      throw new Error(`Cron worker wake failed: ${String(err)}`);
    }
    return {
      reply: `Created ${job.id}\nnext=${job.nextRunAt}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const id = parsed.positional[1];
  if (!id) {
    return {
      reply: "Missing job id.",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  const existing = cronStore.get(id);
  if (!existing) {
    return {
      reply: `Not found: ${id}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }
  if (existing.chatId !== chatId) {
    return {
      reply: "Access denied for this job.",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (sub === "remove") {
    await cronStore.remove(id);
    return { reply: `Removed ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }
  if (sub === "enable") {
    await cronStore.setEnabled(id, true);
    return { reply: `Enabled ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }
  if (sub === "disable") {
    await cronStore.setEnabled(id, false);
    return { reply: `Disabled ${id}`, sessionSlot: session.shortId, sessionName: session.id, logEnabled: interactionLogger.isEnabled() };
  }

  return {
    reply: TEXT.unknownCron,
    sessionSlot: session.shortId,
    sessionName: session.id,
    logEnabled: interactionLogger.isEnabled()
  };
}

async function runPrompt(chatId: string, session: Session, prompt: string): Promise<CommandResult> {
  if (sessionLocks.has(session.id)) {
    return {
      reply: `Session ${session.shortId} is busy. Try again after current run.`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  sessionLocks.add(session.id);
  try {
    const planMode = store.getPlanMode(session.id);
    const effectivePrompt = applyPlanModePrompt(prompt, planMode);

    const logChunk = (stream: "stdout" | "stderr", chunk: string): void => {
      const single = chunk.replace(/\r?\n/g, "\\n").trim();
      if (!single) {
        return;
      }
      const clipped = single.length > 260 ? `${single.slice(0, 260)}...[+${single.length - 260} chars]` : single;
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`[jclaw-web] chunk slot=${session.shortId} session=${session.id} elapsed=${elapsedSec}s stream=${stream} msg=${clipped}`);
    };

    const runner = resolveRunnerForSession(session, config, codexCommandResolved, geminiRunnerResolved, claudeRunnerResolved);
    const startedAt = Date.now();
    const result = await runLlm({
      codexCommand: runner.command,
      codexArgsTemplate: runner.argsTemplate,
      prompt: effectivePrompt,
      sessionId: session.id,
      threadId: session.threadId,
      timeoutMs: config.codexTimeoutMs,
      workdir: config.codexWorkdir,
      codexNodeOptions: config.codexNodeOptions,
      reasoningEffort: store.getReasoningEffort(session.id),
      provider: runner.provider,
      modelOverride: store.getSessionModelOverride(session.id),
      onStdoutChunk: (chunk) => logChunk("stdout", chunk),
      onStderrChunk: (chunk) => logChunk("stderr", chunk)
    });

    const resolvedThreadId = result.threadId;
    if (resolvedThreadId && resolvedThreadId !== session.threadId) {
      store.setSessionThread(session.id, runner.provider, resolvedThreadId);
    }

    store.appendRun(session.id, {
      id: `r_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      input: prompt,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    const interactionId = await interactionLogger.append({
      channel: "web",
      sessionId: session.id,
      chatId,
      input: prompt,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    });

    const body = formatResult(result.output, result.error, config.maxOutputChars);
    return {
      reply: buildReplyWithHeaders(session, interactionId, { exitCode: result.exitCode, durationMs: result.durationMs }, body),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  } finally {
    sessionLocks.delete(session.id);
  }
}

async function handleCommand(chatId: string, session: Session, cmdLine: string): Promise<CommandResult | null> {
  const parts = cmdLine.split(/\s+/).filter(Boolean);
  const cmd = parts[0]?.toLowerCase();

  if (!cmd || cmd === "/help") {
    return {
      reply: [
        "Commands:",
        "/help",
        "/new",
        `/session <${SLOT_TARGET_HINT}>`,
        "/history [n]",
        "/where",
        "/whoami",
        LOG_COMMAND,
        "/plan <on|off|status>",
        "/cancel",
        "/reason <none|low|medium|high|status>",
        "/model <name|status|clear>",
        "/models [current|all|codex|gemini|claude]",
        "/nick <name|status|clear>",
        "/cron ...",
        "/slot <list|show|bind>"
      ].join("\n"),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/new") {
    const next = store.recreateSessionAtSlot(chatId, session.shortId, "web");
    return {
      reply: `Started new chat in session slot ${next.shortId}`,
      sessionSlot: next.shortId,
      sessionName: next.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/session") {
    const target = parts[1];
    if (!target) {
      return {
        reply: `Usage: /session <${SLOT_TARGET_HINT}>`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    const next = store.setActiveSession(chatId, target, "web");
    return {
      reply: `Switched to session slot ${next.shortId}`,
      sessionSlot: next.shortId,
      sessionName: next.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/where") {
    return {
      reply: sessionSummary(session),
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/whoami") {
    return {
      reply: `chat_id: ${chatId}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/history") {
    const limit = Number(parts[1] ?? "5");
    const rows = store.listHistory(session.id, Number.isNaN(limit) ? 5 : limit);
    return {
      reply: rows.length
        ? rows
            .map((r) => `${r.id} | ${r.timestamp} | exit=${r.exitCode ?? "null"} | ${r.durationMs}ms | ${r.input.slice(0, 60)}`)
            .join("\n")
        : TEXT.noHistory,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/log") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Interaction log: ${interactionLogger.isEnabled() ? "ON" : "OFF"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "on") {
      await interactionLogger.setEnabled(true);
      return {
        reply: TEXT.logOn,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "off") {
      await interactionLogger.setEnabled(false);
      return {
        reply: TEXT.logOff,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    return {
      reply: TEXT.logUsage,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/plan") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Plan mode: ${store.getPlanMode(session.id) ? "ON" : "OFF"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "on") {
      store.setPlanMode(session.id, true);
      return {
        reply: "Plan mode: ON",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    if (mode === "off") {
      store.setPlanMode(session.id, false);
      return {
        reply: "Plan mode: OFF",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }
    return {
      reply: "Usage: /plan <on|off|status>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/cancel") {
    const canceledRunning = cancelSessionRuns(session.id);
    const canceledPending = chatJobStore.cancelPendingForSession(chatId, session.id, "Cancelled by user via /cancel");
    if (canceledPending > 0) {
      scheduleChatWorkers();
    }

    const parts = [];
    if (canceledRunning) {
      parts.push(`Cancelled running request in session ${session.shortId}`);
    }
    if (canceledPending > 0) {
      parts.push(`Removed ${canceledPending} queued request${canceledPending === 1 ? "" : "s"} in session ${session.shortId}`);
    }

    return {
      reply: parts.length ? parts.join("\n") : `No running or queued request in session ${session.shortId}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/reason") {
    const mode = (parts[1] ?? "status").toLowerCase();
    if (mode === "status") {
      return {
        reply: `Reasoning effort: ${store.getReasoningEffort(session.id).toUpperCase()}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (mode === "none" || mode === "low" || mode === "medium" || mode === "high") {
      const next = store.setReasoningEffort(session.id, mode);
      return {
        reply: `Reasoning effort: ${next.toUpperCase()}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    return {
      reply: "Usage: /reason <none|low|medium|high|status>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }



  if (cmd === "/model") {
    const value = parts.slice(1).join(" ").trim();

    if (!value || value.toLowerCase() === "status") {
      const current = store.getSessionModelOverride(session.id);
      return {
        reply: `Model override: ${current || "(default)"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: getSessionNick(session),
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (value.toLowerCase() === "clear") {
      store.setSessionModelOverride(session.id, "");
      return {
        reply: "Model override: (default)",
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: getSessionNick(session),
        logEnabled: interactionLogger.isEnabled()
      };
    }

    const saved = store.setSessionModelOverride(session.id, value);
    return {
      reply: `Model override: ${saved}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/models") {
    const target = (parts[1] ?? "current").toLowerCase();
    const provider = resolveRunnerForSession(
      session,
      config,
      codexCommandResolved,
      geminiRunnerResolved,
      claudeRunnerResolved
    ).provider;

    let reply = "";
    if (target === "all") {
      reply = formatAllModelCatalogs();
    } else if (target === "current") {
      reply = [
        `Current provider: ${provider}`,
        formatModelCatalog(provider),
        "Usage: /model <name>"
      ].join("\n");
    } else if (hasModelCatalog(target)) {
      reply = formatModelCatalog(target);
    } else {
      reply = "Usage: /models [current|all|codex|gemini|claude]";
    }

    return {
      reply,
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/nick") {
    const value = parts.slice(1).join(" ").trim();

    if (!value || value.toLowerCase() === "status") {
      const current = getSessionNick(session);
      return {
        reply: `Nick: ${current || "-"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: current,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (value.toLowerCase() === "clear") {
      const cleared = store.setSessionNickname(session.id, "");
      return {
        reply: `Nick: ${cleared || "-"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: cleared,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    const saved = store.setSessionNickname(session.id, value);
    return {
      reply: `Nick: ${saved || "-"}`,
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: saved,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/slot") {
    const sub = (parts[1] ?? "list").toLowerCase();
    if (sub === "list") {
      const rows = store.listSlotBindings(chatId);
      return {
        reply: rows.length
          ? rows.map((r) => `${r.slotId} | session=${r.sessionId} | provider=${r.provider} | thread=${r.threadId ?? "-"}`).join("\n")
          : "No slots found.",
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (sub === "show") {
      const slot = (parts[2] ?? "").toUpperCase();
      if (!slot) {
        return {
          reply: "Usage: /slot show <A-Z>",
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      const id = store.resolveSessionId(slot, chatId);
      if (!id) {
        return {
          reply: `No session in slot ${slot}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      const target = store.getSession(id);
      if (!target) {
        return {
          reply: `No session in slot ${slot}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      return {
        reply: `${sessionSummary(target)}\nProvider: ${target.provider}\nThread: ${target.threadId ?? "-"}`,
        sessionSlot: session.shortId,
        sessionName: session.id,
        logEnabled: interactionLogger.isEnabled()
      };
    }

    if (sub === "bind") {
      const slot = (parts[2] ?? "").toUpperCase();
      const threadId = parts[3] ?? "";
      const providerInput = (parts[4] ?? "codex").toLowerCase();
      const isValidProvider = providerInput === "codex" || providerInput === "gemini" || providerInput === "claude";
      if (!slot || !threadId) {
        return {
          reply: "Usage: /slot bind <A-Z> <thread_id> [codex|gemini|claude]",
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }
      if (!isValidProvider) {
        return {
          reply: "Usage: /slot bind <A-Z> <thread_id> [codex|gemini|claude]",
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }

      try {
        const bound = store.bindSessionThread(chatId, slot, providerInput, threadId);
        return {
          reply: `Bound ${bound.shortId} -> provider=${bound.provider}, thread=${bound.threadId ?? "-"}
Session Name: ${bound.id}`,
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      } catch (err) {
        return {
          reply: String(err),
          sessionSlot: session.shortId,
          sessionName: session.id,
          logEnabled: interactionLogger.isEnabled()
        };
      }
    }

    return {
      reply: "Usage: /slot <list|show|bind>",
      sessionSlot: session.shortId,
      sessionName: session.id,
      logEnabled: interactionLogger.isEnabled()
    };
  }

  if (cmd === "/cron") {
    return handleCronCommand(chatId, cmdLine, session);
  }

  return null;
}

async function handleApiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  let payload: ChatRequest;
  try {
    payload = JSON.parse(await readBody(req)) as ChatRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const message = (payload.message ?? "").trim();
  const directAttachments = [
    ...(Array.isArray(payload.attachments) ? payload.attachments : []),
    ...(payload.attachment?.contentBase64 ? [payload.attachment] : [])
  ].filter((attachment) => Boolean(attachment?.contentBase64));
  const uploadedIds = [
    ...(Array.isArray(payload.attachments) ? payload.attachments : []),
    ...(payload.attachment?.uploadId ? [payload.attachment] : [])
  ]
    .map((attachment) => String(attachment?.uploadId ?? '').trim())
    .filter(Boolean);
  const attachmentCount = directAttachments.length + uploadedIds.length;
  const hasAttachment = attachmentCount > 0;

  if (attachmentCount > WEB_UPLOAD_MAX_FILES) {
    json(res, 400, { error: `too many attachments (max ${WEB_UPLOAD_MAX_FILES})` });
    return;
  }

  if (!message && !hasAttachment) {
    json(res, 400, { error: "message or attachment is required" });
    return;
  }

  const chatId = WEB_CHAT_ID;

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const requestedSlot = (payload.slot ?? "").trim().toUpperCase();
    const session = requestedSlot
      ? store.ensureSessionForTarget(chatId, requestedSlot)
      : getState(chatId).session;

    let effectivePrompt = message;
    if (hasAttachment) {
      const localPaths: string[] = [];
      for (const attachment of directAttachments) {
        localPaths.push(await saveWebAttachment(attachment));
      }
      if (uploadedIds.length) {
        const uploaded = resolvePendingWebUploads(uploadedIds);
        for (const upload of uploaded) {
          localPaths.push(upload.localPath);
        }
        clearPendingWebUploads(uploadedIds);
      }
      const fileLabel = localPaths.length === 1 ? "file" : "files";
      effectivePrompt = [
        `User uploaded ${localPaths.length} ${fileLabel} from web chat.`,
        ...localPaths.map((localPath, index) => `Local file path ${index + 1}: ${localPath}`),
        "Open and analyze the uploaded file(s) directly.",
        message ? `User request: ${message}` : "If no explicit request, summarize the file contents."
      ].join("\n");
    }

    const normalized = normalizeCommand(effectivePrompt);

    if (!hasAttachment && normalized.startsWith("/")) {
      const cmdResult = await handleCommand(chatId, session, normalized);
      if (cmdResult) {
        const resultSession = store.getSession(cmdResult.sessionName) ?? session;
        json(res, 200, { ...cmdResult, sessionNick: getSessionNick(resultSession) });
        return;
      }
      json(res, 400, { error: "Unknown command" });
      return;
    }

    const activeJob = chatJobStore.getActiveBySession(chatId, session.id);
    if (activeJob) {
      scheduleChatWorkers();
      json(res, 409, {
        error: `Session ${session.shortId} already has an active request. Wait for it to finish.`,
        code: "SESSION_BUSY",
        jobId: activeJob.id,
        status: activeJob.status,
        sessionSlot: session.shortId,
        sessionName: session.id,
        sessionNick: getSessionNick(session),
        logEnabled: interactionLogger.isEnabled()
      });
      return;
    }

    const job = chatJobStore.createPending({
      chatId,
      sessionId: session.id,
      sessionSlot: session.shortId,
      prompt: normalized
    });
    pruneChatJobs();
    json(res, 202, {
      queued: true,
      jobId: job.id,
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      logEnabled: interactionLogger.isEnabled()
    });
    scheduleChatWorkers();
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiChatJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const jobId = (url.searchParams.get("id") ?? "").trim();
  if (!jobId) {
    json(res, 400, { error: "id is required" });
    return;
  }

  const job = chatJobStore.get(jobId);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  if (job.chatId !== WEB_CHAT_ID) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  if (job.status === "completed" && job.result) {
    json(res, 200, {
      done: true,
      success: true,
      result: job.result
    });
    return;
  }

  if (job.status === "failed") {
    json(res, 200, {
      done: true,
      success: false,
      error: job.error ?? "job failed"
    });
    return;
  }

  json(res, 200, {
    done: false,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.sessionId
  });
}

async function handleApiChatJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const slot = (url.searchParams.get("slot") ?? "").trim().toUpperCase();
  const chatId = WEB_CHAT_ID;

  if (!slot) {
    json(res, 400, { error: "slot is required" });
    return;
  }

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  const items = chatJobStore.listRecentBySlot(chatId, slot, 30);
  json(res, 200, { items });
}

async function handleApiSessionEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const slot = (url.searchParams.get("slot") ?? "").trim().toUpperCase();
  if (!slot) {
    json(res, 400, { error: "slot is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  subscribeSessionEvents(slot, res);
  emitSse(res, "connected", { slot, ts: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, CHAT_SSE_HEARTBEAT_MS);

  res.on("close", () => {
    clearInterval(heartbeat);
  });
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = (req.socket.remoteAddress ?? "").trim();
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

async function handleApiInternalSessionEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    json(res, 403, { error: "Loopback only" });
    return;
  }

  let payload: { slot?: string; sessionId?: string; source?: string; trigger?: string; ts?: string };
  try {
    payload = JSON.parse(await readBody(req)) as { slot?: string; sessionId?: string; source?: string; trigger?: string; ts?: string };
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const slot = String(payload.slot ?? "").trim().toUpperCase();
  if (!slot) {
    json(res, 400, { error: "slot is required" });
    return;
  }

  notifySessionEvent(slot, {
    slot,
    sessionId: String(payload.sessionId ?? "").trim() || null,
    source: String(payload.source ?? "external").trim() || "external",
    trigger: String(payload.trigger ?? "run").trim() || "run",
    ts: String(payload.ts ?? new Date().toISOString())
  });

  json(res, 200, { ok: true });
}

async function handleApiChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const jobId = (url.searchParams.get("jobId") ?? "").trim();
  if (!jobId) {
    json(res, 400, { error: "jobId is required" });
    return;
  }

  const job = chatJobStore.get(jobId);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  if (job.chatId !== WEB_CHAT_ID) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  subscribeChatJob(jobId, res);

  emitSse(res, "connected", {
    id: job.id,
    status: job.status,
    sessionSlot: job.sessionSlot,
    sessionName: job.result?.sessionName ?? job.sessionId,
    updatedAt: job.updatedAt
  });

  notifyChatJob(job);

  if (job.status === "completed" || job.status === "failed") {
    return;
  }

  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, CHAT_SSE_HEARTBEAT_MS);

  res.on("close", () => {
    clearInterval(heartbeat);
  });
}

async function handleApiState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;

  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const { session, logEnabled } = getState(chatId);
    json(res, 200, {
      chatId,
      serverLabel: getServerLabel(),
      serverTheme: getServerTheme(),
      sessionSlot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      slotNicks: buildSlotNickMap(chatId),
      logEnabled,
      auth: {
        email: auth.email,
        method: auth.method
      }
    });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiServerLabel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  let payload: ServerLabelUpdateRequest;
  try {
    payload = JSON.parse(await readBody(req)) as ServerLabelUpdateRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const saved = await saveServerLabelConfig(String(payload.label ?? ""), String(payload.theme ?? DEFAULT_WEB_SERVER_THEME));
    json(res, 200, { ok: true, ...saved });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleApiCodexVersionStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  let payload: CodexUpdateRequest = {};
  try {
    payload = JSON.parse(await readBody(req)) as CodexUpdateRequest;
  } catch {}

  try {
    const snapshot = await collectCodexVersionSnapshot();
    if (!codexUpdateStatus.running && codexUpdateStatus.logs.length === 0) {
      resetCodexUpdateStatus(snapshot.latestVersion);
      codexUpdateStatus.currentVersion = snapshot.currentVersion;
      codexUpdateStatus.latestVersion = snapshot.latestVersion;
      codexUpdateStatus.error = snapshot.error;
    }

    json(res, 200, {
      ...snapshot,
      running: codexUpdateStatus.running,
      updateStatus: codexUpdateStatus
    });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleApiCodexUpdateStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  json(res, 200, {
    ...codexVersionSnapshot,
    updateStatus: codexUpdateStatus
  });
}

async function handleApiCodexUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  if (codexUpdateStatus.running) {
    json(res, 409, {
      error: "Codex update already running",
      updateStatus: codexUpdateStatus
    });
    return;
  }

  let payload: CodexUpdateRequest = {};
  try {
    payload = JSON.parse(await readBody(req)) as CodexUpdateRequest;
  } catch {}

  try {
    pushCodexUpdateLog("info", `web pid=${process.pid}`);
    const latestVersion = await readCodexLatestVersion();
    if (!latestVersion) {
      json(res, 500, { error: "Could not determine latest Codex version." });
      return;
    }

    const runningCodex = await listRunningCodexProcesses();
    const detectedCodexSummary = runningCodex.length
      ? runningCodex
          .map((item) => {
            const compact = item.commandLine.replace(/\s+/g, " ").trim();
            const clipped = compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
            return `pid=${item.pid} cmd=${clipped}`;
          })
          .join(" | ")
      : "(none)";
    pushCodexUpdateLog("info", `detected codex ${detectedCodexSummary}`);
    const currentVersionHint = codexVersionSnapshot.currentVersion;
    const updateAvailableHint = Boolean(currentVersionHint && latestVersion && currentVersionHint !== latestVersion);
    if (runningCodex.length > 0 && !payload.killRunning) {
      json(res, 409, {
        error: `Codex is currently running (pid=${runningCodex.map((item) => item.pid).join(", ")})`,
        requiresConfirmation: true,
        runningCodexProcesses: runningCodex,
        updateStatus: codexUpdateStatus,
        currentVersion: currentVersionHint,
        latestVersion,
        updateAvailable: updateAvailableHint
      });
      return;
    }

    if (runningCodex.length > 0 && payload.killRunning) {
      const killedPids = await killRunningCodexProcesses();
      const remainingCodex = await listRunningCodexProcessesWithRetries(3, 750);
      if (remainingCodex.length > 0) {
        json(res, 409, {
          error: `Could not stop all running Codex processes (remaining pid=${remainingCodex.map((item) => item.pid).join(", ")})`,
          requiresConfirmation: true,
          runningCodexProcesses: remainingCodex,
          killedPids,
          updateStatus: codexUpdateStatus,
          currentVersion: currentVersionHint,
          latestVersion,
          updateAvailable: updateAvailableHint
        });
        return;
      }
      pushCodexUpdateLog("info", `Stopped running Codex processes: ${killedPids.join(", ")}`);
    }

    const snapshot = await collectCodexVersionSnapshot();
    if (snapshot.error) {
      json(res, 500, {
        error: snapshot.error,
        updateStatus: codexUpdateStatus,
        currentVersion: snapshot.currentVersion,
        latestVersion: snapshot.latestVersion ?? latestVersion,
        updateAvailable: snapshot.updateAvailable
      });
      return;
    }

    if (!snapshot.updateAvailable) {
      resetCodexUpdateStatus(snapshot.latestVersion ?? latestVersion);
      codexUpdateStatus.currentVersion = snapshot.currentVersion;
      codexUpdateStatus.latestVersion = snapshot.latestVersion ?? latestVersion;
      codexUpdateStatus.success = true;
      codexUpdateStatus.finishedAt = new Date().toISOString();
      pushCodexUpdateLog("success", `Codex is already up to date: ${snapshot.currentVersion ?? snapshot.latestVersion ?? latestVersion}`);
      json(res, 200, {
        ok: true,
        started: false,
        updateStatus: codexUpdateStatus,
        currentVersion: snapshot.currentVersion,
        latestVersion: snapshot.latestVersion ?? latestVersion,
        updateAvailable: false
      });
      return;
    }

    startCodexUpdate(snapshot.latestVersion ?? latestVersion);
    json(res, 202, {
      ok: true,
      started: true,
      updateStatus: codexUpdateStatus,
      currentVersion: snapshot.currentVersion,
      latestVersion: snapshot.latestVersion ?? latestVersion,
      updateAvailable: true
    });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleApiClaudeVersionStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    const snapshot = await collectClaudeVersionSnapshot();
    if (!claudeUpdateStatus.running && claudeUpdateStatus.logs.length === 0) {
      resetClaudeUpdateStatus(snapshot.latestVersion);
      claudeUpdateStatus.currentVersion = snapshot.currentVersion;
      claudeUpdateStatus.latestVersion = snapshot.latestVersion;
      claudeUpdateStatus.error = snapshot.error;
    }

    json(res, 200, {
      ...snapshot,
      running: claudeUpdateStatus.running,
      updateStatus: claudeUpdateStatus
    });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleApiClaudeUpdateStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  json(res, 200, {
    ...claudeVersionSnapshot,
    updateStatus: claudeUpdateStatus
  });
}

async function handleApiClaudeUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  if (claudeUpdateStatus.running) {
    json(res, 409, {
      error: "Claude update already running",
      updateStatus: claudeUpdateStatus
    });
    return;
  }

  try {
    const snapshot = await collectClaudeVersionSnapshot();
    if (snapshot.error) {
      json(res, 500, {
        error: snapshot.error,
        updateStatus: claudeUpdateStatus,
        currentVersion: snapshot.currentVersion,
        latestVersion: snapshot.latestVersion,
        updateAvailable: snapshot.updateAvailable
      });
      return;
    }

    if (!snapshot.latestVersion) {
      json(res, 500, { error: "Could not determine latest Claude version." });
      return;
    }

    if (!snapshot.updateAvailable) {
      resetClaudeUpdateStatus(snapshot.latestVersion);
      claudeUpdateStatus.currentVersion = snapshot.currentVersion;
      claudeUpdateStatus.latestVersion = snapshot.latestVersion;
      claudeUpdateStatus.success = true;
      claudeUpdateStatus.finishedAt = new Date().toISOString();
      pushClaudeUpdateLog("success", `Claude is already up to date: ${snapshot.currentVersion ?? snapshot.latestVersion}`);
      json(res, 200, {
        ok: true,
        started: false,
        updateStatus: claudeUpdateStatus,
        currentVersion: snapshot.currentVersion,
        latestVersion: snapshot.latestVersion,
        updateAvailable: false
      });
      return;
    }

    startClaudeUpdate(snapshot.latestVersion);
    json(res, 202, {
      ok: true,
      started: true,
      updateStatus: claudeUpdateStatus,
      currentVersion: snapshot.currentVersion,
      latestVersion: snapshot.latestVersion,
      updateAvailable: true
    });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleApiAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = getAuthSession(req);
  json(res, 200, {
    authenticated: Boolean(session),
    serverLabel: getServerLabel(),
    serverTheme: getServerTheme(),
    email: session?.email ?? null,
    method: session?.method ?? null,
    googleClientId: WEB_GOOGLE_CLIENT_ID || null,
    googleEnabled: Boolean(WEB_GOOGLE_CLIENT_ID),
    devPasswordEnabled: true,
    devPasswordLocked,
    devPasswordFailedAttempts,
    devPasswordRemainingAttempts: Math.max(0, WEB_DEV_MAX_FAILED_ATTEMPTS - devPasswordFailedAttempts),
    allowedEmailsConfigured: WEB_ALLOWED_EMAILS.size > 0
  });
}

async function handleApiAuthGoogle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: AuthRequest;
  try {
    payload = JSON.parse(await readBody(req)) as AuthRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const idToken = (payload.idToken ?? "").trim();
  if (!idToken) {
    json(res, 400, { error: "idToken is required" });
    return;
  }

  try {
    const email = await verifyGoogleIdToken(idToken);
    if (!email) {
      json(res, 401, { error: "Google authentication failed" });
      return;
    }

    const session = createAuthSession(email, "google");
    setAuthCookie(res, session.token);
    json(res, 200, { ok: true, email: session.email, method: session.method });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function notifyDevLoginLocked(req: IncomingMessage): Promise<void> {
  if (!config.telegramBotToken || config.allowedChatIds.size === 0) {
    return;
  }

  const forwardedFor = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const remoteIp = forwardedFor || req.socket.remoteAddress || "unknown";
  const userAgent = String(req.headers["user-agent"] ?? "unknown");
  const ts = new Date().toISOString();
  const message = [
    "[jclaw-web] SECURITY ALERT",
    `event: dev-login-locked`,
    `failed_attempts: ${WEB_DEV_MAX_FAILED_ATTEMPTS}`,
    `ip: ${remoteIp}`,
    `user_agent: ${userAgent}`,
    `time: ${ts}`
  ].join("\n");

  const targets = Array.from(config.allowedChatIds);
  await Promise.all(
    targets.map(async (chatId) => {
      try {
        await sendTelegramTextNotification({
          botToken: config.telegramBotToken,
          chatId,
          text: message
        });
      } catch (err) {
        console.error(`[jclaw-web] failed to send dev-login lock alert to ${chatId}:`, err);
      }
    })
  );
}

async function handleApiAuthDev(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (devPasswordLocked) {
    json(res, 423, { error: "Developer login is locked. Restart server to unlock." });
    return;
  }

  let payload: AuthRequest;
  try {
    payload = JSON.parse(await readBody(req)) as AuthRequest;
  } catch (err) {
    json(res, 400, { error: String(err) });
    return;
  }

  const password = payload.password ?? "";
  if (!password) {
    json(res, 400, { error: "password is required" });
    return;
  }

  if (password !== WEB_DEV_PASSWORD) {
    devPasswordFailedAttempts += 1;
    if (devPasswordFailedAttempts >= WEB_DEV_MAX_FAILED_ATTEMPTS) {
      devPasswordLocked = true;
      console.warn("[jclaw-web] developer login locked after too many failed attempts; restart server to unlock.");
      void notifyDevLoginLocked(req);
      json(res, 423, { error: "Developer login locked after 3 failed attempts. Restart server to unlock." });
      return;
    }

    json(res, 401, {
      error: "Invalid development password",
      remainingAttempts: WEB_DEV_MAX_FAILED_ATTEMPTS - devPasswordFailedAttempts
    });
    return;
  }

  devPasswordFailedAttempts = 0;
  const session = createAuthSession("dev-login@local", "dev");
  setAuthCookie(res, session.token);
  json(res, 200, { ok: true, email: session.email, method: session.method });
}

async function handleApiAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = parseCookies(req).get(WEB_AUTH_COOKIE);
  if (token) {
    webAuthSessions.delete(token);
  }
  clearAuthCookie(res);
  json(res, 200, { ok: true });
}

async function handleApiSessionHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = requireAuth(req, res);
  if (!auth) {
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const slot = (url.searchParams.get("slot") ?? "").trim().toUpperCase();
  const limitRaw = Number(url.searchParams.get("limit") ?? "60");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(300, Math.floor(limitRaw))) : 60;
  const fromDate = (url.searchParams.get("fromDate") ?? "").trim();
  const toDate = (url.searchParams.get("toDate") ?? "").trim();

  const chatId = WEB_CHAT_ID;
  if (!ensureAllowed(chatId)) {
    json(res, 403, { error: "Access denied" });
    return;
  }

  try {
    let session: Session | null = null;
    if (slot) {
      const resolved = store.resolveSessionId(slot, chatId);
      session = resolved ? store.getSession(resolved) : null;
    } else {
      session = getState(chatId).session;
    }

    if (!session) {
      json(res, 200, { slot, sessionName: null, sessionNick: "", items: [] });
      return;
    }

    let rows;
    let range: { fromDate: string; toDate: string; startIso: string; endIsoExclusive: string } | null = null;
    if (fromDate || toDate) {
      range = parseKstDateRange(fromDate || toDate, toDate || fromDate);
      rows = store.listHistoryByTimeRange(session.id, range.startIso, range.endIsoExclusive);
    } else {
      rows = store.listHistory(session.id, limit);
    }

    json(res, 200, {
      slot: session.shortId,
      sessionName: session.id,
      sessionNick: getSessionNick(session),
      timezone: KST_TIME_ZONE,
      fromDate: range?.fromDate ?? null,
      toDate: range?.toDate ?? null,
      items: rows
    });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  const webRoot = path.resolve(process.cwd(), "web");
  const candidate = pathname === "/" ? "index.html" : `.${pathname}`;
  const filePath = path.resolve(webRoot, candidate);

  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export async function startWebServer(): Promise<void> {
  await store.init();
  await interactionLogger.init();
  await cronStore.init();
  await chatJobStore.init({ resumeIncompleteJobs: WEB_CHAT_RESUME_INCOMPLETE_JOBS });
  await loadServerLabelConfig();

  const resolved = await resolveCodexCommand(config.codexCommand);
  codexCommandResolved = resolved.command;
  const geminiResolved = await resolveGeminiRunner(config.geminiCommand, config.geminiArgsTemplate);
  geminiRunnerResolved = { command: geminiResolved.command, argsTemplate: geminiResolved.argsTemplate };
  console.log(`[jclaw-web] gemini command resolved: ${geminiResolved.command} (${geminiResolved.source})`);
  const claudeResolved = await resolveClaudeRunner(config.claudeCommand, config.claudeArgsTemplate);
  claudeRunnerResolved = { command: claudeResolved.command, argsTemplate: claudeResolved.argsTemplate };
  console.log(`[jclaw-web] claude command resolved: ${claudeResolved.command} (${claudeResolved.source})`);

  scheduleChatWorkers();

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      json(res, 400, { error: "Bad request" });
      return;
    }

    const corsAllowed = applyCors(req, res);
    if (!corsAllowed) {
      json(res, 403, { error: "Origin not allowed" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (req.method === "GET" && pathname === "/api/auth/status") {
      await handleApiAuthStatus(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/google") {
      await handleApiAuthGoogle(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/dev") {
      await handleApiAuthDev(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      await handleApiAuthLogout(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/server-label") {
      await handleApiServerLabel(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/codex/version-status") {
      await handleApiCodexVersionStatus(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/codex/update-status") {
      await handleApiCodexUpdateStatus(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/codex/update") {
      await handleApiCodexUpdate(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/claude/version-status") {
      await handleApiClaudeVersionStatus(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/claude/update-status") {
      await handleApiClaudeUpdateStatus(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/claude/update") {
      await handleApiClaudeUpdate(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      await handleApiState(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/session-history") {
      await handleApiSessionHistory(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/upload") {
      await handleApiUpload(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/upload/delete") {
      await handleApiUploadDelete(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      await handleApiChat(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat-job") {
      await handleApiChatJob(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat/jobs") {
      await handleApiChatJobs(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat/stream") {
      await handleApiChatStream(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/session-events") {
      await handleApiSessionEvents(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/internal/session-event") {
      await handleApiInternalSessionEvent(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    console.log(`[jclaw-web] running at http://${WEB_HOST}:${WEB_PORT}`);
  });
}

if (require.main === module) {
  void startWebServer();
}


