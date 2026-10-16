/**
 * Built-in system prompts, split by role:
 * - FRONT: conversation agent
 * - BACK: background task worker
 * - HEARTBEAT: followed-task wake check
 * - RELEVANCE: gate whether FRONT should reply
 */
export { MESSAGE_NOTES, withFile } from "./shared.js";
export { frontInstructions } from "./front.js";
export { backInstructions } from "./back.js";
export { heartbeatInstructions, checkInstructions } from "./heartbeat.js";
export { relevanceInstructions, judgeInstructions } from "./relevance.js";
export { compactInstructions } from "./compact.js";
