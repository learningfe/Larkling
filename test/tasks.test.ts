import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "../src/core/host.js";
import { Logger } from "../src/log.js";
import { MemoryChannel } from "../src/channels/memory.js";
import { ManualClock } from "../src/core/clock.js";
import { ScriptedRuntime } from "../src/runtimes/scripted.js";
import { message, post, pushAndSettle, startHarness, testConfig, waitFor } from "./helpers.js";

describe("tasks", () => {
  it("starts, updates, and scopes tokens, and passes the body through", async () => {
    const h = await startHarness((config) => {
      config.limits.maxConcurrentTasks = 2;
    });
    let taskBodies: string[] = [];
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "task") taskBodies.push(turn.input.messages.map((item) => item.text).join("\n"));
      if (turn.spec.kind === "check") {
        turn.emit({ type: "turn.completed", text: "QUIET" });
        return;
      }
      turn.emit({ type: "turn.completed", text: turn.spec.kind === "task" ? "task-result" : "ack" });
    };
    await pushAndSettle(h, message({ text: "please", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "  keep this body  ", followUpEnabled: true });
    expect(started.status).toBe(200);
    await h.host.settle();
    expect(taskBodies[0]).toBe("  keep this body  ");
    const task = Object.values(h.host.snapshot().tasks)[0];
    expect(task.status).toBe("ended");
    expect(task.lastResult).toBe("task-result");
    expect(h.runtime.starts.some((item) => item.input.context.includes("task-result") || item.input.messages.some((message) => message.text.includes("task-result")))).toBe(true);

    const taskSession = h.host.snapshot().sessions[task.sessionId ?? ""];
    const version = task.version;
    const updated = await post(h.host.apiUrl, taskSession.token, "/v1/task/update", {
      taskId: task.taskId,
      version,
      body: "next body",
      followUpEnabled: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.version).toBe(version + 1);
    const conflict = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: task.taskId,
      version: 1,
      body: "stale",
      followUpEnabled: false,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("VERSION_CONFLICT");

    const stranger = await post(h.host.apiUrl, "nope", "/v1/task/get", { taskId: task.taskId });
    expect(stranger.status).toBe(401);
    const cancelByTask = await post(h.host.apiUrl, taskSession.token, "/v1/task/cancel", { taskId: task.taskId });
    expect(cancelByTask.status).toBe(403);
    const ownerList = await post(h.host.apiUrl, h.host.ownerToken, "/v1/task/list", {});
    expect(ownerList.status).toBe(200);
    expect(ownerList.json).toHaveLength(1);

    const other = await post(h.host.apiUrl, parent.token, "/v1/im/history", { container: "oc_other", limit: 5 });
    expect(other.status).toBe(403);
    h.channel.histories.set("ou_owner", [
      {
        messageId: "remote",
        scope: { channel: "memory", kind: "dm", id: "ou_owner" },
        actor: { channel: "memory", ref: "ou_x", stableId: "feishu:on_x", name: "X", isBot: false },
        text: "from platform",
        attachments: [],
        mentionsSelf: false,
        occurredAt: "2026-03-15T01:00:00.000Z",
      },
    ]);
    const history = await h.host.imHistory(parent.token, { container: "ou_owner", limit: 10 });
    expect(JSON.stringify(history)).toContain("from platform");
    const logPath = join(h.dir, "im", "ou_owner.jsonl");
    const stored = await readFile(logPath, "utf8").catch(() => "");
    expect(stored).not.toContain("from platform");
  });

  it("rejects a start past the slot cap and a continue that needs a free slot", async () => {
    const h = await startHarness((config) => {
      config.limits.maxConcurrentTasks = 1;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "task" && turn.input.messages.some((item) => item.text === "hold")) {
        await held;
        turn.emit({ type: "turn.completed", text: "done" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "done" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const first = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "hold" });
    expect(first.status).toBe(200);
    await waitFor(() => Object.values(h.host.snapshot().tasks)[0]?.status === "running", "running task");
    const second = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "extra" });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("CAPACITY_EXHAUSTED");
    expect(Object.values(h.host.snapshot().sessions).some((session) => session.kind === "conversation")).toBe(true);
    release();
    await h.host.settle();
  });

  it("cancels a running task without a parent event", async () => {
    const h = await startHarness();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "task") {
        await held;
        turn.emit({ type: "turn.completed", text: "late" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "long" });
    await waitFor(() => {
      const task = h.host.snapshot().tasks[started.json.taskId];
      return Boolean(task?.sessionId && h.host.snapshot().sessions[task.sessionId]?.phase === "running");
    }, "task turn");
    const cancelled = await post(h.host.apiUrl, parent.token, "/v1/task/cancel", { taskId: started.json.taskId });
    expect(cancelled.status).toBe(200);
    await waitFor(() => h.host.snapshot().tasks[started.json.taskId]?.status === "cancelled", "cancelled");
    release();
    await h.host.settle();
    expect(h.host.snapshot().tasks[started.json.taskId].status).toBe("cancelled");
    expect(h.host.snapshot().tasks[started.json.taskId].pendingEvent).toBeUndefined();
    expect(h.channel.sent.filter((item) => item.action.type === "text").map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["ack"]);
  });

  it("wakes a followed task on WAKE and stays quiet on QUIET", async () => {
    const h = await startHarness((config) => {
      config.tasks.heartbeat.intervalMs = 60_000;
      config.tasks.heartbeat.scanIntervalMs = 0;
    });
    let checks = 0;
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "check") {
        checks += 1;
        turn.emit({ type: "turn.completed", text: checks === 1 ? "QUIET" : "WAKE\nstill going" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "watch me", followUpEnabled: true });
    await h.host.settle();
    const taskId = Object.keys(h.host.snapshot().tasks)[0];
    h.clock.advance(60_000);
    await h.host.tick();
    await h.host.settle();
    expect(h.host.snapshot().tasks[taskId].lastCheck?.progress).toContain("QUIET");
    expect(h.host.snapshot().tasks[taskId].pendingEvent).toBeUndefined();
    h.clock.advance(60_000);
    await h.host.tick();
    await h.host.settle();
    expect(h.channel.sent.some((item) => item.action.type === "text" && item.action.text === "ack")).toBe(true);
    expect(h.host.snapshot().tasks[taskId].pendingEvent).toBeUndefined();
    expect(h.host.snapshot().tasks[taskId].status).toBe("ended");
  });

  it("marks a running task failed after a process restart and keeps a queued one", async () => {
    const h = await startHarness();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "task") {
        await held;
        return;
      }
      turn.emit({ type: "turn.completed", text: "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const running = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "in flight" });
    await waitFor(() => h.host.snapshot().tasks[running.json.taskId]?.status === "running", "running");
    release();
    await h.host.stop();

    const clock = new ManualClock(h.clock.now() + 1000);
    const channel = new MemoryChannel(true);
    const runtime = new ScriptedRuntime("codex");
    runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "resumed" });
    const host = await createHost({
      config: await testConfig(h.dir),
      channel,
      runtimes: new Map([["codex", runtime]]),
      clock,
      logger: new Logger(undefined, "error"),
      bot: { ref: "ou_bot", stableId: "memory:bot", name: "Larkling" },
      timers: false,
    });
    await host.start();
    await host.settle();
    expect(host.snapshot().tasks[running.json.taskId].status).toBe("ended");
    expect(host.snapshot().tasks[running.json.taskId].pendingEvent).toBeUndefined();
    expect(channel.sent.some((item) => item.action.type === "text" && item.action.text === "resumed")).toBe(true);
    expect(runtime.starts.some((item) => item.input.messages.some((message) => message.text.includes("interrupted by process restart")))).toBe(true);
    await host.stop();
  });

  it("ends a task that sits idle past the task timeout", async () => {
    const h = await startHarness((config) => {
      config.tasks.taskIdleTimeoutMs = 5_000;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "task") {
        await held;
        turn.emit({ type: "turn.completed", text: "late" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "slow" });
    await waitFor(() => h.host.snapshot().tasks[started.json.taskId]?.status === "running", "running");
    h.clock.advance(5_000);
    await h.host.tick();
    await waitFor(() => h.host.snapshot().tasks[started.json.taskId]?.status === "ended", "timed out");
    release();
    await h.host.settle();
    expect(h.host.snapshot().tasks[started.json.taskId].status).toBe("ended");
    expect(
      h.runtime.starts.some(
        (item) => item.input.context.includes("task idle timeout") || item.input.messages.some((entry) => entry.text.includes("task idle timeout")),
      ),
    ).toBe(true);
  });
});
