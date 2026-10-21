import type { LarklingConfig } from "../config.js";
import type { Actor, Scope, Trust } from "../protocol/types.js";

const RANK: Record<Trust, number> = { denied: 0, allowed: 1, owner: 2 };

export function trustAtLeast(trust: Trust, minimum: Trust): boolean {
  return RANK[trust] >= RANK[minimum];
}

/**
 * Ingress role for one actor in one scope.
 *
 * Owner always passes. There is no global person allowlist. A DM is allowed for
 * anyone who can message the bot. An ordinary group, and a topic under it, is
 * open to humans and bots. `trust.restricted` is a per-chat allowlist: when a
 * chat id is listed, only the owner and the ids written for that chat may enter
 * it. A topic uses its own list when present, otherwise its parent group's list.
 * A missing scope is not a chat, so only the owner passes. Mention policy and
 * `session.botChainLimit` are decided elsewhere. `isBot` does not change this.
 */
export function resolveTrust(actor: Actor, scope: Scope | undefined, config: LarklingConfig): Trust {
  if (actor.stableId === config.owner) return "owner";
  if (!scope) return "denied";
  if (scope.kind === "dm") return "allowed";
  const members = restrictedMembers(scope, config.trust.restricted);
  if (!members) return "allowed";
  return members.some((member) => memberMatches(actor, member)) ? "allowed" : "denied";
}

/** Own chat id wins. A topic with no entry of its own inherits the parent group. */
function restrictedMembers(scope: Scope, restricted: Record<string, string[]>): string[] | undefined {
  if (Object.hasOwn(restricted, scope.id)) return restricted[scope.id];
  if (scope.kind === "topic" && scope.parentId && Object.hasOwn(restricted, scope.parentId)) return restricted[scope.parentId];
  return undefined;
}

/** `feishu:ou_…` and a bare `ou_…` both match. Other stable ids match exactly. */
function memberMatches(actor: Actor, member: string): boolean {
  const id = member.trim();
  if (!id) return false;
  if (id === actor.stableId || id === actor.ref) return true;
  if (id.startsWith("ou_")) return actor.stableId === `feishu:${id}`;
  if (id.startsWith("feishu:")) return actor.ref === id.slice("feishu:".length);
  return false;
}
