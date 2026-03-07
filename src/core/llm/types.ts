export type LlmProviderId = "codex" | "gemini" | "claude" | (string & {});

export type LlmCapabilities = {
  resume: boolean;
  streaming: boolean;
  toolCalling: boolean;
};

export type LlmRunner = {
  provider: LlmProviderId;
  command: string;
  argsTemplate: string;
};

export type LlmDriver = {
  id: LlmProviderId;
  capabilities: LlmCapabilities;
  createRunner(input: { command: string; argsTemplate: string }): LlmRunner;
};

