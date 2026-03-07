import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLlmRegistry } from "../llm/registry";
import type { LlmProviderId } from "../llm/types";
import { SessionStore } from "../session/sessionStore";
import { SLOT_IDS, type SlotId } from "../../shared/constants";

type BindingImportRow = {
  slotId: SlotId;
  provider?: string;
  threadId?: string;
  codexSessionId?: string; // legacy alias
  sessionId?: string;
};

type BindingFile = {
  chatId: string;
  bindings: BindingImportRow[];
};

export type SlotBindingRow = {
  slotId: SlotId;
  sessionId: string;
  provider: LlmProviderId;
  threadId: string | null;
};

export class SlotBindingService {
  private readonly supportedProviders: Set<string>;

  constructor(private readonly store: SessionStore) {
    this.supportedProviders = new Set(Object.keys(createLlmRegistry().drivers));
  }

  list(chatId: string): SlotBindingRow[] {
    return this.store.listSlotBindings(chatId);
  }

  bind(chatId: string, slot: string, provider: string, threadId: string) {
    const slotId = slot.toUpperCase() as SlotId;
    if (!SLOT_IDS.includes(slotId)) {
      throw new Error(`Invalid slot id: ${slot}`);
    }

    const providerId = provider.trim().toLowerCase();
    if (!this.supportedProviders.has(providerId)) {
      throw new Error(`Unsupported provider: ${provider}. Supported: ${Array.from(this.supportedProviders).join(", ")}`);
    }

    return this.store.bindSessionThread(chatId, slotId, providerId as LlmProviderId, threadId);
  }

  async exportToFile(chatId: string, outFile: string): Promise<{ filePath: string; count: number }> {
    const bindings = this.store
      .listSlotBindings(chatId)
      .filter((row) => row.threadId)
      .map((row) => ({
        slotId: row.slotId,
        provider: row.provider,
        threadId: row.threadId as string,
        sessionId: row.sessionId
      }));

    const payload: BindingFile = { chatId, bindings };
    const filePath = path.resolve(outFile);
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { filePath, count: bindings.length };
  }

  async importFromFile(file: string, overrideChatId?: string): Promise<{ chatId: string; applied: number }> {
    const raw = await readFile(path.resolve(file), "utf8");
    const parsed = JSON.parse(raw) as BindingFile;
    const chatId = overrideChatId ?? parsed.chatId;

    if (!chatId) {
      throw new Error("Missing chat id. Provide --chat or chatId in file.");
    }

    let applied = 0;
    for (const row of parsed.bindings ?? []) {
      const slot = String(row.slotId).toUpperCase();
      if (!SLOT_IDS.includes(slot as SlotId)) {
        continue;
      }

      const provider = String(row.provider ?? "codex").trim().toLowerCase();
      if (!this.supportedProviders.has(provider)) {
        continue;
      }

      const threadId = row.threadId ?? row.codexSessionId;
      if (!threadId) {
        continue;
      }

      this.store.bindSessionThread(chatId, slot as SlotId, provider as LlmProviderId, threadId);
      applied += 1;
    }

    return { chatId, applied };
  }
}
