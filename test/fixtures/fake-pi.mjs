// Fake `pi --mode rpc` (pi 1.x protocol) for adapter tests. Speaks LF-delimited JSON on stdin/stdout.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_PI_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : `${args[args.indexOf("--session-dir") + 1]}/fake-${process.pid}.jsonl`;
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let streaming = false;
let buffer = "";

function run(text) {
  streaming = true;
  out({ type: "agent_start" });
  out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } });
  out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false });
  if (text.includes("hang")) return;
  // U+2028 is valid inside JSON strings; a readline-based client would split here.
  const reply = `echo\u2028${text.slice(-5)}`;
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
  const message = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: text.includes("fail") ? "error" : "stop", errorMessage: text.includes("fail") ? "429 rate limit" : undefined };
  out({ type: "message_end", message });
  streaming = false;
  out({ type: "agent_end", messages: [message], willRetry: false });
  out({ type: "agent_settled", aborted: false });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (log) appendFileSync(log, `${JSON.stringify({ command })}\n`);
    if (command.type === "get_state") out({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionFile, isStreaming: streaming } });
    else if (command.type === "prompt") {
      out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      run(command.message);
    } else if (command.type === "abort") {
      out({ id: command.id, type: "response", command: "abort", success: true });
      streaming = false;
      out({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }], willRetry: false });
      out({ type: "agent_settled", aborted: true });
    } else out({ id: command.id, type: "response", command: command.type, success: true });
  }
});
process.stdin.on("end", () => process.exit(0));
