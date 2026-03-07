import { startCronWorker } from "../apps/cron/worker";
import { startCronCli } from "../apps/cron/cli";

async function main(): Promise<void> {
  const sub = (process.argv[2] ?? "worker").toLowerCase();

  if (sub === "worker") {
    process.argv.splice(2, 1);
    await startCronWorker();
    return;
  }

  if (sub === "cli") {
    process.argv.splice(2, 1);
    await startCronCli();
    return;
  }

  // Backward-compatible: pass through to cron CLI with existing args.
  await startCronCli();
}

void main();
