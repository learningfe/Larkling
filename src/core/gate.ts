import type { LarklingConfig } from "../config.js";
import type { Logger } from "../log.js";
import { conversationSessionId, type MessageEvent, type Scope, type Trust } from "../protocol/types.js";
import type { Clock } from "./clock.js";

export type GateDecision = "allow" | "skip";
export type GateDecisionSource = "judge" | "short_circuit";

/**
 * One `gate.decision` line per allow or skip.
 * `reason` is a stable code when the model was not called, and the judge's
 * raw text when it was. Callers must not replace that text with a summary.
 */
export function logGateDecision(
  log: Logger,
  input: {
    scope: Scope;
    messages: MessageEvent[];
    decision: GateDecision;
    reason: string;
    mode: "mention" | "relevant";
    source: GateDecisionSource;
    error?: string;
  },
): void {
  const senderIds = input.messages.map((message) => message.actor.stableId);
  const uniqueSenders = [...new Set(senderIds)];
  log.info("gate.decision", {
    sessionId: conversationSessionId(input.scope),
    chatId: input.scope.id,
    scopeKind: input.scope.kind,
    ...(input.scope.parentId ? { parentId: input.scope.parentId } : {}),
    messageIds: input.messages.map((message) => message.messageId),
    decision: input.decision,
    reason: input.reason,
    mode: input.mode,
    mentionsSelf: input.messages.some((message) => message.mentionsSelf),
    ...(uniqueSenders.length === 1 ? { senderId: uniqueSenders[0] } : {}),
    senderIds,
    source: input.source,
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

export interface PendingBatch {
  key: string;
  scope: Scope;
  messages: MessageEvent[];
  deadline: number;
}

/**
 * Relevance gate. Mentions and DMs skip it. Other group messages are dropped,
 * or debounced and judged when the scope is relevant. A topic the bot has
 * already replied in is relevant unless config names that scope explicitly.
 * Debounce is trailing: the deadline moves to now + debounce on every arrival.
 * Each allow and skip is logged as `gate.decision`. Buffering is not a decision.
 */
export class Gate {
  private pending = new Map<string, PendingBatch>();

  constructor(
    private readonly config: LarklingConfig,
    private readonly readGroupMessages: boolean,
    private readonly clock: Clock,
    private readonly participated: () => readonly string[] = () => [],
    private readonly log?: Logger,
  ) {}

  modeFor(scope: Scope): "mention" | "relevant" {
    const explicit = this.config.im.respondTo.scopes[scope.id] ?? (scope.parentId ? this.config.im.respondTo.scopes[scope.parentId] : undefined);
    if (explicit) return explicit;
    if (scope.kind === "topic" && this.participated().includes(scope.id)) return "relevant";
    return this.config.im.respondTo.default;
  }

  /**
   * Messages returned here are delivered now. `null` means the event was
   * buffered or dropped. Store-only and unsupported messages never reach the gate.
   */
  accept(event: MessageEvent, trust: Trust): MessageEvent[] | "buffered" | "dropped" {
    if (event.scope.kind === "dm" || event.mentionsSelf) {
      this.logShortCircuit(event, "allow", event.scope.kind === "dm" ? "dm" : "mention");
      return [event];
    }
    if (!this.readGroupMessages) {
      this.logShortCircuit(event, "skip", "group_read_disabled");
      return "dropped";
    }
    if (this.modeFor(event.scope) !== "relevant") {
      this.logShortCircuit(event, "skip", "mention_required");
      return "dropped";
    }
    if (event.actor.isBot && trust !== "owner" && trust !== "trusted") {
      this.logShortCircuit(event, "skip", "bot_sender");
      return "dropped";
    }
    if (event.mentionsOthers && !event.mentionsSelf) {
      this.logShortCircuit(event, "skip", "mentions_others");
      return "dropped";
    }
    const key = `${event.scope.channel}:${event.scope.kind}:${event.scope.id}`;
    const existing = this.pending.get(key);
    const deadline = this.clock.now() + this.config.im.gate.debounceMs;
    if (existing) {
      existing.messages.push(event);
      existing.deadline = deadline;
    } else {
      this.pending.set(key, { key, scope: event.scope, messages: [event], deadline });
    }
    return "buffered";
  }

  /** Batches whose trailing debounce has elapsed. They leave the buffer. */
  due(now = this.clock.now()): PendingBatch[] {
    const ready: PendingBatch[] = [];
    for (const [key, batch] of this.pending) {
      if (batch.deadline <= now) {
        ready.push(batch);
        this.pending.delete(key);
      }
    }
    return ready;
  }

  restore(batch: PendingBatch): void {
    const existing = this.pending.get(batch.key);
    if (existing) {
      existing.messages.unshift(...batch.messages);
      return;
    }
    this.pending.set(batch.key, batch);
  }

  bufferedCount(): number {
    let count = 0;
    for (const batch of this.pending.values()) count += batch.messages.length;
    return count;
  }

  private logShortCircuit(event: MessageEvent, decision: GateDecision, reason: string): void {
    if (!this.log) return;
    logGateDecision(this.log, {
      scope: event.scope,
      messages: [event],
      decision,
      reason,
      mode: this.modeFor(event.scope),
      source: "short_circuit",
    });
  }
}
