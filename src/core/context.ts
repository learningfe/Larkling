import type { ImRecord, QueuedInput, Scope, TaskRecord } from "../protocol/types.js";
import { renderEnvelope } from "../channels/envelope.js";
import { unreadCount } from "./window.js";

export function renderWindow(
  records: ImRecord[],
  options: { timeZone: string; now?: Date; botRef?: string; botStableId?: string; nameOf: (record: ImRecord) => string },
): string {
  return records
    .map((record) =>
      renderEnvelope({
        name: options.nameOf(record),
        isSelf: isSelf(record, options.botRef, options.botStableId),
        occurredAt: record.occurredAt,
        messageId: record.messageId,
        body: record.text,
        timeZone: options.timeZone,
        now: options.now,
      }),
    )
    .join("\n\n");
}

export function isSelf(record: ImRecord, botRef?: string, botStableId?: string): boolean {
  if (record.actor.isBot && botRef && record.actor.ref === botRef) return true;
  if (botStableId && record.actor.stableId === botStableId) return true;
  return false;
}

export function unreadLine(records: ImRecord[], triggeringIds: string[], isBot: (record: ImRecord) => boolean): string | undefined {
  const count = unreadCount(records, triggeringIds, isBot);
  if (count <= 0) return undefined;
  return `Since you last spoke, ${count} new messages arrived here.`;
}

export function conversationContext(options: {
  scope: Scope;
  now: string;
  windowText: string;
  unread?: string;
  batch: QueuedInput[];
  tasks: TaskRecord[];
  apiUrl: string;
  token: string;
  sessionId: string;
}): string {
  const lines = [
    `Now: ${options.now}`,
    `Scope: ${options.scope.channel} ${options.scope.kind} ${options.scope.id}`,
    `Task API: ${options.apiUrl}`,
    `Token: ${options.token}`,
    `Session: ${options.sessionId}`,
  ];
  if (options.unread) lines.push(options.unread);
  const taskEvent = options.batch.find((item) => item.kind === "task_event");
  if (taskEvent && taskEvent.kind === "task_event") {
    lines.push(`Task event (${taskEvent.reason}) for ${taskEvent.taskId}:\n${taskEvent.text}`);
  }
  if (options.tasks.length) {
    const brief = options.tasks
      .map((task) => `- ${task.taskId} ${task.status} v${task.version} followUp=${task.followUpEnabled}\n${task.body}`)
      .join("\n");
    lines.push(`Tasks:\n${brief}`);
  }
  if (options.windowText) lines.push(`Recent messages:\n${options.windowText}`);
  return lines.join("\n\n");
}

export function taskContext(options: { body: string; apiUrl: string; token: string; parentContainer?: string }): string {
  return [
    "Task body:",
    options.body,
    "",
    `Task API: ${options.apiUrl}`,
    `Token: ${options.token}`,
    options.parentContainer ? `Parent container: ${options.parentContainer}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkContext(task: TaskRecord): string {
  return [
    "Task body:",
    task.body,
    "",
    task.lastCheck ? `Previous check at ${task.lastCheck.at}:\n${task.lastCheck.progress}` : "No previous check.",
    "",
    task.activity ? `Current activity:\n${task.activity}` : "No current activity.",
    `Task status: ${task.status}`,
  ].join("\n");
}

export function judgeContext(options: { persona: string; duty: string; root?: string; recent: string; candidates: string }): string {
  return [`Persona: ${options.persona}`, options.duty ? `Duty: ${options.duty}` : "", options.root ? `Topic root:\n${options.root}` : "", `Recent messages:\n${options.recent}`, `Candidates:\n${options.candidates}`]
    .filter(Boolean)
    .join("\n\n");
}
