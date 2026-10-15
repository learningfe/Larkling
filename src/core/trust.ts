import type { LarklingConfig } from "../config.js";
import type { Actor, Scope, Trust } from "../protocol/types.js";

const RANK: Record<Trust, number> = { denied: 0, allowed: 1, trusted: 2, owner: 3 };

export function trustAtLeast(trust: Trust, minimum: Trust): boolean {
  return RANK[trust] >= RANK[minimum];
}

/**
 * Config lists stable ids. Humans in `trust.groups` (or a topic whose parent
 * chat is listed) default to allowed. Bots default to denied unless listed.
 */
export function resolveTrust(actor: Actor, scope: Scope | undefined, config: LarklingConfig): Trust {
  if (actor.stableId === config.owner) return "owner";
  if (config.trust.trusted.includes(actor.stableId)) return "trusted";
  if (config.trust.allowed.includes(actor.stableId)) return "allowed";
  if (actor.isBot) return "denied";
  if (scope && (scope.kind === "group" || scope.kind === "topic")) {
    const chatId = scope.kind === "topic" ? scope.parentId ?? scope.id : scope.id;
    if (config.trust.groups.includes(chatId) || config.trust.groups.includes(scope.id)) return "allowed";
  }
  return "denied";
}
