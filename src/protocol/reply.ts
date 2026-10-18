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

/** Logged when the judge gave no usable one-sentence rationale. */
export const JUDGE_REASON_MISSING = "reason_missing";

const VERDICT_WORD = /^(respond|skip|ignore)\b[:：\-—]?/i;

/** Bare labels that name no thread and no gap. */
const EMPTY_REASONS = new Set([
  "相关",
  "无关",
  "有关",
  "不相关",
  "与话题无关",
  "与话题相关",
  "跟话题无关",
  "跟话题相关",
  "和话题无关",
  "和话题相关",
  "与当前话题无关",
  "与当前话题相关",
  "relevant",
  "irrelevant",
  "related",
  "unrelated",
  "on topic",
  "off topic",
  "on-topic",
  "off-topic",
  "not relevant",
]);

export interface JudgeReply {
  verdict: "respond" | "ignore";
  /** One short sentence, or `reason_missing`. */
  reason: string;
}

/**
 * Judge sessions: only an explicit RESPOND responds. Uncertainty, SKIP, and IGNORE stay ignore.
 * The reason is the one sentence after the verdict (or on the same line). Further sentences are dropped.
 * A missing reason, or a bare 相关/无关 label, is `reason_missing`.
 */
export function parseJudgeReply(text: string): JudgeReply {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const verdictWord = first.match(VERDICT_WORD);
  if (!verdictWord) return { verdict: "ignore", reason: JUDGE_REASON_MISSING };
  const verdict = verdictWord[1].toUpperCase() === "RESPOND" ? "respond" : "ignore";
  const sameLine = first.slice(verdictWord[0].length).replace(/^[\s:：\-—]+/, "").trim();
  const reasonLine = sameLine || lines[1] || "";
  const sentence = firstSentence(reasonLine);
  return { verdict, reason: usableReason(sentence) };
}

function firstSentence(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const cjk = trimmed.search(/[。！？!?]/);
  if (cjk !== -1) return trimmed.slice(0, cjk + 1).trim();
  const dot = trimmed.search(/\.(?:\s|$)/);
  if (dot !== -1) return trimmed.slice(0, dot + 1).trim();
  return trimmed;
}

function usableReason(sentence: string): string {
  const normalized = sentence
    .trim()
    .replace(/^[「"'“]+|[」"'”]+$/g, "")
    .replace(/[。！？!?.,，、\s]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!normalized || EMPTY_REASONS.has(normalized) || /^(respond|skip|ignore)$/i.test(normalized)) return JUDGE_REASON_MISSING;
  return sentence.trim();
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
      return parseJudgeReply(text).verdict;
    case "task":
      return parseTaskReply(text);
    case "compact":
      return text.trim();
    default:
      return text;
  }
}
