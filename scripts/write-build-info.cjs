const fs = require("node:fs");
const path = require("node:path");

const buildTimeIso = new Date().toISOString();
const target = path.join(__dirname, "..", "src", "generated", "buildInfo.ts");

const content = [
  "// Auto-generated during build. Do not edit manually.",
  `export const BUILD_TIME_ISO = ${JSON.stringify(buildTimeIso)};`,
  ""
].join("\n");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, content, "utf8");
console.log(`[build-info] wrote ${target} (${buildTimeIso})`);
