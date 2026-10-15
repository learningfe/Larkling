import { describe, expect, it } from "vitest";
import { CodexRuntime, mapSandbox, toCodexInput } from "../src/runtimes/codex/adapter.js";
import { MemoryCodexTransport, StdioCodexTransport } from "../src/runtimes/codex/transport.js";
import type { RuntimeEvent, SessionSpec, TurnInput } from "../src/protocol/types.js";

function spec(partial: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: "memory:dm:ou_owner",
    kind: "conversation",
    profile: { model: "gpt", sandbox: "read-only", approvalPolicy: "never", cwd: "/tmp" },
    instructions: "be useful",
    ...partial,
  };
}

function input(text = "hello"): TurnInput {
  return { turnId: "turn-1", context: "Token: secret", messages: [{ text, images: [{ path: "/tmp/a.png" }] }] };
}

/** Reply to app-server requests the adapter has already written. */
function drive(transport: MemoryCodexTransport): () => void {
  let cursor = 0;
  let threads = 0;
  const timer = setInterval(() => {
    while (cursor < transport.sent.length) {
      const message = transport.sent[cursor++] as { id?: number; method?: string };
      if (message.id == null || !message.method || message.method === "initialized") continue;
      if (message.method === "initialize") transport.push({ id: message.id, result: { userAgent: "test" } });
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        threads += 1;
        transport.push({ id: message.id, result: { thread: { id: `th_${threads}` } } });
      } else if (message.method === "turn/start" || message.method === "turn/steer") {
        transport.push({ id: message.id, result: { turn: { id: `ct_${message.id}` } } });
      } else if (message.method === "turn/interrupt" || message.method === "thread/unsubscribe") {
        transport.push({ id: message.id, result: {} });
      } else transport.push({ id: message.id, error: { message: `unexpected ${message.method}` } });
    }
  }, 5);
  return () => clearInterval(timer);
}

async function take(events: RuntimeEvent[], type: RuntimeEvent["type"]): Promise<RuntimeEvent> {
  const started = Date.now();
  for (;;) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    if (Date.now() - started > 3000) throw new Error(`missing ${type}; saw ${events.map((event) => event.type).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("codex app-server adapter", () => {
  it("maps sandbox names and turn input", () => {
    expect(mapSandbox("read-only")).toBe("read-only");
    expect(mapSandbox("readOnly")).toBe("read-only");
    expect(mapSandbox("workspace-write")).toBe("workspace-write");
    expect(mapSandbox("workspaceWrite")).toBe("workspace-write");
    expect(mapSandbox("danger-full-access")).toBe("danger-full-access");
    expect(mapSandbox("dangerFullAccess")).toBe("danger-full-access");
    expect(toCodexInput(input())).toEqual([
      { type: "text", text: "Token: secret\n\nhello" },
      { type: "localImage", path: "/tmp/a.png" },
    ]);
  });

  it("starts, steers, interrupts, and completes a turn", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const events: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events()) events.push(event);
    })();
    const ref = await runtime.open(spec());
    expect(ref).toBe("th_1");
    const started = transport.sent.find((item) => (item as { method?: string }).method === "thread/start") as { params: Record<string, unknown> };
    expect(started.params.developerInstructions).toBe("be useful");
    expect(started.params.sandbox).toBe("read-only");
    await runtime.start(ref, input());
    transport.push({
      method: "item/completed",
      params: { threadId: ref, item: { type: "agentMessage", text: "answer" } },
    });
    transport.push({ method: "turn/completed", params: { threadId: ref, turn: { status: "completed" } } });
    const completed = await take(events, "turn.completed");
    expect(completed).toMatchObject({ type: "turn.completed", text: "answer", turnId: "turn-1" });

    await runtime.steer(ref, input("more"));
    const steer = transport.sent.find((item) => (item as { method?: string }).method === "turn/steer") as { params: { expectedTurnId?: string } };
    expect(steer.params.expectedTurnId).toBe("ct_3");
    await runtime.interrupt(ref);
    expect(transport.sent.some((item) => (item as { method?: string }).method === "turn/interrupt")).toBe(true);
    await runtime.release(ref);
    expect(transport.sent.some((item) => (item as { method?: string }).method === "thread/unsubscribe")).toBe(true);
    expect(await runtime.updateInstructions(ref, "new")).toBe("unsupported");
    runtime.close();
    await reading;
    stop();
  });

  it("forwards an approval as accept or decline", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const events: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events()) events.push(event);
    })();
    const ref = await runtime.open(spec());
    await runtime.start(ref, input());
    transport.push({
      id: 50,
      method: "item/commandExecution/requestApproval",
      params: { threadId: ref, approvalId: "ap9", command: "rm tmp" },
    });
    const approval = await take(events, "approval.requested");
    expect(approval).toMatchObject({ type: "approval.requested", approvalId: "ap9", kind: "command", summary: "rm tmp" });
    await runtime.resolveApproval(ref, "ap9", "approve");
    const response = transport.sent.find((item) => (item as { id?: number }).id === 50) as { result: { decision: string } };
    expect(response.result.decision).toBe("accept");
    runtime.close();
    await reading;
    stop();
  });

  it("marks retryable transport failures and reports a lost process", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const events: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events()) events.push(event);
    })();
    const ref = await runtime.open(spec({ kind: "check" }));
    const opened = transport.sent.find((item) => (item as { method?: string }).method === "thread/start") as { params: { ephemeral?: boolean } };
    expect(opened.params.ephemeral).toBe(true);
    await runtime.start(ref, input());
    transport.push({
      method: "error",
      params: { threadId: ref, error: { message: "ResponseStreamDisconnected" } },
    });
    transport.push({ method: "turn/completed", params: { threadId: ref, turn: { status: "failed" } } });
    const failed = await take(events, "turn.failed");
    expect(failed).toMatchObject({ type: "turn.failed", retryable: true });
    transport.close();
    const lost = await take(events, "runtime.lost");
    expect(lost).toMatchObject({ type: "runtime.lost" });
    runtime.close();
    await reading;
    stop();
  });

  it("frames newline-delimited JSON on stdio", async () => {
    const transport = new StdioCodexTransport(process.execPath, [
      "-e",
      'let buf="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{buf+=c;let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const msg=JSON.parse(line);process.stdout.write(JSON.stringify({id:msg.id,result:{echo:msg.method}})+"\\n");}});',
    ]);
    const iterator = transport.messages()[Symbol.asyncIterator]();
    transport.send({ id: 1, method: "initialize" });
    const echoed = await iterator.next();
    expect(echoed.value).toEqual({ id: 1, result: { echo: "initialize" } });
    transport.close();
  });
});
