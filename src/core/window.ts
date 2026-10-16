import type { ImRecord } from "../protocol/types.js";
import { estimateTokens } from "../util/tokens.js";

export function selectWindow(
  messages: ImRecord[],
  options: { limit: number; maxTokens: number; root?: ImRecord; maxAgeMs?: number; now?: number },
): ImRecord[] {
  const fresh =
    options.maxAgeMs != null && options.now != null ? messages.filter((item) => withinAge(item, options.now as number, options.maxAgeMs as number)) : messages;
  const sorted = [...fresh].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.messageId.localeCompare(b.messageId));
  const root =
    options.root && (options.maxAgeMs == null || options.now == null || withinAge(options.root, options.now, options.maxAgeMs)) ? options.root : undefined;
  const rest = root ? sorted.filter((item) => item.messageId !== root.messageId) : sorted;
  const tail = rest.slice(-options.limit);
  const selected = root ? [root, ...tail] : tail;
  return fitTokens(selected, options.maxTokens, root?.messageId);
}

/** Unparseable timestamps stay in the window. */
function withinAge(item: ImRecord, now: number, maxAgeMs: number): boolean {
  const at = Date.parse(item.occurredAt);
  if (Number.isNaN(at)) return true;
  return at >= now - maxAgeMs;
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
 * Messages strictly after the bot's last in-window utterance and before the
 * triggering messages. No bot utterance in the window means nothing is unread.
 */
export function unreadCount(window: ImRecord[], triggeringIds: string[], isBot: (record: ImRecord) => boolean): number {
  const triggerAt = window.findIndex((item) => triggeringIds.includes(item.messageId));
  const end = triggerAt >= 0 ? triggerAt : window.length;
  let botAt = -1;
  for (let index = 0; index < end; index++) {
    if (isBot(window[index])) botAt = index;
  }
  if (botAt < 0) return 0;
  const start = botAt + 1;
  if (start >= end) return 0;
  return end - start;
}
