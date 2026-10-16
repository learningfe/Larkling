import type { QueuedInput, SessionPhase } from "../protocol/types.js";

export interface DeliveryCaps {
  steer: boolean;
}

/**
 * Arrival rule from the session state table.
 * Idle callers enqueue and then drain; this returns "enqueue" for idle too
 * when the caller batches, and "start" when a single arrival should open a turn.
 */
export function classifyArrival(phase: SessionPhase, caps: DeliveryCaps, input: QueuedInput): "steer" | "enqueue" {
  if (phase === "running" && caps.steer) return "steer";
  return "enqueue";
}

/**
 * User messages and prompts that sit next to each other merge into one start.
 * A task event is always its own start.
 */
export function takeBatch(queue: QueuedInput[]): { batch: QueuedInput[]; rest: QueuedInput[] } {
  if (queue.length === 0) return { batch: [], rest: [] };
  if (queue[0].kind === "task_event") return { batch: [queue[0]], rest: queue.slice(1) };
  let index = 0;
  while (index < queue.length && queue[index].kind !== "task_event") index += 1;
  return { batch: queue.slice(0, index), rest: queue.slice(index) };
}

export function withoutMessage(queue: QueuedInput[], messageId: string): QueuedInput[] {
  return queue.filter((item) => !(item.kind === "message" && item.messageId === messageId));
}

export function batchTrigger(batch: QueuedInput[]): "message" | "task_event" | "steer" {
  if (batch.length === 1 && batch[0].kind === "task_event") return "task_event";
  return "message";
}
