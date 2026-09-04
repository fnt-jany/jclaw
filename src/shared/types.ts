import type { Session } from "../core/session/sessionStore";

export type CommandResult = {
  reply: string;
  sessionSlot: string;
  sessionName: string;
  sessionNick?: string;
  sessionModel?: {
    provider: string;
    model: string;
    reasoningEffort: string;
    modelOverride: string;
  };
  slotModels?: Record<string, {
    provider: string;
    model: string;
    reasoningEffort: string;
    modelOverride: string;
  }>;
  logEnabled: boolean;
};

export function sessionSummary(session: Session): string {
  return `Session Slot: ${session.shortId}\nSession Name: ${session.id}`;
}
