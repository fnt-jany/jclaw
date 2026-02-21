import dotenv from "dotenv";
import { loadConfig } from "../../core/config/env";
import { CronStore } from "../../core/cron/store";
import { buildOneShotCron } from "../../core/cron/oneshot";
import { SessionStore } from "../../core/session/sessionStore";
import { DEFAULT_LOCAL_CHAT_ID, SLOT_TARGET_HINT, TEXT } from "../../shared/constants";

dotenv.config({ quiet: true });

const config = loadConfig(process.env);
const cronStore = new CronStore(config.dbFile);
const sessionStore = new SessionStore(config.dbFile);

type Cmd = "list" | "add" | "once" | "remove" | "enable" | "disable";

type Parsed = {
  cmd: Cmd;
  args: string[];
};

function parse(): Parsed {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] ?? "list") as Cmd;
  if (!["list", "add", "once", "remove", "enable", "disable"].includes(cmd)) {
    throw new Error("Unknown command");
  }
  return { cmd, args: argv.slice(1) };
}

function argValue(args: string[], key: string): string | null {
  const idx = args.findIndex((v) => v === key);
  if (idx < 0) {
    return null;
  }
  return args[idx + 1] ?? null;
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  npm run cron:cli -- list",
      `  npm run cron:cli -- add --chat <chat_id> --session <${SLOT_TARGET_HINT}> --cron \"*/5 * * * *\" --prompt \"text\" [--tz Asia/Seoul]`,
      `  npm run cron:cli -- once --chat <chat_id> --session <${SLOT_TARGET_HINT}> --at \"2026-02-21T16:00:00+09:00\" --prompt \"text\"`,
      "  npm run cron:cli -- remove <job_id>",
      "  npm run cron:cli -- enable <job_id>",
      "  npm run cron:cli -- disable <job_id>"
    ].join("\n")
  );
}

export async function startCronCli(): Promise<void> {
  await cronStore.init();
  await sessionStore.init();

  let parsed: Parsed;
  try {
    parsed = parse();
  } catch (err) {
    console.error(String(err));
    usage();
    process.exit(1);
    return;
  }

  if (parsed.cmd === "list") {
    const rows = cronStore.list();
    if (!rows.length) {
      console.log(TEXT.noCronJobs);
      return;
    }

    for (const job of rows) {
      console.log(
        [
          `${job.id} | ${job.enabled ? "on" : "off"}${job.runOnce ? " | once" : ""}`,
          `chat=${job.chatId} session=${job.sessionTarget}`,
          `cron=${job.cron}${job.timezone ? ` tz=${job.timezone}` : ""}`,
          `next=${job.nextRunAt}`,
          `last=${job.lastRunAt ?? "-"} status=${job.lastStatus ?? "-"}`,
          `error=${job.lastError ?? "-"}`,
          `prompt=${job.prompt}`,
          "---"
        ].join("\n")
      );
    }
    return;
  }

  if (parsed.cmd === "add") {
    const chatId = argValue(parsed.args, "--chat") ?? Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
    const sessionTarget = argValue(parsed.args, "--session");
    const cron = argValue(parsed.args, "--cron");
    const prompt = argValue(parsed.args, "--prompt");
    const tz = argValue(parsed.args, "--tz");

    if (!sessionTarget || !cron || !prompt) {
      console.error("Missing --session, --cron or --prompt");
      usage();
      process.exit(1);
      return;
    }

    try {
      sessionStore.ensureSessionForTarget(chatId, sessionTarget);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
      return;
    }

    const job = await cronStore.create({
      chatId,
      sessionTarget,
      cron,
      prompt,
      timezone: tz
    });

    console.log(`Created job ${job.id}`);
    console.log(`next=${job.nextRunAt}`);
    return;
  }

  if (parsed.cmd === "once") {
    const chatId = argValue(parsed.args, "--chat") ?? Array.from(config.allowedChatIds)[0] ?? DEFAULT_LOCAL_CHAT_ID;
    const sessionTarget = argValue(parsed.args, "--session");
    const at = argValue(parsed.args, "--at");
    const prompt = argValue(parsed.args, "--prompt");

    if (!sessionTarget || !at || !prompt) {
      console.error("Missing --session, --at or --prompt");
      usage();
      process.exit(1);
      return;
    }

    try {
      sessionStore.ensureSessionForTarget(chatId, sessionTarget);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
      return;
    }

    const oneShot = buildOneShotCron(at);
    const job = await cronStore.create({
      chatId,
      sessionTarget,
      cron: oneShot.cron,
      prompt,
      runOnce: true
    });

    console.log(`Created one-shot ${job.id}`);
    console.log(`runAt=${oneShot.runAt.toISOString()}`);
    console.log(`next=${job.nextRunAt}`);
    return;
  }

  const id = parsed.args[0];
  if (!id) {
    usage();
    process.exit(1);
    return;
  }

  if (parsed.cmd === "remove") {
    const ok = await cronStore.remove(id);
    console.log(ok ? `Removed ${id}` : `Not found: ${id}`);
    return;
  }

  if (parsed.cmd === "enable") {
    const job = await cronStore.setEnabled(id, true);
    console.log(job ? `Enabled ${id}` : `Not found: ${id}`);
    return;
  }

  if (parsed.cmd === "disable") {
    const job = await cronStore.setEnabled(id, false);
    console.log(job ? `Disabled ${id}` : `Not found: ${id}`);
    return;
  }
}

if (require.main === module) {
  void startCronCli();
}
