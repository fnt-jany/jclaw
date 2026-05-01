import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

type LoadDotenvOptions = {
  path?: string;
  override?: boolean;
};

export function loadDotenvIntoProcessEnv(options: LoadDotenvOptions = {}): void {
  const envPath = path.resolve(options.path ?? ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (options.override || process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}
