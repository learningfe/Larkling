import { describe, expect, it } from "vitest";
import { advanceMark, localIso, newSince, shortLocal, toTurnMessage, type HistoryMark } from "../src/core/turninput.js";
import type { ImRecord } from "../src/protocol/types.js";

const rec = (id: string, ms: number, ref = "ou_u", mentions?: ImRecord["mentions"]): ImRecord => ({
  messageId: id,
  scope: { channel: "feishu", kind: "group", id: "oc_1" },
  actor: { channel: "feishu", ref, stableId: `feishu:${ref}`, name: ref, isBot: ref === "ou_bot" },
  text: id,
  attachments: [],
  mentionsSelf: false,
  mentions,
  occurredAt: new Date(ms).toISOString(),
});

describe("incremental history", () => {
  it("drops delivered ids and older messages but keeps unseen ones in the same millisecond second", () => {
    const mark: HistoryMark = { runtimeRef: "r", highMs: 0, seen: new Set() };
    advanceMark(mark, [rec("a", 10_000), rec("b", 10_400)]);
    expect(mark.highMs).toBe(10_400);
    // start_time floors to 10s, so a and b come back; c shares b's ms; d is new.
    const fetched = [rec("a", 10_000), rec("b", 10_400), rec("c", 10_400), rec("d", 10_900)];
    expect(newSince(fetched, mark).map((item) => item.messageId)).toEqual(["c", "d"]);
  });
});

describe("turn message shape", () => {
  it("marks self on sender and mentions and uses local time", () => {
    const self = (ref: string) => ref === "ou_bot";
    const message = toTurnMessage(rec("m", Date.parse("2026-10-16T01:55:10Z"), "ou_zhang", [{ ref: "ou_bot", name: "Larkling" }, { ref: "all", name: "所有人" }]), {
      timeZone: "Asia/Shanghai",
      now: new Date("2026-10-16T02:00:00Z"),
      isSelf: self,
      nameOf: () => "张三",
    });
    expect(message).toEqual({
      messageId: "m",
      sender: { openId: "ou_zhang", name: "张三", isSelf: false },
      at: "09:55:10",
      mentions: [
        { openId: "ou_bot", name: "Larkling", isSelf: true },
        { openId: "all", name: "所有人", isSelf: false },
      ],
      body: "m",
    });
    expect(localIso("2026-10-16T01:55:10Z", "Asia/Shanghai")).toBe("2026-10-16T09:55:10+08:00");
    expect(shortLocal("2026-10-15T01:55:10Z", "Asia/Shanghai", new Date("2026-10-16T02:00:00Z"))).toBe("10-15 09:55:10");
  });
});
