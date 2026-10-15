import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, AttachmentRef, ChannelAdapter, ChannelEvent, HealthItem, ImRecord, OutboundAction, Scope } from "../../protocol/types.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { RateLimiter } from "../../core/ratelimit.js";
import { systemClock, type Clock } from "../../core/clock.js";
import { approvalCard, feishuUuid } from "./card.js";
import { millisToIso, normalizeFeishuMessage, type FeishuMention, type FeishuRawMessage } from "./content.js";
import { ffmpegToPcm, transcribeAudio, withTempPcm } from "./audio.js";
import type { FeishuHttp, FeishuResponse } from "./http.js";

const MAX_DOWNLOAD = 100 * 1024 * 1024;

export interface FeishuChannelOptions {
  http: FeishuHttp;
  botOpenId: string;
  /** App name from bot/v3/info, used when this bot is the sender. */
  botName?: string;
  readGroupMessages: boolean;
  stateDir: string;
  timeZone?: string;
  ratePerSecond?: number;
  speechPerSecond?: number;
  clock?: Clock;
  ffmpeg?: (input: string, output: string) => Promise<void>;
  log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

/**
 * Feishu channel. Message edits are ignored. Child messages of a merge-forward
 * are read from the get-message `items` field (or `content.messages`).
 */
export class FeishuChannel implements ChannelAdapter {
  readonly channel = "feishu";
  readonly capabilities: { readGroupMessages: boolean };
  private readonly queue = new AsyncQueue<ChannelEvent>();
  private readonly seenMessages = new Set<string>();
  private readonly sentIds = new Set<string>();
  private readonly scopes = new Map<string, Scope>();
  private readonly limiter: RateLimiter;
  private readonly speech: RateLimiter;
  private readonly clock: Clock;
  private readonly names = new Map<string, string>();
  private readonly nameMisses = new Set<string>();

  constructor(private readonly options: FeishuChannelOptions) {
    this.capabilities = { readGroupMessages: options.readGroupMessages };
    this.clock = options.clock ?? systemClock;
    this.limiter = new RateLimiter(options.ratePerSecond ?? 20, this.clock);
    this.speech = new RateLimiter(options.speechPerSecond ?? 20, this.clock);
  }

  events(): AsyncIterable<ChannelEvent> {
    return this.queue;
  }

  /** Test and websocket entry. Edit events are dropped. */
  async ingest(payload: unknown): Promise<void> {
    for (const event of await this.toEvents(payload)) this.queue.push(event);
  }

  close(): void {
    this.queue.close();
  }

  async send(action: OutboundAction): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    await this.limiter.take();
    const uuid = feishuUuid(action.idempotencyKey);
    if (action.type === "approval_card") {
      const response = await this.options.http.request({
        method: "POST",
        path: "/open-apis/im/v1/messages",
        query: { receive_id_type: "open_id" },
        json: {
          receive_id: action.owner.ref,
          msg_type: "interactive",
          content: JSON.stringify(approvalCard(action.approvalId, action.summary)),
          uuid,
        },
      });
      return this.sent(response);
    }
    const body = feishuMessageBody(action.text);
    if (action.replyTo) {
      const response = await this.options.http.request({
        method: "POST",
        path: `/open-apis/im/v1/messages/${action.replyTo}/reply`,
        json: { ...body, uuid, reply_in_thread: action.scope.kind === "topic" },
      });
      return this.sent(response);
    }
    const openId = action.scope.kind === "dm" && action.scope.id.startsWith("ou_");
    const response = await this.options.http.request({
      method: "POST",
      path: "/open-apis/im/v1/messages",
      query: { receive_id_type: openId ? "open_id" : "chat_id" },
      json: { receive_id: action.scope.id, ...body, uuid },
    });
    return this.sent(response);
  }

  async profile(): Promise<undefined> {
    return undefined;
  }

