export function applyPlanModePrompt(prompt: string, enabled: boolean): string {
  if (!enabled) {
    return prompt;
  }

  const normalized = prompt.trim();
  return [
    "[PLAN MODE ON]",
    "First, output a short numbered plan (2-5 steps).",
    "Then execute/answer based on that plan.",
    "Keep it concise and practical.",
    "",
    normalized
  ].join("\n");
}
