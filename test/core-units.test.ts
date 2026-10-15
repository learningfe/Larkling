import { describe, expect, it } from "vitest";
import { classifyArrival, takeBatch, withoutMessage } from "../src/core/delivery.js";
import { Gate } from "../src/core/gate.js";
import { ManualClock } from "../src/core/clock.js";
import { PersonDirectory } from "../src/core/persons.js";
import { resolveTrust } from "../src/core/trust.js";
import { selectWindow, unreadCount } from "../src/core/window.js";
import { renderEnvelope } from "../src/channels/envelope.js";
import type { ImRecord, QueuedInput } from "../src/protocol/types.js";
import { groupScope, message, OWNER_ID, tempDir, testConfig } from "./helpers.js";

const actor = { channel: "memory", ref: "ou", stableId: "s", name: "Ada", isBot: false };

function queued(text: string, kind: "message" | "task_event" | "prompt" = "message"): QueuedInput {
  if (kind === "task_event") return { kind, taskId: "t1", reason: "ended", text, at: "2026-03-15T00:00:00.000Z" };
  if (kind === "prompt") return { kind, text };
  return { kind, messageId: text, actor, trust: "owner", text, attachments: [], occurredAt: "2026-03-15T00:00:00.000Z" };
}

function record(id: string, text: string, at: string): ImRecord {
  return {
    messageId: id,
    scope: groupScope(),
    actor,
    text,
    attachments: [],
    mentionsSelf: false,
    occurredAt: at,
  };
}

describe("delivery table", () => {
  it("steers a running session and otherwise enqueues", () => {
    const input = queued("hi");
    expect(classifyArrival("running", { steer: true }, input)).toBe("steer");
    expect(classifyArrival("running", { steer: false }, input)).toBe("enqueue");
    expect(classifyArrival("idle", { steer: true }, input)).toBe("enqueue");
    expect(classifyArrival("awaiting_approval", { steer: true }, input)).toBe("enqueue");
  });

  it("merges adjacent user messages and isolates task events", () => {
    const queue = [queued("a"), queued("b", "prompt"), queued("done", "task_event"), queued("c")];
    const first = takeBatch(queue);
    expect(first.batch.map((item) => item.kind)).toEqual(["message", "prompt"]);
    const second = takeBatch(first.rest);
    expect(second.batch).toHaveLength(1);
    expect(second.batch[0].kind).toBe("task_event");
    expect(withoutMessage(queue, "a").some((item) => item.kind === "message" && item.messageId === "a")).toBe(false);
  });
});

describe("trust", () => {
  it("lets group humans inherit the parent chat and keeps unlisted bots denied", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.trust.groups = ["oc_family"];
    });
    const human = { channel: "memory", ref: "ou_x", stableId: "feishu:on_stranger", name: "X", isBot: false };
    const bot = { channel: "memory", ref: "ou_b", stableId: "feishu:on_bot", name: "B", isBot: true };
    expect(resolveTrust(human, { channel: "memory", kind: "group", id: "oc_family" }, config)).toBe("allowed");
    expect(resolveTrust(human, { channel: "memory", kind: "topic", id: "omt_1", parentId: "oc_family" }, config)).toBe("allowed");
    expect(resolveTrust(human, { channel: "memory", kind: "dm", id: "ou_x" }, config)).toBe("denied");
    expect(resolveTrust(bot, { channel: "memory", kind: "group", id: "oc_family" }, config)).toBe("denied");
    expect(resolveTrust({ ...human, stableId: OWNER_ID }, undefined, config)).toBe("owner");
  });
});

describe("gate", () => {
  it("resets the trailing debounce and drops mentions of other people", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.im.respondTo.default = "relevant";
      draft.im.gate.debounceMs = 5_000;
    });
    const clock = new ManualClock(1_000);
    const gate = new Gate(config, true, clock);
    const scope = groupScope();
    const first = message({ text: "a", scope, messageId: "1", mentionsSelf: false, occurredAt: "t" });
    expect(gate.accept(first, "allowed")).toBe("buffered");
    clock.advance(4_000);
    const second = message({ text: "b", scope, messageId: "2", mentionsSelf: false, occurredAt: "t" });
    expect(gate.accept(second, "allowed")).toBe("buffered");
    expect(gate.due(clock.now())).toHaveLength(0);
    clock.advance(5_000);
    expect(gate.due(clock.now())[0].messages.map((item) => item.messageId)).toEqual(["1", "2"]);
    const other = message({ text: "c", scope, messageId: "3", mentionsSelf: false, mentionsOthers: true });
    expect(gate.accept(other, "allowed")).toBe("dropped");
    const mention = message({ text: "d", scope, messageId: "4", mentionsSelf: true });
    expect(gate.accept(mention, "allowed")).toEqual([mention]);
  });

  it("judges a topic the bot has replied in unless that scope is configured", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.im.respondTo.default = "mention";
    });
    const clock = new ManualClock(1_000);
    const gate = new Gate(config, true, clock, () => ["omt_joined"]);
    const joined = { channel: "memory", kind: "topic" as const, id: "omt_joined", parentId: "oc_family" };
    const other = { channel: "memory", kind: "topic" as const, id: "omt_other", parentId: "oc_family" };
    expect(gate.modeFor(joined)).toBe("relevant");
    expect(gate.modeFor(other)).toBe("mention");
    const quiet = message({ text: "later", scope: joined, messageId: "q1", mentionsSelf: false });
    expect(gate.accept(quiet, "allowed")).toBe("buffered");
    config.im.respondTo.scopes.omt_joined = "mention";
    expect(gate.modeFor(joined)).toBe("mention");
    const skipped = message({ text: "nope", scope: joined, messageId: "q2", mentionsSelf: false });
    expect(gate.accept(skipped, "allowed")).toBe("dropped");
  });
});

