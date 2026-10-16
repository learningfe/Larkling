import type { Actor, ChannelAdapter, ChannelEvent, DeliveryResult, HealthItem, ImRecord, OutboundAction, Profile, Scope } from "../protocol/types.js";
import { AsyncQueue } from "../util/async-queue.js";

/** In-memory channel for tests and local dry runs. */
export class MemoryChannel implements ChannelAdapter {
  readonly channel = "memory";
  readonly capabilities: { readGroupMessages: boolean };
  readonly sent: { action: OutboundAction; result: DeliveryResult }[] = [];
  histories = new Map<string, ImRecord[]>();
  files = new Map<string, string>();
  profiles = new Map<string, Profile>();
  private readonly queue = new AsyncQueue<ChannelEvent>();
  private sequence = 0;

  constructor(readGroupMessages = true) {
    this.capabilities = { readGroupMessages };
  }

  push(event: ChannelEvent): void {
    this.queue.push(event);
  }

  events(): AsyncIterable<ChannelEvent> {
    return this.queue;
  }

  async send(action: OutboundAction): Promise<DeliveryResult> {
    const result: DeliveryResult = { ok: true, messageId: `mem_${++this.sequence}` };
    this.sent.push({ action, result });
    return result;
  }

  async profile(target: Scope | Actor): Promise<Profile | undefined> {
    const id = "stableId" in target ? target.ref : target.id;
    return this.profiles.get(id);
  }

  async history(q: { container: string; start?: string; end?: string; limit: number; withRoot?: boolean }): Promise<ImRecord[]> {
    let records = [...(this.histories.get(q.container) ?? [])];
    if (q.start) records = records.filter((item) => item.occurredAt >= q.start!);
    if (q.end) records = records.filter((item) => item.occurredAt <= q.end!);
    return records.slice(-q.limit);
  }

  async download(ref: { key: string }): Promise<string> {
    const path = this.files.get(ref.key);
    if (!path) throw new Error(`missing file ${ref.key}`);
    return path;
  }

  async health(): Promise<HealthItem[]> {
    return [{ name: "memory", ok: true }];
  }

  close(): void {
    this.queue.close();
  }
}
