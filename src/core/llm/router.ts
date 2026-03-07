import type { Session } from "../session/sessionStore";
import type { AppConfig } from "../config/env";
import { resolveLlmRunnerForSession } from "./registry";

export type SessionRunner = ReturnType<typeof resolveLlmRunnerForSession>;

export function resolveRunnerForSession(
  session: Session,
  config: AppConfig,
  resolvedCodexCommand: string,
  resolvedGemini: { command: string; argsTemplate: string },
  resolvedClaude: { command: string; argsTemplate: string }
): SessionRunner {
  return resolveLlmRunnerForSession(session, config, resolvedCodexCommand, resolvedGemini, resolvedClaude);
}