describe("persons", () => {
  it("keeps the newest name first and merges only when asked", async () => {
    const dir = await tempDir();
    const people = await PersonDirectory.open(dir);
    await people.observe(actor, "2026-01-01T00:00:00.000Z");
    await people.observe({ ...actor, name: "Ada Lovelace", ref: "ou_new" }, "2026-02-01T00:00:00.000Z");
    expect(people.displayName(actor.stableId)).toBe("Ada Lovelace");
    expect(people.byStableId(actor.stableId)?.refs[0]).toBe("ou_new");
    const other = await people.observe({ channel: "memory", ref: "ou_2", stableId: "other", name: "Bob", isBot: false }, "2026-02-02T00:00:00.000Z");
    const merged = await people.merge(actor.stableId, other.personId, "2026-02-03T00:00:00.000Z");
    expect(merged.identities).toContain("other");
    expect(people.byStableId("other")?.personId).toBe(actor.stableId);
    expect(people.findByName("bob")).toHaveLength(1);
    const named = await people.observe(
      { channel: "feishu", ref: "ou_real", stableId: "feishu:ou_real", name: "陈", isBot: false, aliases: ["feishu-union:on_real"] },
      "2026-02-04T00:00:00.000Z",
    );
    expect(named.refs[0]).toBe("ou_real");
    expect(named.identities).toContain("feishu-union:on_real");
    expect(people.byStableId("feishu-union:on_real")?.personId).toBe("feishu:ou_real");
  });
});

describe("window and envelope", () => {
  it("keeps the topic root and reports unread messages after the bot", () => {
    const root = record("root", "topic", "2026-03-01T00:00:00.000Z");
    const messages = [root, record("m1", "a", "2026-03-02T00:00:00.000Z"), record("m2", "bbbbbbbb", "2026-03-03T00:00:00.000Z"), record("m3", "c", "2026-03-04T00:00:00.000Z")];
    const selected = selectWindow(messages, { limit: 2, maxTokens: 100, root });
    expect(selected.map((item) => item.messageId)).toEqual(["root", "m2", "m3"]);
    expect(unreadCount(messages, ["m3"], (item) => item.messageId === "m1")).toBe(1);
    expect(unreadCount(messages, ["m3"], () => false)).toBe(0);
    const aged = selectWindow(messages, { limit: 10, maxTokens: 4000, root, maxAgeMs: 60_000, now: Date.parse("2026-03-04T00:00:00.000Z") });
    expect(aged.map((item) => item.messageId)).toEqual(["m3"]);
    const undated = record("bad", "x", "not-a-date");
    const kept = selectWindow([root, undated, record("m3", "c", "2026-03-04T00:00:00.000Z")], {
      limit: 10,
      maxTokens: 4000,
      maxAgeMs: 60_000,
      now: Date.parse("2026-03-04T00:00:00.000Z"),
    });
    expect(kept.map((item) => item.messageId)).toEqual(["m3", "bad"]);
  });

  it("renders self as 我 and includes the year outside the current year", () => {
    const now = new Date("2026-03-15T00:00:00.000Z");
    const same = renderEnvelope({ name: "Ada", isSelf: true, occurredAt: "2026-03-15T02:05:00.000Z", messageId: "om", body: "hi", timeZone: "Asia/Shanghai", now });
    expect(same.startsWith("[我 03-15 10:05 #om]")).toBe(true);
    const older = renderEnvelope({ name: "Ada", isSelf: false, occurredAt: "2024-01-02T00:30:00.000Z", messageId: "old", body: "x", timeZone: "Asia/Shanghai", now });
    expect(older.startsWith("[Ada 2024-01-02 08:30 #old]")).toBe(true);
  });
});
