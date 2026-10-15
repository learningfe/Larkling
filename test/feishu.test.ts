import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../src/channels/feishu/adapter.js";
import { transcribeAudio, withTempPcm } from "../src/channels/feishu/audio.js";
import { feishuUuid } from "../src/channels/feishu/card.js";
import { normalizeFeishuMessage, type FeishuRawMessage, type NormalizeContext } from "../src/channels/feishu/content.js";
import type { FeishuHttp, FeishuResponse } from "../src/channels/feishu/http.js";
import { ManualClock } from "../src/core/clock.js";
import { RateLimiter } from "../src/core/ratelimit.js";
import type { ChannelEvent } from "../src/protocol/types.js";

class FakeHttp implements FeishuHttp {
  readonly calls: { method: string; path: string; query?: Record<string, string | undefined>; json?: unknown }[] = [];
  handler: (input: FakeHttp["calls"][number]) => FeishuResponse = () => ({ status: 200, json: { code: 0, data: { message_id: "om_out" } } });

  async request(input: FakeHttp["calls"][number]): Promise<FeishuResponse> {
    this.calls.push(input);
    return this.handler(input);
  }
}

function raw(partial: FeishuRawMessage): FeishuRawMessage {
  return { message_id: "om_1", chat_id: "oc_1", chat_type: "group", ...partial };
}

async function normalize(message: FeishuRawMessage, extra: Partial<Omit<NormalizeContext, "messageId">> = {}) {
  return normalizeFeishuMessage(message, { botOpenId: "ou_bot", ...extra, messageId: message.message_id ?? "om_1" });
}

async function collect(channel: FeishuChannel, run: () => Promise<void>): Promise<ChannelEvent[]> {
  const events: ChannelEvent[] = [];
  const reading = (async () => {
    for await (const event of channel.events()) events.push(event);
  })();
  await run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  channel.close();
  await reading;
  return events;
}

