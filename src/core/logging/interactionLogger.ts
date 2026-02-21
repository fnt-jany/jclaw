import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type InteractionChannel = "telegram" | "cli" | "web" | "cron";

export type InteractionRecord = {
  id: number;
  timestamp: string;
  channel: InteractionChannel;
  sessionId: string;
  chatId: string | null;
  input: string;
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
};

type InteractionStore = {
  enabled: boolean;
  lastId: number;
  records: InteractionRecord[];
};

const EMPTY_STORE: InteractionStore = {
  enabled: false,
  lastId: 0,
  records: []
};

export class InteractionLogger {
  private readonly filePath: string;
  private store: InteractionStore = { ...EMPTY_STORE };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<InteractionStore>;
      this.store = {
        enabled: parsed.enabled === true,
        lastId: Number.isInteger(parsed.lastId) ? (parsed.lastId as number) : 0,
        records: Array.isArray(parsed.records) ? (parsed.records as InteractionRecord[]) : []
      };
    } catch {
      this.store = { ...EMPTY_STORE };
      await this.flush();
    }
  }

  isEnabled(): boolean {
    return this.store.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.store.enabled = enabled;
    await this.flush();
  }

  async append(input: Omit<InteractionRecord, "id" | "timestamp">): Promise<number | null> {
    if (!this.store.enabled) {
      return null;
    }

    const nextId = this.store.lastId + 1;
    this.store.lastId = nextId;
    this.store.records.push({
      id: nextId,
      timestamp: new Date().toISOString(),
      ...input
    });

    await this.flush();
    return nextId;
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() =>
      writeFile(this.filePath, JSON.stringify(this.store, null, 2), "utf8")
    );
    await this.writeQueue;
  }
}
