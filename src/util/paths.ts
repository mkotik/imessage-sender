import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}
