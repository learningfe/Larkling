import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "../src/core/host.js";
import { StateStore } from "../src/core/state.js";
import { Logger } from "../src/log.js";
import { MemoryChannel } from "../src/channels/memory.js";
import { ManualClock } from "../src/core/clock.js";
import { applyAudience, canonicalAudience, emptyAudience, readAudiencePatch, renderOutboundMentions, storedAudience } from "../src/protocol/audience.js";
import { parseConversationReply } from "../src/protocol/reply.js";
import type { TaskRecord } from "../src/protocol/types.js";
import { ScriptedRuntime } from "../src/runtimes/scripted.js";
import { groupScope, message, post, pushAndSettle, startHarness, testConfig, type Harness } from "./helpers.js";

const alice = { openId: "ou_alice", name: "Alice" };
const bob = { openId: "ou_bob", name: "Bob" };
const carol = { openId: "ou_carol", name: "Carol" };
const bot = { openId: "ou_bot", name: "Larkling" };

function texts(h: Harness): string[] {
  return h.channel.sent.flatMap((item) => (item.action.type === "text" ? [item.action.text] : []));
}

describe("audience normalization", () => {
  it("keeps the earliest role and rejects a non-open id", () => {
    expect(
      canonicalAudience({
        own: [alice],
        drive: [alice, bob],
        track: [bob, carol],
      }),
    ).toEqual({ own: [alice], drive: [bob], track: [carol] });
    expect(canonicalAudience({ own: [alice, { openId: alice.openId, name: "Other" }], drive: [], track: [] })).toEqual({
      own: [alice],
      drive: [],
      track: [],
    });
    expect(applyAudience({ own: [alice], drive: [], track: [] }, { track: [alice, carol] })).toEqual({
      own: [alice],
      drive: [],
      track: [carol],
    });
    expect(applyAudience({ own: [alice], drive: [bob], track: [carol] }, {})).toEqual({
      own: [alice],
      drive: [bob],
      track: [carol],
    });
    expect(applyAudience({ own: [alice], drive: [bob], track: [carol] }, { drive: [] })).toEqual({
      own: [alice],
      drive: [],
      track: [carol],
    });
    expect(applyAudience(undefined, {})).toEqual(emptyAudience());
    expect(storedAudience(undefined)).toEqual(emptyAudience());
    expect(readAudiencePatch({ own: [{ openId: "ou_alice", name: "  Al<ice>\n " }] })).toEqual({
      own: [{ openId: "ou_alice", name: "Alice" }],
    });
    expect(() => readAudiencePatch({ own: [{ openId: "ou_alice", name: "<>" }] })).toThrow(/name is required/);
    expect(() => readAudiencePatch({ own: [{ openId: "on_alice", name: "Alice" }] })).toThrow(/open_id/);
    expect(() => readAudiencePatch({ own: [{ openId: "ou_", name: "Alice" }] })).toThrow(/open_id/);
    expect(() => readAudiencePatch({ owner: [] })).toThrow(/unknown audience field/);
  });

  it("keeps well-formed model mention tags and downgrades the rest", () => {
    const tags = '<at user_id="ou_alice">Alice</at> <at user_id="ou_bob">Bob</at> <at user_id="ou_carol">Carol</at>';
    expect(renderOutboundMentions(`${tags} status`, "group")).toBe(`${tags} status`);
    expect(renderOutboundMentions(`${tags} status`, "topic")).toBe(`${tags} status`);
    expect(renderOutboundMentions('<at user_id="ou_alice">Alice</at> status', "dm")).toBe("@Alice status");
    expect(renderOutboundMentions('see <at user_id="on_evil">Evil</at> <at user_id="all"></at>', "group")).toBe("see @Evil @all");
    expect(renderOutboundMentions('<at user_id="ou_alice">Al<ice>\nEve</at>', "group")).toBe('<at user_id="ou_alice">Alice Eve</at>');
    expect(renderOutboundMentions('before <at user_id="ou_alice">', "group")).toBe("before ");
    expect(renderOutboundMentions(`<at user_id='ou_alice'>Alice</at> <AT user_id="all"></AT>`, "dm")).toBe("@Alice @all");
  });

  it("leaves a notify line as ordinary text", () => {
    expect(parseConversationReply("hello")).toEqual({ kind: "text", text: "hello" });
    expect(parseConversationReply("  [[silent]]  ")).toEqual({ kind: "silent" });
    expect(parseConversationReply("status\n[[notify task_1]]")).toEqual({ kind: "text", text: "status\n[[notify task_1]]" });
    expect(parseConversationReply("say [[notify task_1]] inline")).toEqual({ kind: "text", text: "say [[notify task_1]] inline" });
  });
});

