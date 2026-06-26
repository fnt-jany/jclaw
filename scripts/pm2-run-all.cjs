const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pm2 = process.platform === "win32" ? "pm2.cmd" : "pm2";

const apps = [
  { name: "jclaw-web", script: "dist/main/web.js", args: [] },
  { name: "jclaw-telegram", script: "dist/main/telegram.js", args: [] },
  { name: "jclaw-cron", script: "dist/main/cron.js", args: ["worker"] }
];

function quoteForCmd(arg) {
  if (!/[ \t"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function spawnPm2(args, stdio) {
  if (process.platform !== "win32") {
    return spawnSync(pm2, args, {
      cwd: root,
      stdio,
      shell: false
    });
  }

  // Node can fail with EINVAL when spawning .cmd files directly on Windows.
  // Route through cmd.exe so pm2.cmd is resolved the same way it is in a shell.
  const commandLine = [pm2, ...args.map(quoteForCmd)].join(" ");
  return spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
    cwd: root,
    stdio,
    shell: false
  });
}

function run(args) {
  const result = spawnPm2(args, "inherit");
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

function exists(name) {
  const result = spawnPm2(["describe", name], "ignore");
  return (result.status ?? 1) === 0;
}

for (const app of apps) {
  if (exists(app.name)) {
    const code = run(["restart", app.name, "--update-env"]);
    if (code !== 0) process.exit(code);
    continue;
  }

  const args = ["start", app.script, "--name", app.name, "--cwd", root, "--update-env"];
  if (app.args.length > 0) {
    args.push("--", ...app.args);
  }

  const code = run(args);
  if (code !== 0) process.exit(code);
}
