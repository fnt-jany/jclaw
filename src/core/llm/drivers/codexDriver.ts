import type { LlmDriver } from "../types";

export const codexDriver: LlmDriver = {
  id: "codex",
  capabilities: {
    resume: true,
    streaming: true,
    toolCalling: true
  },
  createRunner(input) {
    return {
      provider: "codex",
      command: input.command,
      argsTemplate: input.argsTemplate
    };
  }
};