describe("task audience", () => {
  it("partially updates audience, keeps omitted fields, and round-trips through state", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => {
      turn.emit({ type: "turn.completed", text: turn.spec.kind === "check" ? "QUIET" : "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m1" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");

    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", {
      body: "keep this body",
      followUpEnabled: true,
      audience: { own: [alice] },
    });
    expect(started.status).toBe(200);
    expect(started.json.audience).toEqual({ own: [alice], drive: [], track: [] });
    expect(started.json.source.personId).not.toBe(alice.openId);
    await h.host.settle();

    const task = h.host.snapshot().tasks[started.json.taskId] as TaskRecord;
    const versionBefore = task.version;
    const patched = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: task.taskId,
      version: versionBefore,
      audience: { track: [carol] },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.body).toBe("keep this body");
    expect(patched.json.followUpEnabled).toBe(true);
    expect(patched.json.audience).toEqual({ own: [alice], drive: [], track: [carol] });
    expect(patched.json.version).toBe(versionBefore + 1);

    const emptyPatch = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: task.taskId,
      version: patched.json.version,
      audience: {},
    });
    expect(emptyPatch.status).toBe(200);
    expect(emptyPatch.json.body).toBe("keep this body");
    expect(emptyPatch.json.followUpEnabled).toBe(true);
    expect(emptyPatch.json.audience).toEqual({ own: [alice], drive: [], track: [carol] });

    const bodyOnly = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: task.taskId,
      version: emptyPatch.json.version,
      body: "next body",
    });
    expect(bodyOnly.status).toBe(200);
    expect(bodyOnly.json.body).toBe("next body");
    expect(bodyOnly.json.followUpEnabled).toBe(true);
    expect(bodyOnly.json.audience).toEqual({ own: [alice], drive: [], track: [carol] });

    const invalid = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: task.taskId,
      version: bodyOnly.json.version,
      audience: { drive: [{ openId: "dave", name: "Dave" }] },
    });
    expect(invalid.status).toBe(400);
    expect(h.host.snapshot().tasks[task.taskId].body).toBe("next body");
    expect(h.host.snapshot().tasks[task.taskId].version).toBe(bodyOnly.json.version);

    const listed = await post(h.host.apiUrl, h.host.ownerToken, "/v1/task/list", {});
    expect(listed.json[0].audience).toEqual({ own: [alice], drive: [], track: [carol] });
    const got = await post(h.host.apiUrl, h.host.ownerToken, "/v1/task/get", { taskId: task.taskId });
    expect(got.json.audience).toEqual({ own: [alice], drive: [], track: [carol] });

    const stored = JSON.parse(JSON.stringify(h.host.snapshot().tasks[task.taskId])) as TaskRecord;
    await h.host.stop();
    const reopened = await StateStore.open(h.dir);
    expect(reopened.get().tasks[task.taskId].audience).toEqual(stored.audience);
    expect(reopened.get().tasks[task.taskId].body).toBe("next body");

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
    const again = await post(host.apiUrl, host.ownerToken, "/v1/task/get", { taskId: task.taskId });
    expect(again.json.audience).toEqual({ own: [alice], drive: [], track: [carol] });
    expect(again.json.body).toBe("next body");
    await host.stop();
  });

  it("renders model mention tags through the whitelist and does not @ from a task audience", async () => {
    const h = await startHarness();
    const scope = groupScope("oc_matter");
    h.channel.histories.set(scope.id, [
      {
        messageId: "old",
        scope,
        actor: { channel: "memory", ref: "ou_dave", stableId: "feishu:ou_dave", name: "Dave", isBot: false },
        text: "负责人是 Dave",
        attachments: [],
        mentionsSelf: false,
        occurredAt: "2026-03-15T01:00:00.000Z",
      },
    ]);
    let reply = "hello";
    h.runtime.handler = async (turn) => {
      if (turn.spec.kind !== "conversation") {
        turn.emit({ type: "turn.completed", text: turn.spec.kind === "check" ? "QUIET" : "done" });
        return;
      }
      if (turn.input.context.includes("Task event")) {
        turn.emit({ type: "turn.completed", text: "[[silent]]" });
        return;
      }
      turn.emit({ type: "turn.completed", text: reply });
    };

    await pushAndSettle(h, message({ text: "@bot", messageId: "g1", scope, mentionsSelf: true }));
    expect(texts(h)).toEqual(["hello"]);

    reply = 'hi <at user_id="ou_alice">Alice</at> <at user_id="on_evil">Evil</at> <at user_id="all"></at>';
    await pushAndSettle(h, message({ text: "@bot tags", messageId: "g1b", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe('hi <at user_id="ou_alice">Alice</at> @Evil @all');

    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", { body: "watch the launch" });
    expect(started.status).toBe(200);
    expect(started.json.audience).toEqual({ own: [], drive: [], track: [] });
    await h.host.settle();

    reply = `noted\n[[notify ${started.json.taskId}]]`;
    await pushAndSettle(h, message({ text: "@bot again", messageId: "g2", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe(`noted\n[[notify ${started.json.taskId}]]`);
    expect(texts(h).at(-1)).not.toContain("<at");
    expect(h.runtime.starts.every((item) => !item.input.context.includes("ou_carol"))).toBe(true);

    const version = h.host.snapshot().tasks[started.json.taskId].version;
    const patched = await post(h.host.apiUrl, parent.token, "/v1/task/update", {
      taskId: started.json.taskId,
      version,
      audience: { own: [alice, bot], drive: [bob, alice], track: [carol, bob] },
    });
    expect(patched.status).toBe(200);

    reply = "just chatting";
    await pushAndSettle(h, message({ text: "@bot chat", messageId: "g3", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe("just chatting");

    reply = '<at user_id="ou_carol">Carol</at> <at user_id="ou_alice">Alice</at> launch is on';
    await pushAndSettle(h, message({ text: "@bot status", messageId: "g4", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe('<at user_id="ou_carol">Carol</at> <at user_id="ou_alice">Alice</at> launch is on');

    reply = `ping <at user_id="not-an-id">Evil</at> <at user_id='all'></at>`;
    await pushAndSettle(h, message({ text: "@bot inject", messageId: "g4d", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe("ping @Evil @all");
    expect(texts(h).at(-1)).not.toContain("<at");

    const other = groupScope("oc_other");
    await pushAndSettle(h, message({ text: "@bot", messageId: "o1", scope: other, mentionsSelf: true }));
    const otherParent = Object.values(h.host.snapshot().sessions).find((session) => session.scope?.id === other.id);
    if (!otherParent) throw new Error("missing other conversation");
    const otherTask = await post(h.host.apiUrl, otherParent.token, "/v1/task/start", {
      body: "other matter",
      audience: { own: [{ openId: "ou_erin", name: "Erin" }] },
    });
    expect(otherTask.status).toBe(200);
    await h.host.settle();
    reply = "nope";
    await pushAndSettle(h, message({ text: "@bot wrong", messageId: "g4e", scope, mentionsSelf: true }));
    expect(texts(h).at(-1)).toBe("nope");
    expect(texts(h).join("\n")).not.toContain("ou_erin");

    reply = '<at user_id="ou_alice">Alice</at> dm update';
    await pushAndSettle(h, message({ text: "ping", messageId: "d1" }));
    const dmParent = Object.values(h.host.snapshot().sessions).find((session) => session.scope?.kind === "dm");
    if (!dmParent) throw new Error("missing dm");
    const dmTask = await post(h.host.apiUrl, dmParent.token, "/v1/task/start", {
      body: "dm matter",
      audience: { own: [alice], drive: [bob], track: [carol] },
    });
    expect(dmTask.status).toBe(200);
    await h.host.settle();
    reply = '<at user_id="ou_alice">Alice</at> dm update';
    await pushAndSettle(h, message({ text: "ping again", messageId: "d2" }));
    expect(texts(h).at(-1)).toBe("@Alice dm update");
    expect(h.host.snapshot().tasks[dmTask.json.taskId].audience).toEqual({ own: [alice], drive: [bob], track: [carol] });
  });

  it("reads a task saved before audience existed as empty and does not backfill it", async () => {
    const h = await startHarness();
    h.runtime.handler = async (turn) => {
      turn.emit({ type: "turn.completed", text: turn.spec.kind === "check" ? "QUIET" : "ack" });
    };
    await pushAndSettle(h, message({ text: "go", messageId: "m-legacy" }));
    const parent = Object.values(h.host.snapshot().sessions).find((session) => session.kind === "conversation");
    if (!parent) throw new Error("missing conversation");
    const started = await post(h.host.apiUrl, parent.token, "/v1/task/start", {
      body: "legacy",
      followUpEnabled: true,
      audience: { own: [alice] },
    });
    expect(started.status).toBe(200);
    await h.host.settle();
    const taskId = started.json.taskId as string;
    await h.host.stop();

    const statePath = join(h.dir, "state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8")) as { tasks: Record<string, { audience?: unknown }> };
    delete raw.tasks[taskId].audience;
    await writeFile(statePath, JSON.stringify(raw, null, 2));

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
    const got = await post(host.apiUrl, host.ownerToken, "/v1/task/get", { taskId });
    expect(got.status).toBe(200);
    expect(got.json.audience).toEqual({ own: [], drive: [], track: [] });
    expect(got.json.body).toBe("legacy");
    expect(got.json.followUpEnabled).toBe(true);
    const afterGet = JSON.parse(await readFile(statePath, "utf8")) as { tasks: Record<string, { audience?: unknown; body?: string }> };
    expect(afterGet.tasks[taskId].audience).toBeUndefined();

    const updated = await post(host.apiUrl, host.ownerToken, "/v1/task/update", {
      taskId,
      version: got.json.version,
      body: "still legacy",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.body).toBe("still legacy");
    expect(updated.json.followUpEnabled).toBe(true);
    expect(updated.json.audience).toEqual({ own: [], drive: [], track: [] });
    const afterUpdate = JSON.parse(await readFile(statePath, "utf8")) as { tasks: Record<string, { audience?: unknown; body?: string }> };
    expect(afterUpdate.tasks[taskId].audience).toBeUndefined();
    expect(afterUpdate.tasks[taskId].body).toBe("still legacy");
    await host.stop();
  });
});
