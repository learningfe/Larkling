import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Logger } from "../src/log.js";
import { ManualClock } from "../src/core/clock.js";
import { ScriptedRuntime } from "../src/runtimes/scripted.js";
import { MemoryChannel } from "../src/channels/memory.js";
import { createHost } from "../src/core/host.js";
import { describe, expect, it } from "vitest";
import { conversationSessionId } from "../src/protocol/types.js";
import { CaptureLogger, OWNER_ID, groupScope, message, ownerActor, post, pushAndSettle, startHarness, tempDir, testConfig, type Harness, waitFor } from "./helpers.js";

function conversation(h: Harness, id = "ou_owner") {
  return h.host.snapshot().sessions[conversationSessionId({ channel: "memory", kind: "dm", id })];
}

describe("in-memory channel and scripted runtime", () => {
  it("answers an owner DM and stays silent on [[silent]]", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => {
      const text = turn.input.messages.map((item) => item.text).join("\n");
      turn.emit({ type: "turn.completed", text: text === "quiet" ? "[[silent]]" : `echo:${text}` });
    };
    await pushAndSettle(h, message({ text: "hello", messageId: "m1" }));
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["echo:hello"]);
    expect(conversation(h).phase).toBe("idle");
    expect(h.runtime.opens[0].instructions).toContain("front instructions");
    expect(h.runtime.opens[0].instructions).not.toContain("Your name is Larkling");
    expect(h.runtime.opens[0].instructions).not.toContain("a personal assistant");
    expect(h.runtime.starts[0].input.context).toContain('"name": "Larkling"');
    expect(h.runtime.starts[0].input.context).toContain("a personal assistant");
    expect(h.runtime.opens[0].profile.network).toBe(false);
    expect(h.runtime.opens[0].profile.cwd).toMatch(/\/front$/);
    expect(h.runtime.starts[0].input.context).toContain("Token:");
    expect(h.runtime.starts[0].input.context).toContain("hello");
    expect(h.runtime.starts[0].input.messages[0].inContext).toBe(true);
    expect(h.runtime.starts[0].input.context).toMatch(/Continue a task: /);
    expect(h.runtime.starts[0].input.context).not.toMatch(/Cancel a task: /);
    expect(h.runtime.starts[0].input.context).not.toMatch(/Start a task: /);
    await pushAndSettle(h, message({ text: "quiet", messageId: "m2" }));
    expect(h.channel.sent).toHaveLength(1);
  });

  it("merges queued user messages when the runtime cannot steer", async () => {
    const h = await startHarness();
    h.runtime.capabilities.steer = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    h.runtime.handler = async (turn) => {
      starts += 1;
      if (starts === 1) await gate;
      turn.emit({ type: "turn.completed", text: turn.input.messages.map((item) => item.text).join("+") });
    };
    h.channel.push(message({ text: "one", messageId: "m1" }));
    await waitFor(() => conversation(h)?.phase === "running", "first turn");
    h.channel.push(message({ text: "two", messageId: "m2" }));
    h.channel.push(message({ text: "three", messageId: "m3" }));
    await waitFor(() => (conversation(h)?.queue.length ?? 0) >= 2, "queued pair");
    release();
    await h.host.settle();
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["one", "two+three"]);
  });

  it("steers a running turn and drops the superseded completion", async () => {
    const h = await startHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.method === "start") {
        await gate;
        turn.emit({ type: "turn.completed", text: "from-start" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "from-steer" });
    };
    h.channel.push(message({ text: "one", messageId: "m1" }));
    await waitFor(() => h.runtime.starts.length === 1, "start");
    h.channel.push(message({ text: "two", messageId: "m2" }));
    await waitFor(() => h.runtime.steers.length === 1, "steer");
    release();
    await h.host.settle();
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["from-steer"]);
  });

  it("turns a rejected steer into the next start", async () => {
    const h = await startHarness();
    h.runtime.rejectSteer = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.method === "start" && turn.input.messages.some((item) => item.text === "one")) await gate;
      turn.emit({ type: "turn.completed", text: turn.input.messages.map((item) => item.text).join(",") });
    };
    h.channel.push(message({ text: "one", messageId: "m1" }));
    await waitFor(() => conversation(h)?.phase === "running", "running");
    h.channel.push(message({ text: "two", messageId: "m2" }));
    await waitFor(() => conversation(h)?.queue.some((item) => item.kind === "message" && item.text === "two") === true, "queued after reject");
    release();
    await h.host.settle();
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["one", "two"]);
  });

  it("discards a reply that only addresses recalled messages", async () => {
    const h = await startHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      await gate;
      turn.emit({ type: "turn.completed", text: "too late" });
    };
    const scope = { channel: "memory", kind: "dm" as const, id: "ou_owner" };
    h.channel.push(message({ text: "secret", messageId: "m1", scope }));
    await waitFor(() => conversation(h)?.phase === "running", "running");
    h.channel.push({ type: "recalled", eventId: "r1", messageId: "m1", scope });
    await waitFor(() => conversation(h)?.activeTurn?.recalledMessageIds.includes("m1") === true, "recalled");
    release();
    await h.host.settle();
    expect(h.channel.sent).toHaveLength(0);
  });

  it("judges later messages in a topic the bot has replied in", async () => {
    const h = await startHarness((config) => {
      config.im.gate.debounceMs = 1_000;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "judge") {
        turn.emit({ type: "turn.completed", text: "RESPOND" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "front" });
    };
    const scope = { channel: "memory", kind: "topic" as const, id: "omt_1", parentId: "oc_family" };
    const human = { channel: "memory", ref: "ou_s", stableId: "feishu:on_stranger", name: "Sam", isBot: false };
    await pushAndSettle(h, message({ text: "old chatter", messageId: "t0", scope, actor: human, mentionsSelf: false }));
    expect(h.runtime.opens.filter((item) => item.kind === "judge")).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
    await pushAndSettle(h, message({ text: "@bot", messageId: "t1", scope, actor: human, mentionsSelf: true }));
    expect(h.channel.sent.some((item) => item.action.type === "text" && item.action.text === "front")).toBe(true);
    expect(h.host.snapshot().participatedTopics).toContain("omt_1");
    h.channel.push(message({ text: "follow up", messageId: "t2", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("t2"), "seen follow up");
    await h.host.settle();
    expect(h.runtime.opens.filter((item) => item.kind === "judge")).toHaveLength(0);
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(h.runtime.opens.some((item) => item.kind === "judge")).toBe(true);
    expect(h.channel.sent.filter((item) => item.action.type === "text" && item.action.text === "front").length).toBeGreaterThan(1);
  });

  it("sends a structured turn: full window when cold, only new messages while the session lives", async () => {
    const h = await startHarness();
    const scope = { channel: "memory", kind: "dm" as const, id: "ou_owner" };
    const old = Array.from({ length: 3 }, (_, index) => ({
      messageId: `old${index}`,
      scope,
      actor: ownerActor(),
      text: `old ${index}`,
      attachments: [],
      mentionsSelf: false,
      occurredAt: `2026-03-15T01:00:0${index}.000Z`,
    }));
    h.channel.histories.set("ou_owner", old);
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "now", messageId: "m-now", occurredAt: "2026-03-15T01:00:05.000Z" }));
    const first = turnJson(h.runtime.starts[0].input.context);
    expect(first.turn).toMatchObject({ cold: true, scope: { kind: "dm", id: "ou_owner" } });
    expect(first.history.mode).toBe("full");
    expect(first.history.messages.map((item: { messageId: string }) => item.messageId)).toEqual(["old0", "old1", "old2"]);
    expect(first.trigger.map((item: { messageId: string; body: string }) => [item.messageId, item.body])).toEqual([["m-now", "now"]]);
    expect(first.trigger[0].sender.isSelf).toBe(false);
    expect(first).not.toHaveProperty("audience");
    expect(first).not.toHaveProperty("self");
    expect(h.runtime.starts[0].input.messages.every((item) => item.inContext)).toBe(true);
    h.clock.advance(120_000);
    h.channel.histories.set("ou_owner", [
      ...old,
      { messageId: "m-now", scope, actor: ownerActor(), text: "now", attachments: [], mentionsSelf: false, occurredAt: "2026-03-15T01:00:05.000Z" },
      { messageId: "mid1", scope, actor: ownerActor(), text: "between", attachments: [], mentionsSelf: false, occurredAt: "2026-03-15T02:01:00.000Z" },
      { messageId: "mid2", scope, actor: ownerActor(), text: "between 2", attachments: [], mentionsSelf: false, occurredAt: "2026-03-15T02:01:30.000Z" },
    ]);
    await pushAndSettle(h, message({ text: "later", messageId: "m-later", occurredAt: "2026-03-15T02:02:00.000Z" }));
    const second = turnJson(h.runtime.starts.at(-1)!.input.context);
    expect(second.turn.cold).toBe(false);
    expect(second.history).toMatchObject({ mode: "incremental", newCount: 2 });
    expect(second.history.messages.map((item: { messageId: string }) => item.messageId)).toEqual(["mid1", "mid2"]);
    expect(second.trigger.map((item: { messageId: string }) => item.messageId)).toEqual(["m-later"]);
  });

  it("replies with the canned line for an unsupported mention and ignores stickers", async () => {
    const h = await startHarness();
    const scope = groupScope();
    await pushAndSettle(
      h,
      message({
        text: "[不支持的消息类型：unknown]",
        messageId: "bad",
        scope,
        mentionsSelf: true,
        disposition: "unsupported",
      }),
    );
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["暂不支持该消息类型，请改发文字。"]);
    expect(h.runtime.starts).toHaveLength(0);
    await pushAndSettle(h, message({ text: "[表情包]", messageId: "sticker", scope, mentionsSelf: true, disposition: "store_only" }));
    expect(h.channel.sent).toHaveLength(1);
  });

  it("stops a bot chain at the limit until a human speaks, and ignores the bot itself", async () => {
    const h = await startHarness((config) => {
      config.session.botChainLimit = 3;
    });
    const scope = groupScope();
    const otherBot = { channel: "memory", ref: "ou_other", stableId: "feishu:on_allowed", name: "Other", isBot: true };
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "b1", messageId: "b1", scope, actor: otherBot, mentionsSelf: true }));
    await pushAndSettle(h, message({ text: "b2", messageId: "b2", scope, actor: otherBot, mentionsSelf: true }));
    const before = h.runtime.starts.length;
    await pushAndSettle(h, message({ text: "b3", messageId: "b3", scope, actor: otherBot, mentionsSelf: true }));
    expect(h.runtime.starts.length).toBe(before);
    await pushAndSettle(
      h,
      message({
        text: "self",
        messageId: "self",
        scope,
        actor: { channel: "memory", ref: "ou_bot", stableId: "memory:bot", name: "Larkling", isBot: true },
        mentionsSelf: true,
      }),
    );
    expect(h.runtime.starts.length).toBe(before);
    await pushAndSettle(
      h,
      message({
        text: "nope",
        messageId: "denied",
        scope,
        actor: { channel: "memory", ref: "ou_no", stableId: "feishu:on_nope", name: "Nope", isBot: false },
        mentionsSelf: false,
      }),
    );
    await pushAndSettle(h, message({ text: "b4", messageId: "b4", scope, actor: otherBot, mentionsSelf: true }));
    expect(h.runtime.starts.length).toBe(before + 1);
  });

  it("asks the owner on a card and continues after one approval", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => {
      if (turn.input.messages.some((item) => item.text === "need")) {
        turn.emit({ type: "approval.requested", approvalId: "ap1", kind: "command", summary: "rm tmp" });
        const decision = await turn.waitApproval("ap1");
        turn.emit({ type: "turn.completed", text: decision });
        return;
      }
      turn.emit({ type: "turn.completed", text: "ready" });
    };
    await pushAndSettle(h, message({ text: "hello", messageId: "m0" }));
    h.channel.push(message({ text: "need", messageId: "m1" }));
    await waitFor(() => h.channel.sent.some((item) => item.action.type === "approval_card"), "approval card");
    const card = h.channel.sent.find((item) => item.action.type === "approval_card");
    expect(card?.action).toMatchObject({ type: "approval_card", approvalId: "ap1" });
    h.channel.push({ type: "approval_decision", approvalId: "ap1", decision: "approve", actor: ownerActor() });
    await h.host.settle();
    expect(h.channel.sent.some((item) => item.action.type === "text" && item.action.text === "approve")).toBe(true);
    expect(h.host.snapshot().approvals.ap1.status).toBe("approved");
  });

  it("retries a retryable failure twice and then reports it", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => {
      turn.emit({ type: "turn.failed", error: "timeout", retryable: true });
    };
    await pushAndSettle(h, message({ text: "boom", messageId: "m1" }));
    expect(h.runtime.starts).toHaveLength(3);
    expect(h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""))).toEqual(["这一轮没有完成：timeout"]);
  });

  it("interrupts a stalled turn from the watchdog and tells the owner", async () => {
    const h = await startHarness((config) => {
      config.session.turnIdleTimeoutMs = 1_000;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      await held;
      turn.emit({ type: "turn.completed", text: "late" });
    };
    h.channel.push(message({ text: "hang", messageId: "m1" }));
    await waitFor(() => conversation(h)?.phase === "running", "running");
    h.clock.advance(1_000);
    await h.host.tick();
    await waitFor(() => conversation(h)?.phase === "idle", "interrupted");
    release();
    await h.host.settle();
    expect(h.runtime.interrupts).toHaveLength(1);
    const texts = h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""));
    expect(texts.some((text) => text.includes("超过空闲时限"))).toBe(true);
    expect(texts).not.toContain("late");
  });

  it("disables a runtime after three losses in a minute", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "hi", messageId: "m0" }));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      await held;
      turn.emit({ type: "turn.completed", text: "late" });
    };
    h.channel.push(message({ text: "live", messageId: "m1" }));
    await waitFor(() => conversation(h)?.phase === "running", "running");
    const sessionId = conversation(h).sessionId;
    h.runtime.push({ type: "runtime.lost", sessionIds: [sessionId] });
    h.runtime.push({ type: "runtime.lost", sessionIds: [sessionId] });
    h.runtime.push({ type: "runtime.lost", sessionIds: [sessionId] });
    await waitFor(() => h.channel.sent.some((item) => item.action.type === "text" && item.action.text.includes("已停用")), "runtime disabled");
    release();
    await h.host.settle();
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "back" });
    await pushAndSettle(h, message({ text: "again", messageId: "m2" }));
    const texts = h.channel.sent.map((item) => (item.action.type === "text" ? item.action.text : ""));
    expect(texts.some((text) => text.includes("已停用"))).toBe(true);
    expect(texts.some((text) => text.includes("runtime codex is disabled"))).toBe(true);
    expect(OWNER_ID).toBe(h.config.owner);
  });

  it("judges a debounced relevant batch and skips a mention", async () => {
    const h = await startHarness((config) => {
      config.im.respondTo.default = "relevant";
      config.im.gate.debounceMs = 5_000;
    });
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind === "judge") {
        turn.emit({ type: "turn.completed", text: "RESPOND" });
        return;
      }
      turn.emit({ type: "turn.completed", text: "front" });
    };
    const scope = groupScope();
    const human = { channel: "memory", ref: "ou_s", stableId: "feishu:on_stranger", name: "Sam", isBot: false };
    h.channel.push(message({ text: "about the bot", messageId: "g1", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g1"), "buffered message");
    await h.host.settle();
    expect(h.runtime.opens.filter((item) => item.kind === "judge")).toHaveLength(0);
    h.clock.advance(5_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(h.channel.sent.some((item) => item.action.type === "text" && item.action.text === "front")).toBe(true);
    const before = h.runtime.opens.filter((item) => item.kind === "judge").length;
    await pushAndSettle(h, message({ text: "@bot now", messageId: "g2", scope, actor: human, mentionsSelf: true }));
    expect(h.runtime.opens.filter((item) => item.kind === "judge").length).toBe(before);
  });

  it("logs why a relevant batch woke front or was skipped, including short-circuits", async () => {
    const logs = new CaptureLogger();
    const h = await startHarness((config) => {
      config.im.respondTo.default = "relevant";
      config.im.respondTo.scopes.oc_mention = "mention";
      config.im.gate.debounceMs = 1_000;
      config.trust.restricted = ["oc_locked"];
      config.session.botChainLimit = 2;
    }, logs);
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind !== "judge") {
        turn.emit({ type: "turn.completed", text: "front" });
        return;
      }
      const text = turn.input.messages.map((item) => item.text).join("\n");
      if (text.startsWith("climb")) {
        turn.emit({ type: "turn.completed", text: "RESPOND\n刚才在排登山，这条是在定下午出发。后面这句不要记。" });
      } else if (text === "weather") {
        turn.emit({ type: "turn.completed", text: "SKIP\n群在聊算术与工具，这条是小区快递，接不上。另一句。" });
      } else if (text === "parcel") turn.emit({ type: "turn.completed", text: "RESPOND\n相关" });
      else if (text === "boom") turn.emit({ type: "turn.failed", error: "light model down", retryable: false });
      else turn.emit({ type: "turn.completed", text: "SKIP" });
    };
    const scope = groupScope("oc_desk");
    const human = { channel: "memory", ref: "ou_s", stableId: "feishu:on_stranger", name: "Sam", isBot: false };
    h.channel.histories.set("oc_desk", [
      {
        messageId: "old",
        scope,
        actor: human,
        text: "earlier thread",
        attachments: [],
        mentionsSelf: false,
        occurredAt: "2026-03-15T01:00:00.000Z",
      },
    ]);
    const other = { channel: "memory", ref: "ou_t", stableId: "feishu:on_other", name: "Tim", isBot: false };
    h.channel.push(message({ text: "climb", messageId: "g1", scope, actor: human, mentionsSelf: false }));
    h.channel.push(message({ text: "afternoon", messageId: "g1b", scope, actor: other, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g1b"), "buffered batch");
    await h.host.settle();
    expect(gateDecisions(logs)).toEqual([]);
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(gateDecisions(logs).at(-1)).toMatchObject({
      sessionId: "memory:group:oc_desk",
      chatId: "oc_desk",
      scopeKind: "group",
      messageIds: ["g1", "g1b"],
      decision: "allow",
      reason: "刚才在排登山，这条是在定下午出发。",
      mode: "relevant",
      mentionsSelf: false,
      senderIds: ["feishu:on_stranger", "feishu:on_other"],
      source: "judge",
    });
    expect(gateDecisions(logs).at(-1)).not.toHaveProperty("senderId");
    expect(h.channel.sent.some((item) => item.action.type === "text" && item.action.text === "front")).toBe(true);
    const judgeOpen = h.runtime.opens.find((item) => item.kind === "judge");
    expect(judgeOpen?.instructions).toContain("## Your job");
    expect(judgeOpen?.instructions).not.toContain("a personal assistant");
    expect(judgeOpen?.instructions).not.toMatch(/\p{Script=Han}/u);
    const judgeStart = h.runtime.starts.find((item) => item.ref === `scripted:${judgeOpen?.sessionId}`);
    const judgePayload = turnJson(judgeStart?.input.context ?? "");
    expect(judgePayload.recent.map((item: { messageId: string }) => item.messageId)).toEqual(["old"]);
    expect(judgePayload.candidates.map((item: { messageId: string; body: string }) => [item.messageId, item.body])).toEqual([
      ["g1", "climb"],
      ["g1b", "afternoon"],
    ]);
    expect(judgePayload).not.toHaveProperty("root");
    expect(judgeStart?.input.context).not.toContain("Persona:");
    expect(judgeStart?.input.context).not.toContain("Duty:");
    expect(judgeStart?.input.context).not.toMatch(/\[我 /);
    expect(judgeStart?.input.context).not.toContain("#old]");

    h.channel.push(message({ text: "weather", messageId: "g2", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g2"), "buffered weather");
    await h.host.settle();
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(gateDecisions(logs).at(-1)).toMatchObject({
      messageIds: ["g2"],
      decision: "skip",
      reason: "群在聊算术与工具，这条是小区快递，接不上。",
      mode: "relevant",
      senderId: "feishu:on_stranger",
      source: "judge",
    });
    expect(h.channel.sent.filter((item) => item.action.type === "text" && item.action.text === "front")).toHaveLength(1);

    h.channel.push(message({ text: "later", messageId: "g3", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g3"), "buffered later");
    await h.host.settle();
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["g3"], decision: "skip", reason: "reason_missing", source: "judge" });

    h.channel.push(message({ text: "parcel", messageId: "g3b", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g3b"), "buffered parcel");
    await h.host.settle();
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["g3b"], decision: "allow", reason: "reason_missing", source: "judge" });

    const judgesBefore = h.runtime.opens.filter((item) => item.kind === "judge").length;
    await pushAndSettle(h, message({ text: "@bot", messageId: "g4", scope, actor: human, mentionsSelf: true }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({
      messageIds: ["g4"],
      decision: "allow",
      reason: "mention",
      mentionsSelf: true,
      source: "short_circuit",
    });
    expect(h.runtime.opens.filter((item) => item.kind === "judge")).toHaveLength(judgesBefore);

    const mentionScope = groupScope("oc_mention");
    await pushAndSettle(h, message({ text: "no at", messageId: "m1", scope: mentionScope, actor: human, mentionsSelf: false }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({
      chatId: "oc_mention",
      messageIds: ["m1"],
      decision: "skip",
      reason: "mention_required",
      mode: "mention",
      source: "short_circuit",
    });
    expect(h.runtime.opens.filter((item) => item.kind === "judge")).toHaveLength(judgesBefore);

    const locked = groupScope("oc_locked");
    await pushAndSettle(h, message({ text: "locked", messageId: "t1", scope: locked, actor: human, mentionsSelf: true }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({ chatId: "oc_locked", messageIds: ["t1"], decision: "skip", reason: "trust", source: "short_circuit" });

    const allowedBot = { channel: "memory", ref: "ou_bot2", stableId: "feishu:on_allowed", name: "Other", isBot: true };
    await pushAndSettle(h, message({ text: "from bot", messageId: "b1", scope, actor: allowedBot, mentionsSelf: false }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["b1"], decision: "skip", reason: "bot_sender", senderId: "feishu:on_allowed" });

    await pushAndSettle(h, message({ text: "chain", messageId: "b2", scope, actor: allowedBot, mentionsSelf: true }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["b2"], decision: "skip", reason: "bot_chain" });

    await pushAndSettle(
      h,
      message({
        text: "echo",
        messageId: "self",
        scope,
        actor: { channel: "memory", ref: "ou_bot", stableId: "memory:bot", name: "Larkling", isBot: true },
        mentionsSelf: false,
      }),
    );
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["self"], decision: "skip", reason: "self" });

    await pushAndSettle(h, message({ text: "[表情包]", messageId: "sticker", scope, actor: human, mentionsSelf: false, disposition: "store_only" }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["sticker"], decision: "skip", reason: "store_only" });

    await pushAndSettle(h, message({ text: "[不支持的消息类型：unknown]", messageId: "bad", scope, actor: human, mentionsSelf: false, disposition: "unsupported" }));
    expect(gateDecisions(logs).at(-1)).toMatchObject({ messageIds: ["bad"], decision: "skip", reason: "unsupported" });

    h.channel.push(message({ text: "boom", messageId: "g5", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("g5"), "buffered boom");
    await h.host.settle();
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(gateDecisions(logs).at(-1)).toMatchObject({
      messageIds: ["g5"],
      decision: "skip",
      reason: "judge_failed",
      source: "judge",
      error: "light model down",
    });
    expect(logs.events.some((item) => item.event === "judge.failed")).toBe(true);
    expect(h.channel.sent.filter((item) => item.action.type === "text" && item.action.text === "front")).toHaveLength(3);
  });

  it("passes fast through the front, back, and light profiles", async () => {
    const h = await startHarness((config) => {
      config.agents.front.fast = true;
      config.agents.front.network = true;
      config.agents.front.model = "main-model";
      config.agents.front.lightModel = "light-model";
      config.agents.back.fast = true;
      config.agents.back.network = true;
      config.agents.back.model = "back-model";
      config.im.gate.debounceMs = 1_000;
    });
    h.runtime.handler = async (turn) => {
      turn.emit({ type: "turn.completed", text: turn.spec.kind === "judge" ? "RESPOND" : "ok" });
    };
    await pushAndSettle(h, message({ text: "hi", messageId: "f1" }));
    expect(h.runtime.opens.find((item) => item.kind === "conversation")?.profile).toMatchObject({
      model: "main-model",
      fast: true,
      network: true,
    });
    expect(h.runtime.opens.find((item) => item.kind === "conversation")?.profile.cwd).toMatch(/\/front$/);
    const parent = conversation(h);
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "work", followUpEnabled: false });
    expect(started.status).toBe(200);
    await h.host.settle();
    expect(h.runtime.opens.find((item) => item.kind === "task")?.profile).toMatchObject({
      model: "back-model",
      fast: true,
      network: true,
    });
    const scope = { channel: "memory", kind: "topic" as const, id: "omt_fast", parentId: "oc_family" };
    const human = { channel: "memory", ref: "ou_s", stableId: "feishu:on_stranger", name: "Sam", isBot: false };
    await pushAndSettle(h, message({ text: "@bot", messageId: "f2", scope, actor: human, mentionsSelf: true }));
    h.channel.push(message({ text: "later", messageId: "f3", scope, actor: human, mentionsSelf: false }));
    await waitFor(() => h.host.snapshot().seenMessageIds.includes("f3"), "seen later");
    await h.host.settle();
    h.clock.advance(1_000);
    await h.host.flushGate();
    await h.host.settle();
    expect(h.runtime.opens.find((item) => item.kind === "judge")?.profile).toMatchObject({
      model: "light-model",
      fast: true,
      network: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  });

  it("stores every DM in imlog and logs turn.prep cold then warm", async () => {
    const dir = await tempDir();
    const config = await testConfig(dir);
    const clock = new ManualClock(Date.parse("2026-03-15T02:00:00.000Z"));
    const channel = new MemoryChannel(true);
    const runtime = new ScriptedRuntime("codex");
    runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "pong" });
    const host = await createHost({
      config,
      channel,
      runtimes: new Map([["codex", runtime]]),
      clock,
      logger: new Logger(join(dir, "log.jsonl"), "info"),
      bot: { ref: "ou_bot", stableId: "memory:bot", name: "Larkling" },
      timers: false,
    });
    await host.start();
    channel.push(message({ text: "ping", messageId: "dm1", mentionsSelf: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.settle();
    const { ImLog } = await import("../src/core/imlog.js");
    const log = new ImLog(dir);
    const stored = await log.load("ou_owner");
    expect(stored.some((item) => item.messageId === "dm1" && !item.fromBot)).toBe(true);
    expect(stored.some((item) => item.fromBot && item.text === "pong")).toBe(true);
    const lines = (await readFile(join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const preps = lines.filter((line) => line.event === "turn.prep");
    expect(preps.length).toBeGreaterThanOrEqual(1);
    expect(preps[0]).toMatchObject({ cold: true });
    for (const key of ["ensureRuntimeMs", "seedMs", "openMs", "buildTurnMs", "historyMs", "audioMs", "totalMs"] as const) {
      expect(typeof preps[0][key]).toBe("number");
    }
    channel.push(message({ text: "again", messageId: "dm2", mentionsSelf: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.settle();
    const lines2 = (await readFile(join(dir, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const preps2 = lines2.filter((line) => line.event === "turn.prep");
    expect(preps2.at(-1)).toMatchObject({ cold: false, openMs: 0, seedMs: 0 });
    await host.stop();
  });

});

function gateDecisions(logs: CaptureLogger): Record<string, unknown>[] {
  return logs.events.filter((item) => item.event === "gate.decision").map((item) => item.fields);
}

function turnJson(context: string) {
  const at = context.indexOf("Turn input:\n");
  if (at < 0) throw new Error("no turn input");
  return JSON.parse(context.slice(at + "Turn input:\n".length));
}
