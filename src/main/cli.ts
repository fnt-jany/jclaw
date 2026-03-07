import { startCliOneShot } from "../apps/cli/oneShot";
import { startCliChat } from "../apps/cli/chat";

function usage(): never {
  console.error("Usage: npm run cli -- [one-shot args...] | npm run chat -- [chat args...]");
  process.exit(1);
}

async function main(): Promise<void> {
  const sub = (process.argv[2] ?? "oneshot").toLowerCase();

  if (sub === "chat") {
    process.argv.splice(2, 1);
    await startCliChat();
    return;
  }

  if (sub === "oneshot" || sub === "one-shot") {
    process.argv.splice(2, 1);
    await startCliOneShot();
    return;
  }

  // Backward-compatible: if no explicit subcommand is given, treat as one-shot args.
  if (process.argv[2]) {
    await startCliOneShot();
    return;
  }

  usage();
}

void main();
