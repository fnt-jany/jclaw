export type OneShotCron = {
  cron: string;
  runAt: Date;
};

export function buildOneShotCron(at: string, now = new Date()): OneShotCron {
  const runAt = new Date(at);
  if (Number.isNaN(runAt.getTime())) {
    throw new Error("Invalid --at value. Use ISO date-time, e.g. 2026-02-21T16:00:00+09:00");
  }

  runAt.setSeconds(0, 0);

  if (runAt.getTime() <= now.getTime()) {
    throw new Error("--at must be a future date-time (minute precision)");
  }

  const minute = runAt.getMinutes();
  const hour = runAt.getHours();
  const day = runAt.getDate();
  const month = runAt.getMonth() + 1;

  // Day-of-week is wildcard; worker disables run-once jobs after first execution.
  const cron = `${minute} ${hour} ${day} ${month} *`;
  return { cron, runAt };
}
