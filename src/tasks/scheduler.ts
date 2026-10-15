import type { SessionRecord, TaskRecord } from "../protocol/types.js";

/** A followed task is checked only when every heartbeat condition holds. */
export function heartbeatDue(task: TaskRecord, parent: SessionRecord | undefined, nowMs: number, intervalMs: number): boolean {
  if (!task.followUpEnabled) return false;
  if (task.status === "cancelled" || task.status === "cancelling") return false;
  if (task.pendingEvent) return false;
  if (!parent || parent.phase !== "idle") return false;
  const since = Date.parse(task.lastCheck?.at ?? task.createdAt);
  if (Number.isNaN(since)) return false;
  return nowMs - since >= intervalMs;
}

export function slotsUsed(tasks: Record<string, TaskRecord>): number {
  return Object.values(tasks).filter((task) => task.status === "queued" || task.status === "running" || task.status === "cancelling").length;
}
