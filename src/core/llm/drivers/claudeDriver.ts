import type { LlmDriver } from "../types";

export const claudeDriver: LlmDriver = {
  id: "claude",
  capabilities: {
    resume: true,
    streaming: true,
    toolCalling: true
  },
  createRunner(input) {
    return {
      provider: "claude",
      command: input.command,
      argsTemplate: input.argsTemplate
    };
  }
};
