import { z } from "zod";
import path from "node:path";
import type { LlmProviderId } from "../llm/types";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ALLOWED_CHAT_IDS: z.string().default(""),
  DATA_FILE: z.string().default("./data/interactions.json"),
  DB_FILE: z.string().default(""),
  CODEX_COMMAND: z.string().default("auto"),
  CODEX_ARGS_TEMPLATE: z.string().default("{prompt}"),
  CODEX_WORKDIR: z.string().default("."),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(3600000),
  MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(3500),
  CODEX_NODE_OPTIONS: z.string().default(""),
  GEMINI_SESSION_SLOTS: z.string().default("Y,Z"),
  LLM_PROVIDER_MAP: z.string().default(""),
  GEMINI_COMMAND: z.string().default("auto"),
  GEMINI_ARGS_TEMPLATE: z.string().default("--prompt \"{prompt}\" --output-format text --yolo"),
  CLAUDE_COMMAND: z.string().default("auto"),
  CLAUDE_ARGS_TEMPLATE: z.string().default("-p \"{prompt}\""),
  CRON_NOTIFY_TELEGRAM: z.string().default("false"),
  CRON_NOTIFY_MAX_CHARS: z.coerce.number().int().positive().default(1200),
  CRON_NOTIFY_VERBOSE: z.string().default("true")
});

export type AppConfig = {
  telegramBotToken: string;
  allowedChatIds: Set<string>;
  dataFile: string;
  dbFile: string;
  codexCommand: string;
  codexArgsTemplate: string;
  codexWorkdir: string;
  codexTimeoutMs: number;
  maxOutputChars: number;
  codexNodeOptions: string;
  geminiSessionSlots: Set<string>;
  llmProviderMap: Map<string, LlmProviderId>;
  geminiCommand: string;
  geminiArgsTemplate: string;
  claudeCommand: string;
  claudeArgsTemplate: string;
  cronNotifyTelegram: boolean;
  cronNotifyMaxChars: number;
  cronNotifyVerbose: boolean;
};

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseProviderMap(raw: string): Map<string, LlmProviderId> {
  const map = new Map<string, LlmProviderId>();

  for (const item of raw.split(",").map((v) => v.trim()).filter(Boolean)) {
    const [slotRaw, providerRaw] = item.split(":").map((v) => v.trim());
    if (!slotRaw || !providerRaw) {
      continue;
    }

    const slot = slotRaw.toUpperCase();
    const provider = providerRaw.toLowerCase();
    if (provider) {
      map.set(slot, provider as LlmProviderId);
    }
  }

  return map;
}


export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);
  const dataFile = path.resolve(parsed.DATA_FILE);
  const dbFile = parsed.DB_FILE.trim()
    ? path.resolve(parsed.DB_FILE)
    : path.join(path.dirname(dataFile), "jclaw.db");

  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedChatIds: new Set(
      parsed.ALLOWED_CHAT_IDS.split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    ),
    dataFile,
    dbFile,
    codexCommand: parsed.CODEX_COMMAND,
    codexArgsTemplate: parsed.CODEX_ARGS_TEMPLATE,
    codexWorkdir: path.resolve(parsed.CODEX_WORKDIR),
    codexTimeoutMs: parsed.CODEX_TIMEOUT_MS,
    maxOutputChars: parsed.MAX_OUTPUT_CHARS,
    codexNodeOptions: parsed.CODEX_NODE_OPTIONS,
    geminiSessionSlots: new Set(
      parsed.GEMINI_SESSION_SLOTS.split(",")
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean)
    ),
    llmProviderMap: parseProviderMap(parsed.LLM_PROVIDER_MAP),
    geminiCommand: parsed.GEMINI_COMMAND.trim() || "gemini",
    geminiArgsTemplate: parsed.GEMINI_ARGS_TEMPLATE,
    claudeCommand: parsed.CLAUDE_COMMAND.trim() || "claude",
    claudeArgsTemplate: parsed.CLAUDE_ARGS_TEMPLATE,
    cronNotifyTelegram: parseBoolean(parsed.CRON_NOTIFY_TELEGRAM),
    cronNotifyMaxChars: parsed.CRON_NOTIFY_MAX_CHARS,
    cronNotifyVerbose: parseBoolean(parsed.CRON_NOTIFY_VERBOSE)
  };
}

