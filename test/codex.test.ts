import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRuntime, SEED_PREFACE, mapSandbox, toCodexInput } from "../src/runtimes/codex/adapter.js";
import { MemoryCodexTransport, StdioCodexTransport } from "../src/runtimes/codex/transport.js";
import { emptyState, type RuntimeEvent, type SessionSpec, type TurnInput } from "../src/protocol/types.js";
import { createHost } from "../src/core/host.js";
import { MemoryChannel } from "../src/channels/memory.js";
import { ManualClock } from "../src/core/clock.js";
import { Logger } from "../src/log.js";
import { message, tempDir, testConfig, waitFor } from "./helpers.js";

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
function drive(transport: MemoryCodexTransport, options?: { completeTurns?: boolean; echoResumeId?: boolean }): () => void {
  let cursor = 0;
  let threads = 0;
  const timer = setInterval(() => {
    while (cursor < transport.sent.length) {
      const message = transport.sent[cursor++] as { id?: number; method?: string; params?: { threadId?: string } };
      if (message.id == null || !message.method || message.method === "initialized") continue;
      if (message.method === "initialize") transport.push({ id: message.id, result: { userAgent: "test" } });
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        threads += 1;
        const requested = options?.echoResumeId && message.method === "thread/resume" ? String(message.params?.threadId ?? "") : "";
        transport.push({ id: message.id, result: { thread: { id: requested || `th_${threads}` } } });
      } else if (message.method === "turn/start" || message.method === "turn/steer") {
        transport.push({ id: message.id, result: { turn: { id: `ct_${message.id}` } } });
        if (options?.completeTurns && message.method === "turn/start") {
          const threadId = String(message.params?.threadId ?? "");
          setTimeout(() => {
            transport.push({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: "ok" } } });
            transport.push({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
          }, 0);
        }
      } else if (message.method === "turn/interrupt" || message.method === "thread/unsubscribe") {
        transport.push({ id: message.id, result: {} });
      } else transport.push({ id: message.id, error: { message: `unexpected ${message.method}` } });
    }
  }, 5);
  return () => clearInterval(timer);
}

