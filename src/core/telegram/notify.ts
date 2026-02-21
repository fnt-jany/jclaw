import type { CronJob } from "../cron/store";

type CronNotifyInput = {
  botToken: string;
  chatId: string;
  maxChars: number;
  verbose: boolean;
  job: CronJob;
  sessionName: string | null;
  status: "ok" | "error";
  prompt: string;
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
};

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  const kept = text.slice(0, Math.max(0, maxChars - 14));
  return `${kept}\n...[truncated]`;
}

function formatCompact(input: CronNotifyInput): string {
  const lines: string[] = [];
  if (input.status === "ok") {
    lines.push(`[cron] session: ${input.job.sessionTarget}`);
  } else {
    lines.push(`[cron] ERROR | session: ${input.job.sessionTarget}`);
  }

  const resultSource = input.status === "ok" ? input.output : input.error ?? input.output;
  const result = truncate((resultSource ?? "").trim(), Math.floor(input.maxChars * 0.85));
  lines.push(result || "(empty)");

  return truncate(lines.join("\n"), input.maxChars);
}

function formatVerbose(input: CronNotifyInput): string {
  const lines: string[] = [];
  lines.push(`[cron] ${input.status.toUpperCase()} ${input.job.id}`);
  lines.push(`slot: ${input.job.sessionTarget}`);
  if (input.sessionName) {
    lines.push(`session: ${input.sessionName}`);
  }
  lines.push(`exit: ${input.exitCode ?? "null"}`);
  lines.push(`time: ${input.durationMs}ms`);

  const prompt = truncate(input.prompt.trim(), Math.floor(input.maxChars * 0.3));
  lines.push(`prompt: ${prompt || "(empty)"}`);

  const detailSource = input.status === "ok" ? input.output : input.error ?? input.output;
  const detail = truncate((detailSource ?? "").trim(), Math.floor(input.maxChars * 0.6));
  if (detail) {
    lines.push("detail:");
    lines.push(detail);
  }

  return truncate(lines.join("\n"), input.maxChars);
}

function formatMessage(input: CronNotifyInput): string {
  if (!input.verbose) {
    return formatCompact(input);
  }
  return formatVerbose(input);
}

export async function sendCronTelegramNotification(input: CronNotifyInput): Promise<void> {
  if (!input.botToken.trim()) {
    return;
  }

  const body = {
    chat_id: input.chatId,
    text: formatMessage(input)
  };

  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram notify failed (${response.status}): ${text}`);
  }
}
