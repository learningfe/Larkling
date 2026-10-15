import type { ImRecord } from "../protocol/types.js";
import { estimateTokens } from "../util/tokens.js";

export function selectWindow(
  messages: ImRecord[],
  options: { limit: number; maxTokens: number; root?: ImRecord },
): ImRecord[] {
  const sorted = [...messages].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.messageId.localeCompare(b.messageId));
  const root = options.root;
  const rest = root ? sorted.filter((item) => item.messageId !== root.messageId) : sorted;
  const tail = rest.slice(-options.limit);
  const selected = root ? [root, ...tail] : tail;
  return fitTokens(selected, options.maxTokens, root?.messageId);
}

function fitTokens(messages: ImRecord[], maxTokens: number, keepId?: string): ImRecord[] {
  const chosen = [...messages];
  const cost = () => chosen.reduce((sum, item) => sum + estimateTokens(item.text) + 8, 0);
  while (chosen.length > 1 && cost() > maxTokens) {
    const index = chosen.findIndex((item) => item.messageId !== keepId);
    if (index < 0) break;
    chosen.splice(index, 1);
  }
  return chosen;
}

/**
 * Messages strictly after the bot's last utterance and before the triggering
 * messages. When the last utterance is older than the window, every earlier
 * window message counts.
 */
export function unreadCount(window: ImRecord[], triggeringIds: string[], lastBotMessageId?: string): number {
  if (!lastBotMessageId) return 0;
  const triggerAt = window.findIndex((item) => triggeringIds.includes(item.messageId));
  const end = triggerAt >= 0 ? triggerAt : window.length;
  const botAt = window.findIndex((item) => item.messageId === lastBotMessageId);
  const start = botAt >= 0 ? botAt + 1 : 0;
  if (start >= end) return 0;
  return end - start;
}