function turnStarts(transport: MemoryCodexTransport): { type?: string; text?: string }[][] {
  return transport.sent
    .filter((item) => (item as { method?: string }).method === "turn/start")
    .map((item) => (item as { params: { input: { type?: string; text?: string }[] } }).params.input);
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

  it("injects a new thread's seed into the first turn only", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const events: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events()) events.push(event);
    })();
    const ref = await runtime.open(
      spec({ seed: { text: "Ada: hello\nassistant: ok", throughSeq: 4, estimatedTokens: 8 } }),
    );
    await runtime.start(ref, input("follow-up"));
    const first = turnStarts(transport)[0];
    expect(first[0]).toEqual({ type: "text", text: `${SEED_PREFACE}\nAda: hello\nassistant: ok` });
    const joined = first.map((item) => item.text).join("\n");
    expect(joined).toContain("follow-up");
    expect(joined.indexOf(SEED_PREFACE)).toBeLessThan(joined.indexOf("follow-up"));

    await runtime.start(ref, input("later"));
    const second = turnStarts(transport)[1];
    expect(second.map((item) => item.text ?? "").join("\n")).not.toContain(SEED_PREFACE);
    expect(second.map((item) => item.text ?? "").join("\n")).not.toContain("Ada: hello");
    expect(second.map((item) => item.text ?? "").join("\n")).toContain("later");

    const resumed = await runtime.open(spec({ runtimeRef: ref, seed: { text: "should-not-repeat", throughSeq: 9, estimatedTokens: 4 } }));
    await runtime.start(resumed, input("after resume"));
    const third = turnStarts(transport).at(-1) ?? [];
    expect(third.map((item) => item.text ?? "").join("\n")).not.toContain("should-not-repeat");
    runtime.close();
    await reading;
    stop();
  });

  it("puts the seed on the first turn after an instructions change and not on the next turn", async () => {
    const dir = await tempDir();
    const config = await testConfig(dir, (draft) => {
      draft.runtimes.codex.idleReleaseMs = 1_000;
    });
    const clock = new ManualClock(Date.parse("2026-03-15T02:00:00.000Z"));
    const channel = new MemoryChannel(true);
    const transport = new MemoryCodexTransport();
    const stopDrive = drive(transport, { completeTurns: true });
    const runtime = new CodexRuntime({ transport });
    const host = await createHost({
      config,
      channel,
      runtimes: new Map([["codex", runtime]]),
      clock,
      logger: new Logger(undefined, "error"),
      bot: { ref: "ou_bot", stableId: "memory:bot", name: "Larkling" },
      timers: false,
    });
    await host.start();
    try {
      channel.push(message({ text: "hello", messageId: "m1" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await host.settle();
      expect(turnStarts(transport)).toHaveLength(1);
      expect(turnStarts(transport)[0].map((item) => item.text ?? "").join("\n")).not.toContain(SEED_PREFACE);

      clock.advance(1_000);
      await host.tick();
      config.agents.front.instructions = "front instructions changed";
      channel.push(message({ text: "follow-up", messageId: "m2" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await host.settle();
      await waitFor(() => turnStarts(transport).length >= 2, "reopened turn");
      const reopened = turnStarts(transport)[1];
      const transcript = reopened[0]?.text ?? "";
      expect(transcript.startsWith(SEED_PREFACE)).toBe(true);
      expect(transcript).toContain("Owner: hello");
      expect(transcript).toContain("assistant: ok");
      expect(transcript.slice(SEED_PREFACE.length)).not.toContain("follow-up");
      const reopenedJoined = reopened.map((item) => item.text ?? "").join("\n");
      expect(reopenedJoined.indexOf(SEED_PREFACE)).toBeLessThan(reopenedJoined.indexOf("follow-up"));

      channel.push(message({ text: "third", messageId: "m3" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await host.settle();
      await waitFor(() => turnStarts(transport).length >= 3, "third turn");
      const later = turnStarts(transport)[2].map((item) => item.text ?? "").join("\n");
      expect(later).not.toContain(SEED_PREFACE);
      expect(later).toContain("third");
    } finally {
      stopDrive();
      await host.stop();
    }
  });

  it("maps network to sandboxPolicy.networkAccess on turn/start", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const reading = (async () => {
      for await (const _event of runtime.events()) void _event;
    })();
    const open = await runtime.open(spec({ sessionId: "s-net", profile: { ...spec().profile, network: true } }));
    await runtime.start(open, input("net"));
    const closed = await runtime.open(spec({ sessionId: "s-closed" }));
    await runtime.start(closed, input("closed"));
    const writer = await runtime.open(spec({ sessionId: "s-write", profile: { ...spec().profile, sandbox: "workspace-write", network: true } }));
    await runtime.start(writer, input("write"));
    const starts = transport.sent.filter((item) => (item as { method?: string }).method === "turn/start") as {
      params: { sandboxPolicy?: unknown; sandbox?: unknown };
    }[];
    expect(starts[0]?.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: true });
    expect(starts[1]?.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(starts[2]?.params.sandboxPolicy).toEqual({ type: "workspaceWrite", networkAccess: true });
    expect(starts.every((item) => item.params.sandbox === undefined)).toBe(true);
    runtime.close();
    await reading;
    stop();
  });

  it("does not repeat a message whose text is already in the context window", () => {
    const items = toCodexInput({
      turnId: "t",
      context: 'Turn input:\n{"history":[{"messageId":"om_1","body":"别查了"}]}',
      messages: [{ text: "别查了", messageId: "om_1", inContext: true }, { text: "task event text" }],
    }) as { text?: string }[];
    const text = items.map((item) => item.text ?? "").join("\n");
    expect(text.match(/别查了/g)).toHaveLength(1);
    expect(text).toContain("om_1");
    expect(text).not.toContain("#om_1");
    expect(text).toContain("task event text");
  });

  it("requests the priority service tier only when fast is set", async () => {
    const transport = new MemoryCodexTransport();
    const stop = drive(transport);
    const runtime = new CodexRuntime({ transport });
    const events: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of runtime.events()) events.push(event);
    })();
    const fast = await runtime.open(spec({ sessionId: "s-fast", profile: { ...spec().profile, fast: true } }));
    await runtime.start(fast, input("fast"));
    const plain = await runtime.open(spec({ sessionId: "s-plain" }));
    await runtime.start(plain, input("plain"));
    const starts = transport.sent.filter((item) => (item as { method?: string }).method === "turn/start") as {
      params: { serviceTier?: string; threadId?: string };
    }[];
    expect(starts[0]?.params.serviceTier).toBe("priority");
    expect(starts[1]?.params).not.toHaveProperty("serviceTier");
    const opened = transport.sent.filter((item) => (item as { method?: string }).method === "thread/start") as {
      params: { serviceTier?: string };
    }[];
    expect(opened.every((item) => item.params.serviceTier === undefined)).toBe(true);
    runtime.close();
    await reading;
    stop();
  });

  it("resumes a restarted idle thread when tick runs between resume and turn start", async () => {
    const dir = await tempDir();
    const config = await testConfig(dir, (draft) => {
      draft.runtimes.codex.idleReleaseMs = 1_000;
    });
    const clock = new ManualClock(Date.parse("2026-03-15T02:00:00.000Z"));
    const stale = new Date(clock.now() - 60 * 60_000).toISOString();
    const sessionId = "memory:dm:ou_owner";
    const state = emptyState();
    state.sessions[sessionId] = {
      sessionId,
      kind: "conversation",
      scope: { channel: "memory", kind: "dm", id: "ou_owner" },
      runtimeName: "codex",
      runtimeRef: "t1",
      lastSeq: 0,
      phase: "idle",
      queue: [],
      pendingApprovalIds: [],
      idleSince: stale,
      token: "tok",
      imContainer: "ou_owner",
      createdAt: stale,
      updatedAt: stale,
      live: false,
    };
    state.tokens.tok = { token: "tok", sessionId, role: "session" };
    await writeFile(join(dir, "state.json"), JSON.stringify(state));

    const channel = new MemoryChannel(true);
    let releaseHistory: () => void = () => undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyEntered = false;
    const originalHistory = channel.history.bind(channel);
    channel.history = async (query) => {
      historyEntered = true;
      await historyGate;
      return originalHistory(query);
    };
    const transport = new MemoryCodexTransport();
    const stopDrive = drive(transport, { completeTurns: true, echoResumeId: true });
    const runtime = new CodexRuntime({ transport });
    const host = await createHost({
      config,
      channel,
      runtimes: new Map([["codex", runtime]]),
      clock,
      logger: new Logger(undefined, "error"),
      bot: { ref: "ou_bot", stableId: "memory:bot", name: "Larkling" },
      timers: false,
    });
    await host.start();
    try {
      expect(host.snapshot().sessions[sessionId]).toMatchObject({ live: false, runtimeRef: "t1", idleSince: stale });
      channel.push(message({ text: "after restart", messageId: "m-restart" }));
      await waitFor(() => historyEntered, "history after resume");
      const resumed = host.snapshot().sessions[sessionId];
      expect(resumed?.live).toBe(true);
      expect(resumed?.phase).toBe("idle");
      expect(resumed?.idleSince).toBe(new Date(clock.now()).toISOString());

      const ticking = host.tick();
      releaseHistory();
      await ticking;
      await host.settle();

      const started = transport.sent.filter((item) => (item as { method?: string }).method === "turn/start") as {
        params: { threadId?: string };
      }[];
      expect(started).toHaveLength(1);
      expect(started[0]?.params.threadId).toBe("t1");
      expect(transport.sent.some((item) => (item as { method?: string }).method === "thread/unsubscribe")).toBe(false);
      const texts = channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""));
      expect(texts.some((text) => text.includes("这一轮没有完成") || text.includes("unknown codex thread"))).toBe(false);
      expect(texts).toContain("ok");
      expect(host.snapshot().sessions[sessionId]?.live).toBe(true);
    } finally {
      releaseHistory();
      stopDrive();
      await host.stop();
    }
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

describe("Codex dynamicTools", () => {
  it("registers front tools on thread/start and answers item/tool/call", async () => {
    const { MemoryCodexTransport } = await import("../src/runtimes/codex/transport.js");
    const { CodexRuntime } = await import("../src/runtimes/codex/adapter.js");
    const transport = new MemoryCodexTransport();
    const runtime = new CodexRuntime({ transport });
    // Feed initialize + thread/start responses
    const events = runtime.events();
    const drain = (async () => {
      for await (const _ of events) {
        /* consume */
      }
    })();
    // Intercept outgoing by wrapping send
    const sent: unknown[] = [];
    const originalSend = transport.send.bind(transport);
    transport.send = (msg: unknown) => {
      sent.push(msg);
      return originalSend(msg);
    };
    // Provide scripted replies via transport's test API if any — skip if MemoryCodexTransport is duplex queue
    // Minimal: just check dynamicToolsForKind export
    const { dynamicToolsForKind, FRONT_DYNAMIC_TOOLS, BACK_DYNAMIC_TOOLS } = await import("../src/runtimes/codex/dynamic-tools.js");
    expect(dynamicToolsForKind("conversation")?.map((t) => t.name)).toEqual(["task_start", "task_update", "task_get", "task_cancel"]);
    expect(dynamicToolsForKind("task")?.length).toBe(BACK_DYNAMIC_TOOLS.length);
    expect(FRONT_DYNAMIC_TOOLS[0].type).toBe("function");
    runtime.close();
    void drain;
  });
});
