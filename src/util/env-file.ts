import { readFileSync, existsSync } from "node:fs";

/**
 * Minimal .env parser (KEY=value, optional quotes, # comments). Deliberately dependency-free.
 * Values already present in process.env win — this never overrides the real environment.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(path)) return false;
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) env[k] = v;
  }
  return true;
}
