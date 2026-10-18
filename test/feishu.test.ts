import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeishuChannel, feishuMessageBody, loadBotProfile, sanitizeAtTags } from "../src/channels/feishu/adapter.js";
import { speechFileId, transcribeAudio, withTempPcm } from "../src/channels/feishu/audio.js";
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
          { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
          { key: "@_all", id: { open_id: "all" }, name: "all" },
        ],
      }),
    );
    expect(text.text).toBe('hi <at user_id="ou_bot">Bot</at> <at user_id="all"></at>');
    expect(text.mentionsSelf).toBe(true);
    expect(text.mentionsOthers).toBe(true);
    expect(text.names).toEqual([{ stableId: "feishu:ou_bot", ref: "ou_bot", name: "Bot" }]);

    const post = await normalize(
      raw({
        msg_type: "post",
        content: { zh_cn: { title: "标题", content: [[{ tag: "text", text: "正文" }, { tag: "at", user_id: "ou_bot" }]] } },
      }),
    );
    expect(post.text).toContain("**标题**");
    expect(post.text).not.toContain("@我");
    expect(post.text).toContain('<at user_id="ou_bot">');
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
        sender: { sender_type: "user", sender_id: { open_id: "ou_u" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hello" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }],
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
    expect(messages[0].text).toContain('<at user_id="ou_bot">Bot</at>');
    expect(messages[0].mentions).toEqual([{ ref: "ou_bot", name: "Bot" }]);
    expect(messages[0].actor.stableId).toBe("feishu:ou_u");
    expect(messages[0].actor).not.toHaveProperty("aliases");
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
    const body = http.calls[0].json as { uuid: string; receive_id: string; msg_type: string };
    expect(body.uuid).toBe(feishuUuid("not a uuid!!"));
    expect(body.msg_type).toBe("text");
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
        return { status: 200, json: { code: 0, data: { items: [{ message_id: "om_root", msg_type: "text", content: { text: "root" }, chat_id: "oc_1", create_time: "1700000000000" }] } } };
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
    expect(http.calls[0].query).toMatchObject({ container_id_type: "chat", container_id: "oc_1", sort_type: "ByCreateTimeDesc" });
    expect(http.calls[0].query?.start_time).toBeTruthy();
    expect(http.calls[0].query?.end_time).toBeTruthy();
    http.calls.length = 0;
    const topic = await bot.history({ container: "omt_1", limit: 20, withRoot: true });
    expect(http.calls[0].query).toMatchObject({ container_id_type: "thread", container_id: "omt_1", sort_type: "ByCreateTimeDesc" });
    expect(http.calls[0].query?.start_time).toBeUndefined();
    expect(topic.some((item) => item.messageId === "om_root")).toBe(true);
    const tight = await bot.history({ container: "omt_1", limit: 1, withRoot: true });
    expect(tight.map((item) => item.messageId)).toEqual(["om_root", "om_2"]);
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
          sender: { sender_type: "user", sender_id: { open_id: "ou_u" } },
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
    http.handler = (input) => {
      expect((input.json as { config: { file_id: string } }).config.file_id).toMatch(/^[a-z0-9]{16}$/);
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
    expect(speechFileId()).toMatch(/^[a-z0-9]{16}$/);
  });

  it("logs speech recognition failures", async () => {
    const http = new FakeHttp();
    const logs: Record<string, unknown>[] = [];
    http.handler = () => ({ status: 200, json: { code: 4001, msg: "invalid file_id" } });
    const failed = await transcribeAudio({
      http,
      pcm: Buffer.from("x"),
      limiter: new RateLimiter(1000, new ManualClock(0)),
      durationMs: 1_000,
      log: (fields) => logs.push(fields),
    });
    expect(failed).toEqual({ status: "failed" });
    expect(logs).toEqual([
      { code: 4001, msg: "invalid file_id", attempt: 0 },
      { code: 4001, msg: "invalid file_id", attempt: 1 },
    ]);
    http.handler = () => {
      throw new Error("socket down");
    };
    logs.length = 0;
    const thrown = await transcribeAudio({
      http,
      pcm: Buffer.from("x"),
      limiter: new RateLimiter(1000, new ManualClock(0)),
      durationMs: 1_000,
      log: (fields) => logs.push(fields),
    });
    expect(thrown.status).toBe("failed");
    expect(logs[0]).toMatchObject({ error: "socket down", attempt: 0 });
  });

  it("reads bot open_id from bot and falls back to data", async () => {
    const http = new FakeHttp();
    http.handler = () => ({ status: 200, json: { code: 0, bot: { open_id: "ou_bot", app_name: "小灵" } } });
    expect(await loadBotProfile(http)).toEqual({ openId: "ou_bot", appName: "小灵" });
    http.handler = () => ({ status: 200, json: { code: 0, data: { open_id: "ou_old", app_name: "旧名" } } });
    expect(await loadBotProfile(http)).toEqual({ openId: "ou_old", appName: "旧名" });
  });

  it("renders real mentions with Feishu <at> tags and lists them; typed @ stays plain text", async () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: "ou_bot" }, name: "SuperGrok" },
      { key: "@_user_2", id: { open_id: "ou_amy" }, name: "Amy" },
    ];
    const text = await normalize(raw({ msg_type: "text", content: { text: "@_user_1 我叫什么 @_user_2" }, mentions }));
    expect(text.text).toBe('<at user_id="ou_bot">SuperGrok</at> 我叫什么 <at user_id="ou_amy">Amy</at>');
    expect(text.mentions).toEqual([{ ref: "ou_bot", name: "SuperGrok" }, { ref: "ou_amy", name: "Amy" }]);
    const typed = await normalize(raw({ msg_type: "text", content: { text: "@_user_1 做完了@我 <at user_id=\"ou_x\">X</at>" }, mentions }));
    expect(typed.text).toBe('<at user_id="ou_bot">SuperGrok</at> 做完了@我 <at user_id="ou_x">X</at>');
    expect(text.mentionsSelf).toBe(true);
    expect(text.mentionsOthers).toBe(true);
    const fallback = await normalize(raw({ msg_type: "text", content: { text: "@_user_1 我叫什么" }, mentions }));
    expect(fallback.text).toBe('<at user_id="ou_bot">SuperGrok</at> 我叫什么');
    const post = await normalize(
      raw({
        msg_type: "post",
        content: { zh_cn: { content: [[{ tag: "at", user_id: "ou_bot", user_name: "SuperGrok" }, { tag: "text", text: " hi " }, { tag: "at", user_id: "ou_amy" }]] } },
        mentions,
      }),
      { mentions },
    );
    expect(post.text).toContain('<at user_id="ou_bot">SuperGrok</at>');
    expect(post.text).not.toContain("小灵");
    expect(post.text).toContain('<at user_id="ou_amy">Amy</at>');
    expect(post.mentions).toEqual([{ ref: "ou_bot", name: "SuperGrok" }, { ref: "ou_amy", name: "Amy" }]);
    expect(post.text).not.toContain("@我");
    expect(post.mentionsSelf).toBe(true);
  });

  it("sends markdown and tables as post md, short plain replies as text", () => {
    const post = feishuMessageBody("**bold**\n- item\n[docs](https://example.com)");
    expect(post.msg_type).toBe("post");
    expect(JSON.parse(post.content)).toEqual({ zh_cn: { content: [[{ tag: "md", text: "**bold**\n- item\n[docs](https://example.com)" }]] } });
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const tablePost = feishuMessageBody(table);
    expect(tablePost.msg_type).toBe("post");
    expect(JSON.parse(tablePost.content)).toEqual({ zh_cn: { content: [[{ tag: "md", text: table }]] } });
    expect(feishuMessageBody("好的").msg_type).toBe("text");
  });

  it("replies in a topic thread with the same rich-text body", async () => {
    const http = new FakeHttp();
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: true, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    await bot.send({
      type: "text",
      scope: { channel: "feishu", kind: "topic", id: "omt_1", parentId: "oc_1" },
      text: "**done**",
      replyTo: "om_1",
      idempotencyKey: "reply-1",
    });
    const body = http.calls[0].json as { msg_type: string; reply_in_thread: boolean; content: string };
    expect(body.msg_type).toBe("post");
    expect(body.reply_in_thread).toBe(true);
    expect(JSON.parse(body.content).zh_cn.content[0][0].tag).toBe("md");
  });

  it("resolves group sender names from chat members and leaves DM names unset", async () => {
    const http = new FakeHttp();
    const memberCalls: string[] = [];
    http.handler = (input) => {
      expect(input.path.includes("/contact/")).toBe(false);
      if (input.path.includes("/members")) {
        memberCalls.push(input.path);
        return {
          status: 200,
          json: { code: 0, data: { items: [{ member_id: "ou_known", name: "陈睿" }, { member_id: "ou_member", name: "群里的人" }] } },
        };
      }
      return { status: 200, json: { code: 0, data: {} } };
    };
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const warnings: Record<string, unknown>[] = [];
    const bot = new FeishuChannel({
      http,
      botOpenId: "ou_bot",
      botName: "小灵",
      readGroupMessages: true,
      stateDir: dir,
      ratePerSecond: 1000,
      clock: new ManualClock(0),
      log: { warn: (_event, fields) => warnings.push(fields ?? {}) },
    });
    const events = await collect(bot, async () => {
      await bot.ingest(receive("ou_known", "om_known"));
      await bot.ingest(receive("ou_member", "om_member"));
      await bot.ingest(receive("ou_known", "om_known_again"));
      await bot.ingest(receive("ou_bot", "om_self", "app"));
      await bot.ingest(receive("ou_dm", "om_dm", "user", "p2p"));
      await bot.ingest(receive("ou_ghost", "om_ghost"));
    });
    const messages = events.filter((event) => event.type === "message");
    expect(messages.map((event) => (event.type === "message" ? event.actor.name : ""))).toEqual(["陈睿", "群里的人", "陈睿", "小灵", "", ""]);
    expect(memberCalls).toEqual([
      "/open-apis/im/v1/chats/oc_1/members",
      "/open-apis/im/v1/chats/oc_1/members",
      "/open-apis/im/v1/chats/oc_1/members",
    ]);
    expect(http.calls.some((call) => call.path.includes("/contact/"))).toBe(false);
    expect(warnings).toEqual([{ openId: "ou_ghost", detail: "no display name" }]);
  });

  it("pages chat history with the time window on every page, start_time floored to seconds", async () => {
    const http = new FakeHttp();
    let page = 0;
    http.handler = () => {
      page += 1;
      const base = 1789000000000 + (10 - page) * 2000;
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            items: [0, 1].map((index) => ({ message_id: `om_${page}_${index}`, create_time: String(base - index * 1000), msg_type: "text", content: { text: "x" }, chat_id: "oc_1" })),
            has_more: page < 3,
            page_token: `p${page}`,
          },
        },
      };
    };
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: true, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    const start = new Date(1789000000500).toISOString();
    const records = await bot.history({ container: "oc_1", start, limit: 500 });
    expect(http.calls).toHaveLength(3);
    expect(http.calls.map((call) => call.query?.start_time)).toEqual(["1789000000", "1789000000", "1789000000"]);
    expect(http.calls.map((call) => call.query?.page_token)).toEqual([undefined, "p1", "p2"]);
    expect(http.calls[0].query?.end_time).toBeUndefined();
    expect(records).toHaveLength(6);
  });

  it("maps the bot's own history sends (sender id_type app_id) to the bot open_id", async () => {
    const http = new FakeHttp();
    http.handler = () => ({
      status: 200,
      json: { code: 0, data: { items: [{ message_id: "om_self", create_time: "1789000000000", msg_type: "text", content: { text: "hi" }, chat_id: "oc_1", sender: { id: "cli_me", id_type: "app_id", sender_type: "app" } }], has_more: false } },
    });
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", appId: "cli_me", readGroupMessages: true, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    const [record] = await bot.history({ container: "oc_1", limit: 5 });
    expect(record.actor).toMatchObject({ ref: "ou_bot", stableId: "feishu:ou_bot", isBot: true });
  });

  it("keeps well-formed ou_ tags and downgrades @all and malformed ids", () => {
    expect(sanitizeAtTags('<at user_id="ou_abc123">张三</at> 好了')).toBe('<at user_id="ou_abc123">张三</at> 好了');
    expect(sanitizeAtTags('<at user_id="ou_abc123">张三</at> <at user_id="all"></at>')).toBe('<at user_id="ou_abc123">张三</at> @all');
    expect(sanitizeAtTags('<at user_id="all"></at> 注意')).toBe("@all 注意");
    expect(sanitizeAtTags('<at user_id="bad id">李四</at>')).toBe("@李四");
  });

  it("stops paging a thread once a page is older than the window", async () => {
    const http = new FakeHttp();
    let pages = 0;
    http.handler = () => {
      pages += 1;
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            items: [{ message_id: `old${pages}`, create_time: "1000", msg_type: "text", content: { text: "old" }, chat_id: "oc_1" }],
            has_more: true,
            page_token: "next",
          },
        },
      };
    };
    const dir = await mkdtemp(join(tmpdir(), "larkling-feishu-"));
    const bot = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: true, stateDir: dir, ratePerSecond: 1000, clock: new ManualClock(0) });
    const records = await bot.history({ container: "omt_old", start: "2026-03-01T00:00:00.000Z", limit: 20 });
    expect(pages).toBe(1);
    expect(records).toHaveLength(0);
    expect(http.calls[0].query?.start_time).toBeUndefined();
  });
});

