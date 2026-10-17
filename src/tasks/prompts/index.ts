/**
 * Built-in system prompts, one fixed Markdown file per role.
 * Check uses the heartbeat prompt.
 */
export { withFile } from "./shared.js";
export { readPrompt } from "./load.js";

import { readPrompt } from "./load.js";

export function frontInstructions(): string {
  return readPrompt("front");
}

export function backInstructions(): string {
  return readPrompt("back");
}

export function heartbeatInstructions(): string {
  return readPrompt("heartbeat");
}

/** Check sessions use the heartbeat prompt. */
export const checkInstructions = heartbeatInstructions;

export function relevanceInstructions(): string {
  return readPrompt("relevance");
}

/** @deprecated Prefer relevanceInstructions. */
export const judgeInstructions = relevanceInstructions;

export function compactInstructions(): string {
  return readPrompt("compact");
}
