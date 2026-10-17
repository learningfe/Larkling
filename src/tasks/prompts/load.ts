import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Read one fixed role prompt. The file is the prompt; nothing is interpolated. */
export function readPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(join(dir, `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}
