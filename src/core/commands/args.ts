export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string>;
};

export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  }
  return out.filter(Boolean);
}

export function parseArgs(input: string): ParsedArgs {
  const tokens = tokenizeArgs(input);
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const value = tokens[i + 1] ?? "";
      flags[key] = value;
      i += 1;
      continue;
    }
    positional.push(t);
  }

  return { positional, flags };
}
