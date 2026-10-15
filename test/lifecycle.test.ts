import { describe, expect, it } from "vitest";
import { conversationSessionId } from "../src/protocol/types.js";
import { message, pushAndSettle, startHarness, waitFor } from "./helpers.js";

describe("session lifecycle", () => {
  it("releases an idle conversation and reseeds when instructions cannot be updated", async () => {
    const h = await startHarness((config) => {
      config.runtimes.codex.idleReleaseMs = 1_000;
    });
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "hello", messageId: "m1" }));
    const sessionId = conversationSessionId({ channel: "memory", kind: "dm", id: "ou_owner" });
    expect(h.host.snapshot().sessions[sessionId].live).toBe(true);
    h.clock.advance(1_000);
    await h.host.tick();
    expect(h.host.snapshot().sessions[sessionId].live).toBe(false);
    expect(h.runtime.releases.length).toBeGreaterThan(0);

    h.runtime.instructionResult = "unsupported";
    h.config.agents.front.instructions = "front instructions changed";
    await pushAndSettle(h, message({ text: "again", messageId: "m2" }));
    expect(h.runtime.instructionUpdates.length).toBeGreaterThan(0);
    const reopened = h.runtime.opens.at(-1);
    expect(reopened?.runtimeRef).toBeUndefined();
    expect(reopened?.seed?.text).toContain("hello");
  });

  it("applies an instruction update in place when the runtime supports it", async () => {
    const h = await startHarness((config) => {
      config.runtimes.codex.idleReleaseMs = 1_000;
    });
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "hello", messageId: "m1" }));
    h.clock.advance(1_000);
    await h.host.tick();
    const ref = h.host.snapshot().sessions[conversationSessionId({ channel: "memory", kind: "dm", id: "ou_owner" })].runtimeRef;
    h.runtime.instructionResult = "applied";
    h.config.agents.front.instructions = "rewritten";
    await pushAndSettle(h, message({ text: "again", messageId: "m2" }));
    expect(h.runtime.instructionUpdates.at(-1)?.instructions).toContain("rewritten");
    expect(h.runtime.opens.at(-1)?.runtimeRef).toBe(ref);
  });

  it("reseeds when resuming a saved runtime ref fails", async () => {
    const h = await startHarness((config) => {
      config.runtimes.codex.idleReleaseMs = 1_000;
    });
    h.runtime.handler = async (turn) => turn.emit({ type: "turn.completed", text: "ok" });
    await pushAndSettle(h, message({ text: "hello", messageId: "m1" }));
    h.clock.advance(1_000);
    await h.host.tick();
    h.runtime.failResume = true;
    await pushAndSettle(h, message({ text: "again", messageId: "m2" }));
    expect(h.runtime.opens.at(-1)?.seed?.text).toContain("hello");
    expect(h.channel.sent.at(-1)?.action).toMatchObject({ type: "text", text: "ok" });
  });

  it("evicts the least recently used idle session instead of a running one", async () => {
    const h = await startHarness((config) => {
      config.runtimes.codex.maxLiveSessions = 1;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.handler = async (turn) => {
      if (turn.input.messages.some((item) => item.text === "hold")) await gate;
      turn.emit({ type: "turn.completed", text: "ok" });
    };
    await pushAndSettle(h, message({ text: "first", messageId: "m1", scope: { channel: "memory", kind: "dm", id: "ou_owner" } }));
    const firstId = conversationSessionId({ channel: "memory", kind: "dm", id: "ou_owner" });
    h.channel.push(message({ text: "hold", messageId: "m2", scope: { channel: "memory", kind: "dm", id: "ou_other" }, actor: { channel: "memory", ref: "ou_other", stableId: "feishu:on_trusted", name: "T", isBot: false } }));
    await waitFor(() => h.host.snapshot().sessions[conversationSessionId({ channel: "memory", kind: "dm", id: "ou_other" })]?.phase === "running", "second running");
    expect(h.host.snapshot().sessions[firstId].live).toBe(false);
    expect(h.host.snapshot().sessions[conversationSessionId({ channel: "memory", kind: "dm", id: "ou_other" })].live).toBe(true);
    release();
    await h.host.settle();
  });
});
