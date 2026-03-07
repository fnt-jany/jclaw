import type { LlmDriver } from "../types";

export const geminiDriver: LlmDriver = {
  id: "gemini",
  capabilities: {
    resume: true,
    streaming: true,
    toolCalling: true
  },
  createRunner(input) {
    return {
      provider: "gemini",
      command: input.command,
      argsTemplate: input.argsTemplate
    };
  }
};
