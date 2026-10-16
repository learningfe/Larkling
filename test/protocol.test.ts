import { describe, expect, it } from "vitest";
import { parseCheckReply, parseConversationReply, parseJudgeReply, parseTaskReply } from "../src/protocol/reply.js";
import { activeEntries, buildSeed, transcriptTokens } from "../src/protocol/seed.js";
import type { TranscriptEntry } from "../src/protocol/types.js";
import { estimateTokens } from "../src/util/tokens.js";
import { UnimplementedMemory } from "../src/core/memory.js";

function entry(partial: TranscriptEntry): TranscriptEntry {
  return partial;
}

describe("reply protocol", () => {
  it("treats only an exact [[silent]] conversation reply as silent", () => {
    expect(parseConversationReply("  [[silent]]  ")).toEqual({ kind: "silent" });
    expect(parseConversationReply("hello [[silent]]")).toEqual({ kind: "text", text: "hello [[silent]]" });
    expect(parseConversationReply("answer")).toEqual({ kind: "text", text: "answer" });
  });

  it("wakes a check unless the first line is QUIET", () => {
    expect(parseCheckReply("QUIET\nmore")).toBe("quiet");
    expect(parseCheckReply("quiet")).toBe("quiet");
    expect(parseCheckReply("WAKE")).toBe("wake");
    expect(parseCheckReply("something else")).toBe("wake");
  });

  it("ignores a judge reply unless the first line is RESPOND", () => {
    expect(parseJudgeReply("RESPOND\nbecause")).toBe("respond");
    expect(parseJudgeReply("IGNORE")).toBe("ignore");
    expect(parseJudgeReply("maybe")).toBe("ignore");
  });

  it("keeps the full task result", () => {
    expect(parseTaskReply("  done  ")).toBe("  done  ");
  });
});

describe("seed and tokens", () => {
  it("estimates tokens as ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("keeps the newest active entries that fit, after the latest compaction", () => {
    const entries: TranscriptEntry[] = [
      entry({ seq: 1, at: "t", type: "inbound", messageId: "a", actor: { channel: "memory", ref: "r", stableId: "s", name: "Ada", isBot: false }, trust: "owner", text: "old", attachments: [] }),
      entry({ seq: 2, at: "t", type: "compacted", throughSeq: 1, summary: "summary of old" }),
      entry({ seq: 3, at: "t", type: "inbound", messageId: "b", actor: { channel: "memory", ref: "r", stableId: "s", name: "Ada", isBot: false }, trust: "owner", text: "one", attachments: [] }),
      entry({ seq: 4, at: "t", type: "reply", reply: { kind: "text", text: "two" }, delivered: true }),
    ];
    expect(activeEntries(entries).map((item) => item.seq)).toEqual([2, 3, 4]);
    const seed = buildSeed(entries, 8);
    expect(seed.text).toContain("two");
    expect(seed.throughSeq).toBe(4);
    expect(transcriptTokens(entries)).toBeGreaterThan(0);
  });
});

describe("memory stub", () => {
  it("exposes the interface and refuses to store or recall", async () => {
    const memory = new UnimplementedMemory();
    await expect(memory.recall("p", "q")).rejects.toThrow(/not implemented/);
    await expect(memory.remember("p", "note")).rejects.toThrow(/not implemented/);
  });
});
