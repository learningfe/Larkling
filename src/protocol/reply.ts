import type { FinalReply, SessionKind } from "./types.js";

const NOTIFY_LINE = /^[ \t]*\[\[notify[ \t]+([A-Za-z0-9_-]+)\]\][ \t]*$/;

/** A notify directive is only that pattern filling one line. The id is a task id, never a person. */
function notifyTaskId(line: string): string | undefined {
  return NOTIFY_LINE.exec(line)?.[1];
}

/**
 * Conversation: the whole reply is silent only when it equals `[[silent]]`.
 * `[[notify <taskId>]]` opts in only when it is the last non-empty line.
 * A marker earlier in the reply is ordinary text: quoting one must not @ anyone.
 * When the last line is the directive, that line and any other whole-line markers
 * are removed. The task id is the last line's id. People are not read from the line.
 */
export function parseConversationReply(text: string): FinalReply {
  if (text.trim() === "[[silent]]") return { kind: "silent" };
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  const taskId = end > 0 ? notifyTaskId(lines[end - 1]) : undefined;
  if (!taskId) return { kind: "text", text };
  const kept = lines.slice(0, end - 1).filter((line) => !notifyTaskId(line));
  const cleaned = kept.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { kind: "text", text: cleaned, notifyTaskId: taskId };
}

/**
 * Check sessions: first line QUIET stays quiet. Anything else, including an
 * explicit WAKE or an unexpected line, wakes.
 */
export function parseCheckReply(text: string): "wake" | "quiet" {
  const first = text.trim().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  return first === "QUIET" ? "quiet" : "wake";
}

/** Judge sessions: only an explicit RESPOND responds. Uncertainty is IGNORE. */
export function parseJudgeReply(text: string): "respond" | "ignore" {
  const first = text.trim().split(/\r?\n/, 1)[0]?.trim().toUpperCase();
  return first === "RESPOND" ? "respond" : "ignore";
}

/** Task sessions: the whole completion text is the result and is not delivered. */
export function parseTaskReply(text: string): string {
  return text;
}

export function parseReply(kind: SessionKind, text: string): FinalReply | "wake" | "quiet" | "respond" | "ignore" | string {
  switch (kind) {
    case "conversation":
      return parseConversationReply(text);
    case "check":
      return parseCheckReply(text);
    case "judge":
      return parseJudgeReply(text);
    case "task":
      return parseTaskReply(text);
    case "compact":
      return text.trim();
    default:
      return text;
  }
}
