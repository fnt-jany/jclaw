export const SLOT_IDS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"
] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const SLOT_TARGET_HINT = "A-Z|id|prefix";
export const DEFAULT_LOCAL_CHAT_ID = "windows-cli";
export const LOG_COMMAND = "/log <on|off|status>";

export const TEXT = {
  noHistory: "No history yet.",
  noCronJobs: "No cron jobs.",
  unknownCron: "Unknown /cron subcommand. Use /cron help",
  logUsage: "Usage: /log <on|off|status>",
  logOn: "Interaction log: ON",
  logOff: "Interaction log: OFF"
} as const;