function receive(openId: string, messageId: string, senderType = "user", chatType = "group") {
  return {
    header: { event_id: messageId, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_type: senderType, sender_id: { open_id: openId } },
      message: {
        message_id: messageId,
        chat_id: chatType === "p2p" ? "oc_dm" : "oc_1",
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1710000000000",
      },
    },
  };
}

describe("feishu directory", () => {
  it("turns im.chat.updated_v1 into a chat_updated event and pages members", async () => {
    const http = new FakeHttp();
    http.handler = (input) =>
      input.path.endsWith("/members")
        ? input.query?.page_token
          ? { status: 200, json: { code: 0, data: { items: [{ member_id: "ou_2", name: "李四" }], has_more: false } } }
          : { status: 200, json: { code: 0, data: { items: [{ member_id: "ou_1", name: "张三" }], has_more: true, page_token: "p2" } } }
        : { status: 200, json: { code: 0, data: { name: "测试群" } } };
    const channel = new FeishuChannel({ http, botOpenId: "ou_bot", readGroupMessages: true, stateDir: await mkdtemp(join(tmpdir(), "larkling-fs-")) });
    expect(await channel.chatMembers("oc_1")).toEqual([
      { openId: "ou_1", name: "张三" },
      { openId: "ou_2", name: "李四" },
    ]);
    expect(await channel.chatInfo("oc_1")).toEqual({ name: "测试群" });
    const events = await collect(channel, () =>
      channel.ingest({ header: { event_type: "im.chat.updated_v1" }, event: { chat_id: "oc_1", after_change: { name: "新群名" }, before_change: { name: "旧" } } }),
    );
    expect(events).toEqual([{ type: "chat_updated", chatId: "oc_1", name: "新群名" }]);
  });
});
