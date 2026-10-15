import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "../protocol/types.js";
import { appendLine } from "../util/fs.js";
import { scopeFileKey } from "../util/id.js";

export class TranscriptStore {
  constructor(private readonly dir: string) {}

  path(sessionId: string): string {
    return join(this.dir, "sessions", `${scopeFileKey(sessionId)}.jsonl`);
  }

  /** Append one JSON line and fsync before the caller advances lastSeq. */
  async append(sessionId: string, entry: TranscriptEntry): Promise<void> {
    await appendLine(this.path(sessionId), JSON.stringify(entry));
  }

  async load(sessionId: string): Promise<TranscriptEntry[]> {
    try {
      const text = await readFile(this.path(sessionId), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async maxSeq(sessionId: string): Promise<number> {
    const entries = await this.load(sessionId);
    return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
  }
}
