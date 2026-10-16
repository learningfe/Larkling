import type { LarklingConfig } from "../config.js";
import type { Actor, Scope, Trust } from "../protocol/types.js";

const RANK: Record<Trust, number> = { denied: 0, allowed: 1, trusted: 2, owner: 3 };

export function trustAtLeast(trust: Trust, minimum: Trust): boolean {
  return RANK[trust] >= RANK[minimum];
}

/**
 * Ingress role for one actor in one scope.
 *
 * Owner always passes. `trusted` and `allowed` are one personal allowlist here;
 * the returned label still records which list matched. Anyone else is allowed
 * in an ordinary group — human or bot — and denied in a DM, a topic with no
 * group parent, or a chat id listed in `trust.restricted`. A topic inherits
 * its parent group's mode. Mention policy and `session.botChainLimit` are
 * decided elsewhere.
 */
export function resolveTrust(actor: Actor, scope: Scope | undefined, config: LarklingConfig): Trust {
  if (actor.stableId === config.owner) return "owner";
  if (config.trust.trusted.includes(actor.stableId)) return "trusted";
  if (config.trust.allowed.includes(actor.stableId)) return "allowed";
  if (!scope) return "denied";
  const chatId = groupChatId(scope);
  if (!chatId) return "denied";
  if (config.trust.restricted.includes(chatId) || config.trust.restricted.includes(scope.id)) return "denied";
  return "allowed";
}

/**
 * Group chat whose openness this scope inherits.
 * Feishu topics carry the parent chat id; a topic without one is not group-backed.
 */
function groupChatId(scope: Scope): string | undefined {
  if (scope.kind === "group") return scope.id;
  if (scope.kind === "topic" && scope.parentId) return scope.parentId;
  return undefined;
}
