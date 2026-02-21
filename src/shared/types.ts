import type { Session } from "../core/session/sessionStore";

export type CommandResult = {
  reply: string;
  sessionSlot: string;
  sessionName: string;
  logEnabled: boolean;
};

export function sessionSummary(session: Session): string {
  return `Session Slot: ${session.shortId}\nSession Name: ${session.id}`;
}
