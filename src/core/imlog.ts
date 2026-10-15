import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, ImRecord, Scope } from "../protocol/types.js";
import { appendLine } from "../util/fs.js";
import { scopeFileKey } from "../util/id.js";

export interface StoredMessage extends ImRecord {
  container: string;
  fromBot: boolean;
  disposition: "normal" | "store_only" | "unsupported";
  trust?: string;
}

/**
 * Messages kept for this bot: mentions, the bot's own sends, and every message
 * in a topic the bot has already joined. Platform history reads are not written back.
 */
export class ImLog {
  constructor(private readonly dir: string) {}

  private path(container: string): string {
    return join(this.dir, "im", `${scopeFileKey(container)}.jsonl`);
  }

  async append(message: StoredMessage): Promise<void> {
    await appendLine(this.path(message.container), JSON.stringify(message));
  }

  async load(container: string): Promise<StoredMessage[]> {
    try {
      const text = await readFile(this.path(container), "utf8");
      const byId = new Map<string, StoredMessage>();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as StoredMessage;
        byId.set(record.messageId, record);
      }
      return [...byId.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async recall(container: string, messageId: string, at: string): Promise<void> {
    const existing = (await this.load(container)).find((item) => item.messageId === messageId);
    if (!existing) return;
    await this.append({ ...existing, recalled: true, text: "[已撤回]", occurredAt: existing.occurredAt || at });
  }

  async lastBotMessage(container: string, bot: { ref?: string; stableId?: string }): Promise<StoredMessage | undefined> {
    const records = await this.load(container);
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].recalled) continue;
      if (isBotMessage(records[i], bot)) return records[i];
    }
    return undefined;
  }

  shouldStore(message: { scope: Scope; mentionsSelf: boolean; fromBot: boolean }, participatedTopics: string[]): boolean {
    if (message.mentionsSelf || message.fromBot) return true;
    return message.scope.kind === "topic" && participatedTopics.includes(message.scope.id);
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    const directory = join(this.dir, "im");
    let removed = 0;
    let files: string[] = [];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const file of files) {
      const container = file.replace(/\.jsonl$/, "");
      const records = await this.load(container);
      const kept = records.filter((item) => item.occurredAt >= cutoffIso);
      removed += records.length - kept.length;
      if (kept.length !== records.length) {
        await rm(join(directory, file), { force: true });
        for (const record of kept) await this.append(record);
      }
    }
    return removed;
  }
}

export function isBotMessage(message: { fromBot: boolean; actor: Actor }, bot: { ref?: string; stableId?: string }): boolean {
  if (message.fromBot) return true;
  if (bot.stableId && message.actor.stableId === bot.stableId) return true;
  if (bot.ref && message.actor.ref === bot.ref && message.actor.isBot) return true;
  return false;
}
