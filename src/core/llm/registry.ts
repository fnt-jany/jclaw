import type { AppConfig } from "../config/env";
import type { Session } from "../session/sessionStore";
import { codexDriver } from "./drivers/codexDriver";
import { geminiDriver } from "./drivers/geminiDriver";
import { claudeDriver } from "./drivers/claudeDriver";
import type { LlmDriver, LlmRunner } from "./types";

export type LlmRegistry = {
  drivers: Record<string, LlmDriver>;
};

export function createLlmRegistry(): LlmRegistry {
  return {
    drivers: {
      codex: codexDriver,
      gemini: geminiDriver,
      claude: claudeDriver
    }
  };
}

export function resolveLlmRunnerForSession(
  session: Session,
  config: AppConfig,
  resolvedCodexCommand: string,
  resolvedGemini: { command: string; argsTemplate: string },
  resolvedClaude: { command: string; argsTemplate: string },
  registry: LlmRegistry = createLlmRegistry()
): LlmRunner {
  const slot = session.shortId.trim().toUpperCase();
  const mappedProvider = config.llmProviderMap.get(slot);

  if (mappedProvider && registry.drivers[mappedProvider]) {
    const driver = registry.drivers[mappedProvider];
    if (mappedProvider === "gemini") {
      return driver.createRunner({
        command: resolvedGemini.command,
        argsTemplate: resolvedGemini.argsTemplate
      });
    }
    if (mappedProvider === "claude") {
      return driver.createRunner({
        command: resolvedClaude.command,
        argsTemplate: resolvedClaude.argsTemplate
      });
    }
    return driver.createRunner({
      command: resolvedCodexCommand,
      argsTemplate: config.codexArgsTemplate
    });
  }

  if (config.geminiSessionSlots.has(slot) && registry.drivers.gemini) {
    return registry.drivers.gemini.createRunner({
      command: resolvedGemini.command,
      argsTemplate: resolvedGemini.argsTemplate
    });
  }

  if (!registry.drivers.codex) {
    throw new Error("Missing default codex driver in registry");
  }

  return registry.drivers.codex.createRunner({
    command: resolvedCodexCommand,
    argsTemplate: config.codexArgsTemplate
  });
}


export function resolveLlmProviderForSession(
  session: Session,
  config: AppConfig,
  registry: LlmRegistry = createLlmRegistry()
): string {
  const slot = session.shortId.trim().toUpperCase();
  const mappedProvider = config.llmProviderMap.get(slot);

  if (mappedProvider && registry.drivers[mappedProvider]) {
    return mappedProvider;
  }

  if (config.geminiSessionSlots.has(slot) && registry.drivers.gemini) {
    return "gemini";
  }

  return "codex";
}
