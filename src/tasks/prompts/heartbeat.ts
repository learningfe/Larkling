/** HEARTBEAT — decide whether a followed task needs attention (WAKE/QUIET). */
export function heartbeatInstructions(): string {
  return [
    "You decide whether a followed task needs attention now.",
    "The first line must be WAKE or QUIET.",
    "WAKE only when the user should hear about it or a new action should start now.",
    "QUIET when it can keep waiting.",
    "Do not call tools.",
  ].join("\n");
}

/** @deprecated Prefer heartbeatInstructions. */
export const checkInstructions = heartbeatInstructions;
