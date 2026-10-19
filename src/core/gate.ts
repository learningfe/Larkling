import type { LarklingConfig } from "../config.js";
import type { Clock } from "./clock.js";
import type { MessageEvent, Scope } from "../protocol/types.js";

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
 * Bot senders use the same rules as humans. `session.botChainLimit` is applied
 * before this gate.
 */
export class Gate {
  private pending = new Map<string, PendingBatch>();

  constructor(
    private readonly config: LarklingConfig,
    private readonly readGroupMessages: boolean,
    private readonly clock: Clock,
    private readonly participated: () => readonly string[] = () => [],
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
  accept(event: MessageEvent): MessageEvent[] | "buffered" | "dropped" {
    if (event.scope.kind === "dm" || event.mentionsSelf) return [event];
    if (!this.readGroupMessages) return "dropped";
    if (this.modeFor(event.scope) !== "relevant") return "dropped";
    if (event.mentionsOthers && !event.mentionsSelf) return "dropped";
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
}
