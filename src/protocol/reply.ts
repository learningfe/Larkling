import type { FinalReply, SessionKind } from "./types.js";

/** Conversation: the whole reply is silent only when it equals `[[silent]]`. */
export function parseConversationReply(text: string): FinalReply {
  if (text.trim() === "[[silent]]") return { kind: "silent" };
  return { kind: "text", text };
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
