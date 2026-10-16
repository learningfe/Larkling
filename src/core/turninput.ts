import type { ImRecord, Scope } from "../protocol/types.js";

export interface TurnPerson {
  openId: string;
  name: string;
  isSelf: boolean;
}

export interface TurnMessage {
  messageId: string;
  sender: TurnPerson;
  at: string;
  mentions: TurnPerson[];
  body: string;
}

export interface StructuredTurn {
  turn: { kind: string; cold: boolean; scope: { kind: Scope["kind"]; id: string; name?: string } };
  history:
    | { mode: "full"; range: { from: string; to: string } | null; messages: TurnMessage[] }
    | { mode: "incremental"; since: string; newCount: number; messages: TurnMessage[] };
  trigger: TurnMessage[];
}

/** Per-session high-water mark for incremental history. Reset on cold start. */
export interface HistoryMark {
  runtimeRef: string;
  highMs: number;
  seen: Set<string>;
}

export function recordMs(record: ImRecord): number {
  const ms = Date.parse(record.occurredAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Keep only messages not yet delivered: unseen ids at or after the high-water
 * millisecond (start_time is floored to the second, so the same second comes
 * back and is dropped here, never by adding a second).
 */
export function newSince(records: ImRecord[], mark: HistoryMark): ImRecord[] {
  return records.filter((record) => !mark.seen.has(record.messageId) && recordMs(record) >= mark.highMs);
}

export function advanceMark(mark: HistoryMark, delivered: ImRecord[]): void {
  for (const record of delivered) {
    mark.seen.add(record.messageId);
    mark.highMs = Math.max(mark.highMs, recordMs(record));
  }
  // Only ids in the high-water second can come back; forget older ones.
  if (mark.seen.size > 500) mark.seen = new Set(delivered.filter((record) => recordMs(record) >= mark.highMs - 1000).map((record) => record.messageId));
}

export function localIso(occurredAt: string | number, timeZone: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return String(occurredAt);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = pick("timeZoneName").replace("GMT", "") || "+00:00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}${offset}`;
}

export function toTurnMessage(
  record: ImRecord,
  options: { timeZone: string; now?: Date; isSelf: (ref: string, record?: ImRecord) => boolean; nameOf: (record: ImRecord) => string },
): TurnMessage {
  const at = shortLocal(record.occurredAt, options.timeZone, options.now ?? new Date());
  return {
    messageId: record.messageId,
    sender: { openId: record.actor.ref, name: options.nameOf(record), isSelf: options.isSelf(record.actor.ref, record) },
    at,
    mentions: (record.mentions ?? []).map((mention) => ({ openId: mention.ref, name: mention.name, isSelf: mention.ref !== "all" && options.isSelf(mention.ref) })),
    body: record.text,
  };
}

/** "09:55:10" today, "10-15 09:55:10" this year, otherwise the full date. */
export function shortLocal(occurredAt: string, timeZone: string, now: Date): string {
  const full = localIso(occurredAt, timeZone);
  if (full === occurredAt && Number.isNaN(Date.parse(occurredAt))) return occurredAt;
  const today = localIso(now.getTime(), timeZone);
  const date = full.slice(0, 10);
  const time = full.slice(11, 19);
  if (date === today.slice(0, 10)) return time;
  if (date.slice(0, 4) === today.slice(0, 4)) return `${date.slice(5)} ${time}`;
  return `${date} ${time}`;
}