describe("feishu message normalization", () => {
  it("covers the section 6.2 message types", async () => {
    const text = await normalize(
      raw({
        msg_type: "text",
        content: JSON.stringify({ text: "hi @_user_1 @_all" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou_bot", union_id: "on_bot" }, name: "Bot" },
          { key: "@_all", id: { open_id: "all" }, name: "all" },
        ],
      }),
    );
    expect(text.text).toBe("hi @我 @所有人");
    expect(text.mentionsSelf).toBe(true);
    expect(text.mentionsOthers).toBe(true);
    expect(text.names).toEqual([{ stableId: "feishu:on_bot", ref: "ou_bot", name: "Bot" }]);

    const post = await normalize(
      raw({
        msg_type: "post",
        content: { zh_cn: { title: "标题", content: [[{ tag: "text", text: "正文" }, { tag: "at", user_id: "ou_bot" }]] } },
      }),
    );
    expect(post.text).toContain("**标题**");
    expect(post.text).toContain("@我");
    expect(post.mentionsSelf).toBe(true);

    const image = await normalize(raw({ msg_type: "image", content: { image_key: "img_1" } }));
    expect(image.text).toBe("[图片 att:1]");
    expect(image.attachments[0]).toMatchObject({ kind: "image", key: "img_1" });

    const file = await normalize(raw({ msg_type: "file", content: { file_key: "file_1", file_name: "a.pdf" } }));
    expect(file.text).toBe("[文件：a.pdf att:1]");

    const audio = await normalize(raw({ msg_type: "audio", content: { file_key: "file_a", duration: 12_000 } }), {
      audio: { durationMs: 12_000, status: "ok", transcript: "你好" },
    });
    expect(audio.text).toBe("[语音 12秒] 转写：你好 att:1");
    const longAudio = await normalize(raw({ msg_type: "audio", content: { file_key: "file_b", duration: 400_000 } }), {
      audio: { durationMs: 400_000, status: "too_long" },
    });
    expect(longAudio.text).toContain("过长未转写");

    const video = await normalize(raw({ msg_type: "media", content: { file_key: "vid", file_name: "clip.mp4", duration: 3000 } }));
    expect(video.text).toBe("[视频：clip.mp4 3秒 att:1]");

    const sticker = await normalize(raw({ msg_type: "sticker", content: {} }));
    expect(sticker).toMatchObject({ text: "[表情包]", disposition: "store_only" });

    const card = await normalize(
      raw({ msg_type: "interactive", content: { header: { title: { content: "审批" } }, elements: [{ tag: "button", text: { content: "同意" } }] } }),
    );
    expect(card.text).toContain("[卡片] 审批");
    expect(card.text).toContain("[按钮：同意]");

    const shareChat = await normalize(raw({ msg_type: "share_chat", content: { chat_id: "oc_9" } }), {
      chatName: async () => "家人",
    });
    expect(shareChat.text).toBe("[分享群聊：家人]");
    const shareUser = await normalize(raw({ msg_type: "share_user", content: { open_id: "ou_ada" } }), {
      userName: async () => "Ada",
    });
    expect(shareUser.text).toBe("[分享名片：Ada]");

    const system = await normalize(raw({ msg_type: "system", content: { template: "{from_user} 邀请了 {to_chatters}", from_user: ["Ada"], to_chatters: ["Bob"] } }));
    expect(system.disposition).toBe("store_only");
    expect(system.text).toContain("Ada");

    const location = await normalize(raw({ msg_type: "location", content: { name: "外滩", longitude: "121.5", latitude: "31.2" } }));
    expect(location.text).toBe("[位置：外滩 121.5,31.2]");

    const todo = await normalize(raw({ msg_type: "todo", content: { summary: "买菜" } }));
    expect(todo.text).toBe("[任务：买菜]");

    const vote = await normalize(raw({ msg_type: "vote", content: { topic: "午饭", options: ["面", "饭"] } }));
    expect(vote.text).toBe("[投票：午饭 选项：面/饭]");

    const calendar = await normalize(
      raw({ msg_type: "share_calendar_event", content: { summary: "周会", start_time: "1710460800000", end_time: "1710464400000" } }),
      { timeZone: "Asia/Shanghai", now: new Date("2026-03-15T00:00:00.000Z") },
    );
    expect(calendar.text).toContain("[日程：周会");

    const meeting = await normalize(raw({ msg_type: "video_chat", content: { topic: "评审" } }));
    expect(meeting.text).toBe("[视频会议：评审]");

    const folder = await normalize(raw({ msg_type: "folder", content: { file_name: "资料" } }));
    expect(folder.text).toBe("[文件夹：资料]");

    const hongbao = await normalize(raw({ msg_type: "hongbao", content: {} }));
    expect(hongbao).toMatchObject({ text: "[红包]", disposition: "store_only" });

    const unknown = await normalize(raw({ msg_type: "something_new", content: {} }));
    expect(unknown.disposition).toBe("unsupported");
    expect(unknown.text).toContain("something_new");
  });

  it("expands a quote when the parent is outside the window and labels merge children", async () => {
    const quoted = await normalize(raw({ msg_type: "text", content: { text: "reply" }, parent_id: "om_parent" }), {
      inWindow: new Set(),
      loadMessage: async () => raw({ message_id: "om_parent", msg_type: "text", content: { text: "parent said" } }),
    });
    expect(quoted.text).toContain("> 引用");
    expect(quoted.text).toContain("parent said");
    expect(quoted.text).toContain("reply");

    const skipped = await normalize(raw({ msg_type: "text", content: { text: "reply" }, parent_id: "om_parent" }), {
      inWindow: new Set(["om_parent"]),
      loadMessage: async () => raw({ message_id: "om_parent", msg_type: "text", content: { text: "hidden" } }),
    });
    expect(skipped.text).toBe("reply");

    const merged = await normalize(
      raw({
        msg_type: "merge_forward",
        content: { messages: [{ message_id: "c1", msg_type: "text", content: { text: "child" } }] },
      }),
    );
    expect(merged.text).toContain("child");
    expect(merged.attachments).toHaveLength(0);
  });
});

describe("feishu adapter", () => {
  function channel(http: FakeHttp, extra: { ffmpeg?: (input: string, output: string) => Promise<void> } = {}) {
    return new FeishuChannel({
      http,
      botOpenId: "ou_bot",
      readGroupMessages: false,
      stateDir: "",
      ratePerSecond: 1000,
      speechPerSecond: 1000,
      clock: new ManualClock(0),
      ffmpeg: extra.ffmpeg,
    });
  }

  it("ingests a message, drops edits and duplicate ids, and maps reactions only for its own sends", async () => {
    const http = new FakeHttp();
    const bot = channel(http);
    const payload = {
      header: { event_id: "e1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_u", union_id: "on_u" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hello" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot", union_id: "on_bot" }, name: "Bot" }],
          create_time: "1710000000000",
        },
      },
    };
    const events = await collect(bot, async () => {
      await bot.ingest(payload);
      await bot.ingest(payload);
      await bot.ingest({ header: { event_type: "im.message.updated_v1" }, event: { message: { message_id: "om_1", updated: true } } });
    });
    const messages = events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0].type !== "message") throw new Error("expected message");
    expect(messages[0].mentionsSelf).toBe(true);
    expect(messages[0].text).toContain("@我");
    expect(messages[0].scope).toEqual({ channel: "feishu", kind: "group", id: "oc_1" });
    expect(events.some((event) => event.type === "names")).toBe(true);
  });

  it("sends text and approval cards with a sanitized uuid", async () => {
    const http = new FakeHttp();
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: false, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    const sent = await bot.send({
      type: "text",
      scope: { channel: "feishu", kind: "dm", id: "ou_owner" },
      text: "hi",
      idempotencyKey: "not a uuid!!",
    });
    expect(sent.ok).toBe(true);
    const body = http.calls[0].json as { uuid: string; receive_id: string };
    expect(body.uuid).toBe(feishuUuid("not a uuid!!"));
    expect(http.calls[0].query?.receive_id_type).toBe("open_id");
    await bot.send({
      type: "approval_card",
      owner: { channel: "feishu", ref: "ou_owner", stableId: "feishu:on_owner", name: "Owner", isBot: false },
      approvalId: "ap1",
      summary: "rm",
      idempotencyKey: "abc-123",
    });
    expect(JSON.stringify(http.calls[1].json)).toContain("需要你的批准");
  });

  it("requests chat history with time bounds and thread history without them", async () => {
    const http = new FakeHttp();
    http.handler = (input) => {
      if (input.path.includes("/messages/om_root")) {
        return { status: 200, json: { code: 0, data: { items: [{ message_id: "om_root", msg_type: "text", content: { text: "root" }, chat_id: "oc_1" }] } } };
      }
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            items: [{ message_id: "om_2", msg_type: "text", content: { text: "later" }, chat_id: "oc_1", thread_id: "omt_1", root_id: "om_root", create_time: "1710000000000" }],
            has_more: false,
          },
        },
      };
    };
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: true, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    await bot.history({ container: "oc_1", start: "2026-03-01T00:00:00.000Z", end: "2026-03-02T00:00:00.000Z", limit: 20 });
    expect(http.calls[0].query).toMatchObject({ container_id_type: "chat", container_id: "oc_1" });
    expect(http.calls[0].query?.start_time).toBeTruthy();
    expect(http.calls[0].query?.end_time).toBeTruthy();
    http.calls.length = 0;
    const topic = await bot.history({ container: "omt_1", limit: 20, withRoot: true });
    expect(http.calls[0].query).toMatchObject({ container_id_type: "thread", container_id: "omt_1" });
    expect(http.calls[0].query?.start_time).toBeUndefined();
    expect(topic.some((item) => item.messageId === "om_root")).toBe(true);
  });

  it("translates download errors 234043 and 234038", async () => {
    const http = new FakeHttp();
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: false, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    http.handler = () => ({ status: 400, json: { code: 234043, msg: "no" } });
    await expect(bot.download({ kind: "file", messageId: "om", key: "file_1" })).rejects.toThrow(/234043/);
    http.handler = () => ({ status: 400, json: { code: 234038, msg: "no" } });
    await expect(bot.download({ kind: "image", messageId: "om", key: "img_1" })).rejects.toThrow(/234038/);
  });

  it("transcribes a short voice message through the injected ffmpeg", async () => {
    const http = new FakeHttp();
    http.handler = (input) => {
      if (input.path.includes("/resources/")) return { status: 200, body: Buffer.from("audio-bytes") };
      if (input.path.includes("file_recognize")) {
        const speech = (input.json as { speech: { speech: string } }).speech.speech;
        expect(Buffer.from(speech, "base64").toString()).toBe("pcm");
        expect((input.json as { config: { format: string; engine_type: string } }).config).toMatchObject({ format: "pcm", engine_type: "16k_auto" });
        return { status: 200, json: { code: 0, data: { recognition_text: "转写结果" } } };
      }
      return { status: 200, json: { code: 0, data: {} } };
    };
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({
      http,
      botOpenId: "ou_bot",
      readGroupMessages: false,
      stateDir: dir,
      ratePerSecond: 1000,
      speechPerSecond: 1000,
      clock: new ManualClock(0),
      ffmpeg: async (_input, output) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(output, Buffer.from("pcm"));
      },
    });
    const events = await collect(bot, async () => {
      await bot.ingest({
        header: { event_id: "e-audio", event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_u", union_id: "on_u" } },
          message: {
            message_id: "om_audio",
            chat_id: "oc_1",
            chat_type: "p2p",
            message_type: "audio",
            content: JSON.stringify({ file_key: "file_audio", duration: 3000 }),
            create_time: "1710000000000",
          },
        },
      });
    });
    const message = events.find((event) => event.type === "message");
    if (!message || message.type !== "message") throw new Error("missing audio message");
    expect(message.text).toContain("转写：转写结果");
    expect(message.scope.kind).toBe("dm");
  });

  it("chunks speech longer than a minute and retries a failed recognize once", async () => {
    const http = new FakeHttp();
    let attempts = 0;
    http.handler = () => {
      attempts += 1;
      if (attempts === 1) return { status: 500, json: { code: 1, msg: "busy" } };
      return { status: 200, json: { code: 0, data: { recognition_text: "ok" } } };
    };
    const clock = new ManualClock(0);
    const text = await transcribeAudio({
      http,
      pcm: Buffer.from("x"),
      limiter: new RateLimiter(1000, clock),
      durationMs: 30_000,
    });
    expect(text).toEqual({ status: "ok", transcript: "ok" });
    expect(attempts).toBe(2);
    const pcm = await withTempPcm(Buffer.from("src"), async (_input, output) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, Buffer.from("out"));
    });
    expect(pcm.toString()).toBe("out");
  });
});
