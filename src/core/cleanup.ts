import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function purgeOldFiles(directory: string, olderThanMs: number, now: number): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    if (now - info.mtimeMs >= olderThanMs) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}
