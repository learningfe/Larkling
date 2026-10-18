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
  const human = { channel: "memory", ref: "ou_x", stableId: "feishu:on_stranger", name: "X", isBot: false };
  const bot = { channel: "memory", ref: "ou_b", stableId: "feishu:on_bot", name: "B", isBot: true };
  const allowed = { ...human, ref: "ou_a", stableId: "feishu:on_allowed", name: "A" };
  const trusted = { ...human, ref: "ou_t", stableId: "feishu:on_trusted", name: "T" };
  const owner = { ...human, ref: "ou_owner", stableId: OWNER_ID, name: "Owner" };
  const openGroup = { channel: "memory" as const, kind: "group" as const, id: "oc_family" };
  const lockedGroup = { channel: "memory" as const, kind: "group" as const, id: "oc_locked" };
  const dm = { channel: "memory" as const, kind: "dm" as const, id: "ou_x" };
  const openTopic = { channel: "memory" as const, kind: "topic" as const, id: "omt_open", parentId: "oc_family" };
  const lockedTopic = { channel: "memory" as const, kind: "topic" as const, id: "omt_locked", parentId: "oc_locked" };

  it("allows unlisted humans in an ordinary group and keeps unlisted bots out", async () => {
    const config = await testConfig(await tempDir());
    expect(resolveTrust(human, openGroup, config)).toBe("allowed");
    expect(resolveTrust(bot, openGroup, config)).toBe("denied");
    expect(resolveTrust(human, openTopic, config)).toBe("allowed");
    expect(resolveTrust(bot, openTopic, config)).toBe("denied");
    expect(resolveTrust({ ...bot, stableId: "feishu:on_trusted" }, openGroup, config)).toBe("trusted");
    expect(resolveTrust(trusted, openGroup, config)).toBe("trusted");
    expect(resolveTrust(owner, openGroup, config)).toBe("owner");
  });

  it("keeps a restricted group and its topics on the personal allowlist", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.trust.restricted = ["oc_locked"];
    });
    expect(resolveTrust(human, lockedGroup, config)).toBe("denied");
    expect(resolveTrust(bot, lockedGroup, config)).toBe("denied");
    expect(resolveTrust(allowed, lockedGroup, config)).toBe("allowed");
    expect(resolveTrust(trusted, lockedGroup, config)).toBe("trusted");
    expect(resolveTrust(owner, lockedGroup, config)).toBe("owner");
    expect(resolveTrust(human, lockedTopic, config)).toBe("denied");
    expect(resolveTrust(bot, lockedTopic, config)).toBe("denied");
    expect(resolveTrust(allowed, lockedTopic, config)).toBe("allowed");
    expect(resolveTrust(trusted, lockedTopic, config)).toBe("trusted");
    expect(resolveTrust(owner, lockedTopic, config)).toBe("owner");
    expect(resolveTrust(human, openGroup, config)).toBe("allowed");
    expect(resolveTrust(bot, openTopic, config)).toBe("denied");
  });

  it("authorizes DMs only for the owner and the personal allowlist", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.trust.restricted = ["oc_locked"];
    });
    expect(resolveTrust(human, dm, config)).toBe("denied");
    expect(resolveTrust(bot, dm, config)).toBe("denied");
    expect(resolveTrust(allowed, dm, config)).toBe("allowed");
    expect(resolveTrust(trusted, dm, config)).toBe("trusted");
    expect(resolveTrust(owner, dm, config)).toBe("owner");
    expect(resolveTrust(owner, undefined, config)).toBe("owner");
    expect(resolveTrust(human, undefined, config)).toBe("denied");
    const orphan = { channel: "memory" as const, kind: "topic" as const, id: "omt_orphan" };
    expect(resolveTrust(human, orphan, config)).toBe("denied");
    expect(resolveTrust(bot, orphan, config)).toBe("denied");
    expect(resolveTrust(allowed, orphan, config)).toBe("allowed");
  });

  it("locks a topic whose own id is restricted even when the parent group is open", async () => {
    const config = await testConfig(await tempDir(), (draft) => {
      draft.trust.restricted = ["omt_named"];
    });
    const topic = { channel: "memory" as const, kind: "topic" as const, id: "omt_named", parentId: "oc_family" };
    expect(resolveTrust(human, topic, config)).toBe("denied");
    expect(resolveTrust(bot, topic, config)).toBe("denied");
    expect(resolveTrust(allowed, topic, config)).toBe("allowed");
    expect(resolveTrust(human, openGroup, config)).toBe("allowed");
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
      { channel: "feishu", ref: "ou_real", stableId: "feishu:ou_real", name: "陈", isBot: false },
      "2026-02-04T00:00:00.000Z",
    );
    expect(named.refs[0]).toBe("ou_real");
    expect(named.identities).toEqual(["feishu:ou_real"]);
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

describe("imlog.shouldStore", () => {
  it("keeps every DM message and mentions or participated topics", async () => {
    const { ImLog } = await import("../src/core/imlog.js");
    const log = new ImLog(await tempDir());
    const dm = { channel: "memory" as const, kind: "dm" as const, id: "ou_x" };
    const group = { channel: "memory" as const, kind: "group" as const, id: "oc_g" };
    const topic = { channel: "memory" as const, kind: "topic" as const, id: "omt_1", parentId: "oc_g" };
    expect(log.shouldStore({ scope: dm, mentionsSelf: false, fromBot: false }, [])).toBe(true);
    expect(log.shouldStore({ scope: dm, mentionsSelf: false, fromBot: true }, [])).toBe(true);
    expect(log.shouldStore({ scope: group, mentionsSelf: false, fromBot: false }, [])).toBe(false);
    expect(log.shouldStore({ scope: group, mentionsSelf: true, fromBot: false }, [])).toBe(true);
    expect(log.shouldStore({ scope: topic, mentionsSelf: false, fromBot: false }, [])).toBe(false);
    expect(log.shouldStore({ scope: topic, mentionsSelf: false, fromBot: false }, ["omt_1"])).toBe(true);
  });
});
