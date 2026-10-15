import type { Seed, TranscriptEntry } from "./types.js";
import { estimateTokens } from "../util/tokens.js";

/**
 * Build a seed from the active transcript (entries after the latest compaction).
 * Keeps the newest entries that fit in `maxTokens`.
 */
export function buildSeed(entries: TranscriptEntry[], maxTokens: number): Seed {
  const active = activeEntries(entries);
  const chosen: TranscriptEntry[] = [];
  let tokens = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const line = renderEntry(active[i]);
    const cost = estimateTokens(line);
    if (chosen.length > 0 && tokens + cost > maxTokens) break;
    if (chosen.length === 0 && cost > maxTokens) {
      chosen.push(active[i]);
      tokens = maxTokens;
      break;
    }
    chosen.push(active[i]);
    tokens += cost;
  }
  chosen.reverse();
  const text = chosen.map(renderEntry).join("\n");
  return {
    text,
    throughSeq: chosen.at(-1)?.seq ?? 0,
    estimatedTokens: estimateTokens(text),
  };
}

export function activeEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  let through = 0;
  let summary: TranscriptEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "compacted" && entry.throughSeq >= through) {
      through = entry.throughSeq;
      summary = entry;
    }
  }
  const rest = entries.filter((entry) => entry !== summary && entry.seq > through);
  return summary ? [summary, ...rest] : rest;
}

export function transcriptTokens(entries: TranscriptEntry[]): number {
  return activeEntries(entries).reduce((sum, entry) => sum + estimateTokens(renderEntry(entry)), 0);
}

function renderEntry(entry: TranscriptEntry): string {
  switch (entry.type) {
    case "turn.started":
      return `# turn ${entry.turnId ?? ""} started (${entry.trigger})`;
    case "inbound":
      return `${entry.actor.name}: ${entry.text}`;
    case "recalled":
      return `[recalled ${entry.messageId}]`;
    case "reply":
      return entry.reply.kind === "silent" ? "[silent]" : `assistant: ${entry.reply.text}`;
    case "task_event":
      return `[task ${entry.taskId} ${entry.reason}] ${entry.text}`;
    case "task_result":
      return `result: ${entry.text}`;
    case "approval":
      return `[approval ${entry.approvalId} ${entry.decision ?? "pending"}] ${entry.summary}`;
    case "turn.ended":
      return `# turn ended ${entry.outcome}${entry.error ? ` ${entry.error}` : ""}`;
    case "compacted":
      return `Summary through #${entry.throughSeq}:\n${entry.summary}`;
    default:
      return JSON.stringify(entry);
  }
}