  async history(q: { container: string; start?: string; end?: string; limit: number; withRoot?: boolean }): Promise<ImRecord[]> {
    const thread = q.container.startsWith("omt_");
    const collected: FeishuRawMessage[] = [];
    if (thread) {
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        await this.limiter.take();
        const response = await this.options.http.request({
          method: "GET",
          path: "/open-apis/im/v1/messages",
          query: {
            container_id_type: "thread",
            container_id: q.container,
            page_size: "50",
            page_token: pageToken,
            sort_type: "ByCreateTimeDesc",
          },
        });
        const data = response.json?.data ?? {};
        const items = (data.items as FeishuRawMessage[] | undefined) ?? [];
        collected.push(...items);
        const oldest = items[items.length - 1];
        if (q.start && oldest && !inTime(oldest.create_time, q.start, undefined)) break;
        if (!data.has_more || typeof data.page_token !== "string") break;
        pageToken = data.page_token;
      }
    } else {
      await this.limiter.take();
      const response = await this.options.http.request({
        method: "GET",
        path: "/open-apis/im/v1/messages",
        query: {
          container_id_type: "chat",
          container_id: q.container,
          page_size: String(Math.min(Math.max(q.limit, 1), 50)),
          start_time: q.start ? toUnix(q.start) : undefined,
          end_time: q.end ? toUnix(q.end) : undefined,
          sort_type: "ByCreateTimeDesc",
        },
      });
      collected.push(...(((response.json?.data?.items as FeishuRawMessage[] | undefined) ?? [])));
    }
    let raw = collected.filter((item) => inTime(item.create_time, q.start, q.end));
    if (q.withRoot) {
      const rootId = raw.find((item) => item.root_id)?.root_id;
      if (rootId && !raw.some((item) => item.message_id === rootId)) {
        const root = await this.fetchMessage(rootId);
        if (root && inTime(root.create_time, q.start, q.end)) raw = [root, ...raw];
      }
    }
    const inWindow = new Set(raw.map((item) => item.message_id).filter((id): id is string => Boolean(id)));
    const records: ImRecord[] = [];
    for (const item of raw) {
      const normalized = await this.normalize(item, inWindow);
      const name = await this.displayNameFor(normalized.record.actor.ref, {
        mentionName: normalized.senderName,
        chatId: String(item.chat_id ?? ""),
      });
      if (name) normalized.record.actor.name = name;
      records.push(normalized.record);
    }
    records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.messageId.localeCompare(b.messageId));
    return records.slice(-q.limit);
  }

  async download(ref: AttachmentRef): Promise<string> {
    if (ref.kind === "image" && ref.key.startsWith("img") === false && ref.key === "") {
      throw new Error("表情包资源不能下载");
    }
    await this.limiter.take();
    const type = ref.kind === "image" ? "image" : "file";
    const response = await this.options.http.request({
      method: "GET",
      path: `/open-apis/im/v1/messages/${ref.messageId}/resources/${ref.key}`,
      query: { type },
    });
    if (response.json?.code) {
      if (response.json.code === 234043) throw new Error("合并转发或卡片里的资源不能下载（234043）");
      if (response.json.code === 234038) throw new Error("消息保密或群开启了防泄密，不能下载（234038）");
      throw new Error(response.json.msg || `download failed (${response.json.code})`);
    }
    const body = response.body ?? Buffer.alloc(0);
    if (body.length > MAX_DOWNLOAD) throw new Error("文件超过 100MB");
    const directory = join(this.options.stateDir, "files");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${ref.messageId}-${ref.key}`.replace(/[^a-zA-Z0-9._-]+/g, "_"));
    await writeFile(path, body);
    return path;
  }

  async health(): Promise<HealthItem[]> {
    try {
      await this.limiter.take();
      const response = await this.options.http.request({ method: "GET", path: "/open-apis/bot/v3/info" });
      const ok = response.json?.code === 0 || response.status === 200;
      return [{ name: "feishu", ok, detail: ok ? this.options.botOpenId : response.json?.msg }];
    } catch (error) {
      return [{ name: "feishu", ok: false, detail: error instanceof Error ? error.message : String(error) }];
    }
  }

  private sent(response: FeishuResponse): { ok: boolean; messageId?: string; error?: string } {
    const rawId = response.json?.data?.message_id;
    const messageId = typeof rawId === "string" ? rawId : undefined;
    if (response.json?.code && response.json.code !== 0) return { ok: false, error: response.json.msg || String(response.json.code) };
    if (messageId) this.sentIds.add(messageId);
    return { ok: true, messageId };
  }

  private async toEvents(payload: unknown): Promise<ChannelEvent[]> {
    const body = asRecord(payload);
    if (!body) return [];
    const header = asRecord(body.header);
    const eventType = String(header?.event_type ?? body.event_type ?? "");
    if (eventType === "im.message.updated_v1" || eventType.includes("message.updated")) return [];
    const event = asRecord(body.event) ?? body;
    if (eventType === "im.message.recalled_v1") {
      const messageId = String(event.message_id ?? "");
      const chatId = String(event.chat_id ?? "");
      const scope = this.scopes.get(messageId) ?? { channel: "feishu" as const, kind: "group" as const, id: chatId };
      return [{ type: "recalled", eventId: String(header?.event_id ?? messageId), messageId, scope }];
    }
    if (eventType === "im.message.reaction.created_v1" || eventType === "im.message.reaction.deleted_v1") {
      const messageId = String(event.message_id ?? "");
      if (!this.sentIds.has(messageId)) return [];
      const operator = asRecord(event.user_id) ?? asRecord(event.operator_id) ?? {};
      const actor = actorFromIds(operator, "user");
      const emoji = String(asRecord(event.reaction_type)?.emoji_type ?? event.emoji_type ?? "");
      return [
        {
          type: "reaction",
          eventId: String(header?.event_id ?? `${messageId}:${emoji}`),
          messageId,
          scope: { channel: "feishu", kind: "group", id: String(event.chat_id ?? "") },
          actor,
          emoji,
          action: eventType.endsWith("deleted_v1") ? "removed" : "added",
        },
      ];
    }
    if (eventType === "card.action.trigger" || event.action) {
      const action = asRecord(event.action);
      const value = asRecord(action?.value);
      const operator = asRecord(event.operator) ?? {};
      const decision = value?.decision === "deny" ? "deny" : value?.decision === "approve" ? "approve" : undefined;
      if (!value?.approvalId || !decision) return [];
      return [
        {
          type: "approval_decision",
          approvalId: String(value.approvalId),
          decision,
          actor: actorFromIds(operator, "user"),
        },
      ];
    }
    const message = (asRecord(event.message) as FeishuRawMessage | undefined) ?? undefined;
    if (!message) return [];
    if (message.updated) return [];
    const messageId = String(message.message_id ?? "");
    if (!messageId || this.seenMessages.has(messageId)) return [];
    this.seenMessages.add(messageId);
    const sender = asRecord(event.sender);
    const senderId = asRecord(sender?.sender_id) ?? {};
    const actor = actorFromIds(senderId, String(sender?.sender_type ?? "user"), "");
    const scope = scopeFrom(message);
    const normalized = await this.normalize(message, new Set());
    const resolvedName = await this.displayNameFor(actor.ref, {
      mentionName: normalized.senderName,
      chatId: String(message.chat_id ?? scope.parentId ?? scope.id),
    });
    if (resolvedName) actor.name = resolvedName;
    const names = [...normalized.names];
    if (actor.name && actor.ref && !names.some((entry) => entry.stableId === actor.stableId)) {
      names.unshift({ stableId: actor.stableId, ref: actor.ref, name: actor.name, aliases: actor.aliases });
    }
    const occurredAt = millisToIso(String(message.create_time ?? Date.now()));
    const events: ChannelEvent[] = [];
    if (names.length) events.push({ type: "names", entries: names });
    this.scopes.set(messageId, scope);
    events.push({
      type: "message",
      eventId: String(header?.event_id ?? messageId),
      messageId,
      scope,
      actor,
      text: normalized.record.text,
      attachments: normalized.record.attachments,
      mentionsSelf: normalized.mentionsSelf,
      mentionsOthers: normalized.mentionsOthers,
      disposition: normalized.disposition,
      replyTo: message.parent_id || undefined,
      occurredAt,
    });
    return events;
  }

  private async normalize(message: FeishuRawMessage, inWindow: Set<string>) {
    const messageId = String(message.message_id ?? "");
    const mentions = (message.mentions ?? []) as FeishuMention[];
    const msgType = message.msg_type || message.message_type || "";
    let audio: { durationMs: number; transcript?: string; status: "ok" | "too_long" | "failed" } | undefined;
    if (msgType === "audio") {
      audio = await this.prepareAudio(message);
    }
    const result = await normalizeFeishuMessage(message, {
      messageId,
      botOpenId: this.options.botOpenId,
      mentions,
      timeZone: this.options.timeZone ?? "Asia/Shanghai",
      now: new Date(this.clock.now()),
      inWindow,
      audio,
      loadMessage: (id) => this.fetchMessage(id),
      chatName: async (chatId) => {
        await this.limiter.take();
        const response = await this.options.http.request({ method: "GET", path: `/open-apis/im/v1/chats/${chatId}` });
        const name = response.json?.data?.name;
        return typeof name === "string" ? name : undefined;
      },
      userName: async (openId) => {
        const mention = mentions.find((item) => {
          const id = item.id;
          return (typeof id === "string" ? id : id?.open_id) === openId;
        });
        return this.displayNameFor(openId, { mentionName: mention?.name, chatId: String(message.chat_id ?? "") });
      },
    });
    const senderName = mentions.find((item) => mentionOpen(item) === (message.sender?.sender_id?.open_id || message.sender?.id))?.name ?? "";
    const record: ImRecord = {
      messageId,
      scope: scopeFrom(message),
      actor: actorFromMessage(message),
      text: result.text,
      attachments: result.attachments,
      mentionsSelf: result.mentionsSelf,
      occurredAt: millisToIso(String(message.create_time ?? Date.now())),
      replyTo: message.parent_id || undefined,
    };
    return { record, mentionsSelf: result.mentionsSelf, mentionsOthers: result.mentionsOthers, disposition: result.disposition, names: result.names, senderName };
  }

  private async prepareAudio(message: FeishuRawMessage): Promise<{ durationMs: number; transcript?: string; status: "ok" | "too_long" | "failed" }> {
    const content = parseContent(message);
    const durationMs = Number(content.duration ?? 0) || 0;
    const key = String(content.file_key ?? "");
    if (durationMs > 5 * 60_000) return { durationMs, status: "too_long" };
    if (!key || !message.message_id) return { durationMs, status: "failed" };
    try {
      const path = await this.download({ kind: "audio", messageId: message.message_id, key });
      const { readFile } = await import("node:fs/promises");
      const encoded = await readFile(path);
      const pcm = await withTempPcm(encoded, this.options.ffmpeg ?? ffmpegToPcm);
      const result = await transcribeAudio({
        http: this.options.http,
        pcm,
        limiter: this.speech,
        durationMs,
        log: (fields) => this.options.log?.warn("speech.recognize_failed", fields),
      });
      return { durationMs, ...result };
    } catch (error) {
      this.options.log?.warn("speech.failed", { error: error instanceof Error ? error.message : String(error) });
      return { durationMs, status: "failed" };
    }
  }

  /**
   * Display name for an open_id. Mention text wins, then the contact user
   * API, then chat members. A miss is logged once and does not fail the message.
   */
  private async displayNameFor(openId: string, hints: { mentionName?: string; chatId?: string }): Promise<string> {
    if (!openId || openId === "all") return "";
    const cached = this.names.get(openId);
    if (cached) return cached;
    if (this.options.botOpenId && openId === this.options.botOpenId && this.options.botName) {
      this.names.set(openId, this.options.botName);
      return this.options.botName;
    }
    if (hints.mentionName) {
      this.names.set(openId, hints.mentionName);
      return hints.mentionName;
    }
    if (this.nameMisses.has(openId)) return "";
    const contact = await this.lookupContact(openId);
    if (contact.name) {
      this.names.set(openId, contact.name);
      return contact.name;
    }
    const member = hints.chatId ? await this.lookupMember(hints.chatId, openId) : undefined;
    if (member) {
      this.names.set(openId, member);
      return member;
    }
    this.nameMisses.add(openId);
    this.options.log?.warn("name.lookup_failed", { openId, detail: contact.error || "no display name" });
    return "";
  }

  private async lookupContact(openId: string): Promise<{ name?: string; error?: string }> {
    try {
      await this.limiter.take();
      const response = await this.options.http.request({
        method: "GET",
        path: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
        query: { user_id_type: "open_id" },
      });
      const code = response.json?.code;
      if (code && code !== 0) return { error: response.json?.msg || String(code) };
      const user = asRecord(response.json?.data?.user);
      const name = typeof user?.name === "string" && user.name ? user.name : typeof user?.en_name === "string" ? user.en_name : undefined;
      return { name };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async lookupMember(chatId: string, openId: string): Promise<string | undefined> {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      try {
        await this.limiter.take();
        const response = await this.options.http.request({
          method: "GET",
          path: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
          query: { member_id_type: "open_id", page_size: "100", page_token: pageToken },
        });
        const code = response.json?.code;
        if (code && code !== 0) return undefined;
        const data = response.json?.data;
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
          const record = asRecord(item);
          if (!record || String(record.member_id ?? "") !== openId) continue;
          if (typeof record.name === "string" && record.name) return record.name;
        }
        if (data?.has_more !== true || typeof data.page_token !== "string") return undefined;
        pageToken = data.page_token;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async fetchMessage(messageId: string): Promise<FeishuRawMessage | undefined> {
    await this.limiter.take();
    const response = await this.options.http.request({ method: "GET", path: `/open-apis/im/v1/messages/${messageId}` });
    const data = response.json?.data;
    if (!data) return undefined;
    const items = data.items as FeishuRawMessage[] | undefined;
    return items?.[0] ?? (data as unknown as FeishuRawMessage);
  }
}

function scopeFrom(message: FeishuRawMessage): Scope {
  const chatId = String(message.chat_id ?? "");
  if (message.chat_type === "p2p") return { channel: "feishu", kind: "dm", id: chatId };
  if (message.thread_id) return { channel: "feishu", kind: "topic", id: String(message.thread_id), parentId: chatId };
  return { channel: "feishu", kind: "group", id: chatId };
}

function actorFromMessage(message: FeishuRawMessage): Actor {
  const sender = message.sender;
  const ids = sender?.sender_id ?? {};
  const openId = ids.open_id || (sender?.id_type === "open_id" ? sender.id : "") || "";
  const unionId = ids.union_id || (sender?.id_type === "union_id" ? sender.id : "") || "";
  return actorFromIds({ open_id: openId, union_id: unionId }, sender?.sender_type ?? "user");
}

function actorFromIds(ids: Record<string, unknown>, senderType: string, name = ""): Actor {
  const openId = String(ids.open_id ?? ids.openId ?? "");
  const unionId = String(ids.union_id ?? ids.unionId ?? "");
  const stableId = openId ? `feishu:${openId}` : unionId ? `feishu-union:${unionId}` : "feishu:unknown";
  return {
    channel: "feishu",
    ref: openId,
    stableId,
    name,
    isBot: senderType === "app" || senderType === "bot",
    aliases: openId && unionId ? [`feishu-union:${unionId}`] : undefined,
  };
}

function mentionOpen(mention: FeishuMention): string | undefined {
  if (typeof mention.id === "string") return mention.id;
  return mention.id?.open_id;
}

function parseContent(message: FeishuRawMessage): Record<string, unknown> {
  const source = message.body?.content ?? message.content;
  if (typeof source === "string") {
    try {
      return JSON.parse(source) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (source as Record<string, unknown>) ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toUnix(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return String(Math.floor(ms / 1000));
}

function inTime(createTime: string | undefined, start?: string, end?: string): boolean {
  if (!createTime || (!start && !end)) return true;
  const iso = millisToIso(createTime);
  if (start && iso < start) return false;
  if (end && iso > end) return false;
  return true;
}

export interface BotProfile {
  openId?: string;
  appName?: string;
}

export async function loadBotProfile(http: FeishuHttp): Promise<BotProfile> {
  const response = await http.request({ method: "GET", path: "/open-apis/bot/v3/info" });
  const bot = response.json?.bot;
  const data = response.json?.data;
  return {
    openId: textOrUndefined(bot?.open_id) ?? textOrUndefined(data?.open_id),
    appName: textOrUndefined(bot?.app_name) ?? textOrUndefined(data?.app_name),
  };
}

export async function loadBotOpenId(http: FeishuHttp): Promise<string | undefined> {
  return (await loadBotProfile(http)).openId;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Short plain replies stay text. Markdown tables use a JSON 2.0 card, which
 * renders tables. Other markdown uses a post `md` element.
 */
export function feishuMessageBody(text: string): { msg_type: "text" | "post" | "interactive"; content: string } {
  if (hasMarkdownTable(text)) {
    return {
      msg_type: "interactive",
      content: JSON.stringify({
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [{ tag: "markdown", content: text }] },
      }),
    };
  }
  if (isPlainShort(text)) return { msg_type: "text", content: JSON.stringify({ text }) };
  return { msg_type: "post", content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } }) };
}

function hasMarkdownTable(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length - 1; index++) {
    if (lines[index].includes("|") && separator.test(lines[index + 1])) return true;
  }
  return false;
}

function isPlainShort(text: string): boolean {
  if (text.includes("\n") || text.length > 120) return false;
  return !/[*_`#[\]|]/.test(text);
}
