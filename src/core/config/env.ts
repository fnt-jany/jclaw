import { z } from "zod";
import path from "node:path";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ALLOWED_CHAT_IDS: z.string().default(""),
  ADMIN_CHAT_IDS: z.string().default(""),
  DATA_FILE: z.string().default("./data/interactions.json"),
  DB_FILE: z.string().default(""),
  CODEX_COMMAND: z.string().default("auto"),
  CODEX_ARGS_TEMPLATE: z.string().default("{prompt}"),
  CODEX_WORKDIR: z.string().default("."),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(3500),
  CODEX_NODE_OPTIONS: z.string().default(""),
  CRON_NOTIFY_TELEGRAM: z.string().default("false"),
  CRON_NOTIFY_MAX_CHARS: z.coerce.number().int().positive().default(1200),
  CRON_NOTIFY_VERBOSE: z.string().default("true")
});

export type AppConfig = {
  telegramBotToken: string;
  allowedChatIds: Set<string>;
  adminChatIds: Set<string>;
  dataFile: string;
  dbFile: string;
  codexCommand: string;
  codexArgsTemplate: string;
  codexWorkdir: string;
  codexTimeoutMs: number;
  maxOutputChars: number;
  codexNodeOptions: string;
  cronNotifyTelegram: boolean;
  cronNotifyMaxChars: number;
  cronNotifyVerbose: boolean;
};

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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
    adminChatIds: new Set(
      parsed.ADMIN_CHAT_IDS.split(",")
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
    cronNotifyTelegram: parseBoolean(parsed.CRON_NOTIFY_TELEGRAM),
    cronNotifyMaxChars: parsed.CRON_NOTIFY_MAX_CHARS,
    cronNotifyVerbose: parseBoolean(parsed.CRON_NOTIFY_VERBOSE)
  };
}
