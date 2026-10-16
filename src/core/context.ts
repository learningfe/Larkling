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
  /** Structured turn input (JSON); replaces the rendered window when set. */
  turnJson?: string;
  unread?: string;
  batch: QueuedInput[];
  tasks: TaskRecord[];
  apiUrl: string;
  token: string;
  sessionId: string;
  cli?: string[];
  /** When true, task_start / task_cancel are dedicated tools; omit them from Commands. */
  frontTaskTools?: boolean;
}): string {
  const lines = [
    `Now: ${options.now}`,
    `Scope: ${options.scope.channel} ${options.scope.kind} ${options.scope.id}`,
    `Task API: ${options.apiUrl}`,
    `Token: ${options.token}`,
    `Session: ${options.sessionId}`,
  ];
  if (options.cli) lines.push(commandsBlock({ cli: options.cli, apiUrl: options.apiUrl, token: options.token, container: options.scope.id, role: "front", frontTaskTools: options.frontTaskTools }));
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
  if (options.turnJson) lines.push(`Turn input:\n${options.turnJson}`);
  return lines.join("\n\n");
}

export function taskContext(options: {
  body: string;
  apiUrl: string;
  token: string;
  parentContainer?: string;
  cli?: string[];
  taskId?: string;
  version?: number;
  /** When true, back tools replace the Commands block. */
  backTaskTools?: boolean;
}): string {
  const lines = [
    "Task body:",
    options.body,
    "",
    options.taskId ? `Task id: ${options.taskId}` : "",
    options.version != null ? `Task version: ${options.version}` : "",
    `Task API: ${options.apiUrl}`,
    `Token: ${options.token}`,
    options.parentContainer ? `Parent container: ${options.parentContainer}` : "",
  ];
  if (options.cli && !options.backTaskTools) {
    lines.push("", commandsBlock({ cli: options.cli, apiUrl: options.apiUrl, token: options.token, container: options.parentContainer, role: "back" }));
  }
  return lines.filter((line) => line !== "").join("\n");
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

/** Quote one shell word only when it needs it. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ready-to-run command lines with the CLI path, API url, and session token
 * already filled in, so the agent never has to discover them.
 */
export function commandsBlock(options: { cli: string[]; apiUrl: string; token: string; container?: string; role: "front" | "back"; frontTaskTools?: boolean }): string {
  const cli = options.cli.map(shellWord).join(" ");
  const auth = `--api ${shellWord(options.apiUrl)} --token ${shellWord(options.token)}`;
  // Subcommands are positional, so the auth flags go after them.
  const run = (sub: string, rest: string) => `${cli} ${sub} ${auth} ${rest}`.trimEnd();
  const container = options.container ? shellWord(options.container) : "<container>";
  const frontTaskLines = options.frontTaskTools
    ? []
    : [
        `Start background work: ${run("task start", "--body '<goal / current progress / next step / recent notes>' [--follow-up]")}`,
        `Cancel a task: ${run("task cancel", "--task <taskId>")}`,
      ];
  const lines =
    options.role === "front"
      ? [
          ...frontTaskLines,
          `Continue a task: ${run("task continue", "--task <taskId> --message '<message>'")}`,
          `List tasks: ${run("task list", "")}`,
          `Read history: ${run("im history", `--container ${container} [--start <messageId>] [--end <messageId>] [--limit <n>]`)}`,
        ]
      : [
          `Update the task body: ${run("task update", "--task <taskId> --version <version> --body '<body>' [--follow-up]")}`,
          `Get the task: ${run("task get", "--task <taskId>")}`,
          `Read history: ${run("im history", `--container ${container} [--start <messageId>] [--end <messageId>] [--limit <n>]`)}`,
          `Fetch a file: ${run("im file", "--message <messageId> --key <fileKey>")}`,
          `Find a person: ${run("person lookup", "--open-id <ou_...> | --query '<name>' [--scope all]")}`,
          `Find a group: ${run("group lookup", "--chat-id <oc_...> | --query '<name>' [--members]")}`,
        ];
  return `Commands (run exactly as written; replace only <...> and drop unused [...]):\n${lines.join("\n")}`;
}
