import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TelegramCrashLogRecord = {
  id: string;
  timestamp: string;
  source: string;
  message: string;
  stack: string;
  processed: boolean;
  processedAt: string | null;
  processedNote: string | null;
};

type TelegramCrashLogStore = {
  records: TelegramCrashLogRecord[];
};


function toKstIso(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+09:00");
}

function ensureFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify({ records: [] }, null, 2), "utf8");
  }
}

function readStore(filePath: string): TelegramCrashLogStore {
  ensureFile(filePath);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelegramCrashLogStore>;
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    return { records: records as TelegramCrashLogRecord[] };
  } catch {
    return { records: [] };
  }
}

function writeStore(filePath: string, store: TelegramCrashLogStore): void {
  ensureFile(filePath);
  writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8");
}

function toErrorText(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    return {
      message: err.message || "Unknown error",
      stack: err.stack ?? err.message ?? ""
    };
  }

  const text = String(err);
  return {
    message: text,
    stack: text
  };
}

export function appendTelegramCrashLogSync(filePath: string, source: string, err: unknown): TelegramCrashLogRecord {
  const store = readStore(filePath);
  const errorText = toErrorText(err);
  const now = toKstIso(new Date());

  const record: TelegramCrashLogRecord = {
    id: `te_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    timestamp: now,
    source,
    message: errorText.message,
    stack: errorText.stack,
    processed: false,
    processedAt: null,
    processedNote: null
  };

  store.records.push(record);
  writeStore(filePath, store);
  return record;
}

export function listUnhandledTelegramCrashLogs(filePath: string): TelegramCrashLogRecord[] {
  const store = readStore(filePath);
  return store.records.filter((row) => !row.processed);
}

export function markTelegramCrashLogsProcessed(filePath: string, ids: string[], note: string): void {
  if (!ids.length) {
    return;
  }

  const store = readStore(filePath);
  const set = new Set(ids);
  const processedAt = toKstIso(new Date());

  for (const row of store.records) {
    if (set.has(row.id)) {
      row.processed = true;
      row.processedAt = processedAt;
      row.processedNote = note;
    }
  }

  writeStore(filePath, store);
}
