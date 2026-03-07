import type { LlmProviderId } from "./types";

type ProviderCatalog = {
  examples: string[];
  note: string;
};

const CATALOG: Record<string, ProviderCatalog> = {
  codex: {
    examples: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
    note: "Use a model id available to your OpenAI account and Codex CLI version."
  },
  gemini: {
    examples: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    note: "Use a model id available to your Google account and Gemini CLI version."
  },
  claude: {
    examples: ["sonnet", "opus", "claude-sonnet-4-6"],
    note: "Claude accepts aliases (sonnet/opus) and full model ids."
  }
};

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function formatExamples(examples: string[]): string {
  return examples.map((model) => `- /model ${model}`).join("\n");
}

export function listCatalogProviders(): string[] {
  return Object.keys(CATALOG);
}

export function hasModelCatalog(provider: string): boolean {
  return normalizeProvider(provider) in CATALOG;
}

export function formatModelCatalog(provider: LlmProviderId | string): string {
  const normalized = normalizeProvider(provider);
  const catalog = CATALOG[normalized];
  if (!catalog) {
    return [
      `[${normalized}]`,
      "No model catalog registered.",
      "Use default: /model clear"
    ].join("\n");
  }

  return [
    `[${normalized}]`,
    "Set one of:",
    formatExamples(catalog.examples),
    "Use default: /model clear",
    `Note: ${catalog.note}`
  ].join("\n");
}

export function formatAllModelCatalogs(): string {
  return [
    "Model catalogs by provider",
    ...listCatalogProviders().map((provider) => formatModelCatalog(provider))
  ].join("\n\n");
}
