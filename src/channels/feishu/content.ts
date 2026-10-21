import type { AttachmentRef } from "../../protocol/types.js";
import { fallbackName, formatMessageTime, renderEnvelope, stripControlChars, truncateBody } from "../envelope.js";

export { fallbackName, formatMessageTime, renderEnvelope, truncateBody };

/** Event and history messages, loose enough for both payload shapes. */
export interface FeishuRawMessage {
  message_id?: string;
  msg_type?: string;
  message_type?: string;
  create_time?: string;
  update_time?: string;
  chat_id?: string;
  chat_type?: string;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
  chat_mode?: string;
  group_message_type?: string;
  content?: unknown;
  body?: { content?: unknown };
  mentions?: FeishuMention[];
  items?: FeishuRawMessage[];
  sender?: FeishuSender;
  deleted?: boolean;
  updated?: boolean;
}

export interface FeishuMention {
  key?: string;
  name?: string;
  nickname?: string;
  open_id?: string;
  openId?: string;
  id?: string | { open_id?: string; openId?: string; user_id?: string };
  id_type?: string;
  mentioned_type?: string;
}

export interface FeishuSender {
  id?: string;
  id_type?: string;
  sender_type?: string;
  sender_id?: { open_id?: string; user_id?: string };
}

export interface NormalizeContext {
  messageId: string;
  botOpenId?: string;
  mentions?: FeishuMention[];
  timeZone?: string;
  now?: Date;
  loadMessage?: (messageId: string) => Promise<FeishuRawMessage | undefined>;
  chatName?: (chatId: string) => Promise<string | undefined>;
  userName?: (openId: string) => Promise<string | undefined>;
  audio?: { durationMs: number; transcript?: string; status: "ok" | "too_long" | "failed" };
  depth?: number;
  /** Remaining child messages that may still be expanded. */
  budget?: { remaining: number };
  /** Child messages of a merge cannot be downloaded, so they get no att markers. */
  attachmentMode?: "full" | "label";
  /** Parent ids already in the current window; their quotes are not expanded. */
  inWindow?: Set<string>;
}

export interface NormalizeResult {
  text: string;
  attachments: AttachmentRef[];
  mentionsSelf: boolean;
  mentionsOthers: boolean;
  disposition: "normal" | "store_only" | "unsupported";
  names: { stableId: string; ref: string; name: string; isBot?: boolean }[];
  /** Real @ mentions, in order, deduped. ref "all" is @all. */
  mentions: { ref: string; name: string; isBot?: boolean }[];
}

const STORE_ONLY = new Set(["system", "hongbao", "sticker"]);
const MERGE_LIMIT = 50;
const MERGE_DEPTH = 2;
const QUOTE_LIMIT = 500;

export async function normalizeFeishuMessage(raw: FeishuRawMessage, ctx: NormalizeContext): Promise<NormalizeResult> {
  const msgType = raw.msg_type || raw.message_type || "unknown";
  const content = parseContent(raw);
  const mentions = ctx.mentions ?? raw.mentions ?? [];
  const names = namesFromMentions(mentions);
  const mode = ctx.attachmentMode ?? "full";
  const attachments: AttachmentRef[] = [];
  let mentionsSelf = mentionsSelfFrom(mentions, ctx.botOpenId);
  let mentionsOthers = mentionsOthersFrom(mentions, ctx.botOpenId);
  let disposition: NormalizeResult["disposition"] = STORE_ONLY.has(msgType) ? "store_only" : "normal";
  let text: string;

  switch (msgType) {
    case "text":
      text = renderTextMentions(stringField(content, "text"), mentions, ctx.botOpenId);
      break;
    case "post":
      text = renderPost(content, ctx, attachments, mode);
      if (postMentionsSelf(content, ctx.botOpenId)) mentionsSelf = true;
      if (postMentionsOthers(content, ctx.botOpenId)) mentionsOthers = true;
      break;
    case "image": {
      const key = stringField(content, "image_key");
      text = pushAttachment(attachments, mode, ctx.messageId, "image", key, undefined, "[图片");
      break;
    }
    case "file": {
      const key = stringField(content, "file_key");
      const name = stringField(content, "file_name") || "file";
      text = pushAttachment(attachments, mode, ctx.messageId, "file", key, name, `[文件：${name}`);
      break;
    }
    case "audio":
      text = renderAudio(content, ctx, attachments, mode);
      break;
    case "media":
      text = renderVideo(content, ctx, attachments, mode);
      break;
    case "sticker":
      text = "[表情包]";
      disposition = "store_only";
      break;
    case "interactive":
    case "card":
      text = renderCard(content);
      break;
    case "merge_forward":
      text = await renderMerge(raw, content, ctx);
      break;
    case "share_chat":
      text = await renderShareChat(content, ctx);
      break;
    case "share_user":
      text = await renderShareUser(content, ctx);
      break;
    case "system":
      text = `[系统] ${renderSystem(content)}`;
      disposition = "store_only";
      break;
    case "location":
      text = renderLocation(content);
      break;
    case "todo":
      text = await renderTodo(content, ctx);
      break;
    case "vote":
      text = renderVote(content);
      break;
    case "share_calendar_event":
    case "calendar":
    case "general_calendar":
      text = renderCalendar(content, ctx);
      break;
    case "video_chat":
      text = renderVideoChat(content, ctx);
      break;
    case "folder":
      text = `[文件夹：${stringField(content, "file_name") || "文件夹"}]`;
      break;
    case "hongbao":
      text = "[红包]";
      disposition = "store_only";
      break;
    default:
      text = `[不支持的消息类型：${msgType}]`;
      disposition = "unsupported";
      break;
  }

  text = await prependQuote(text, raw, ctx);
  if (raw.deleted) text = "[已撤回]";
  return {
    text: truncateBody(text),
    attachments,
    mentionsSelf,
    mentionsOthers,
    disposition,
    names,
    mentions: collectMentions(mentions, msgType === "post" ? content : undefined),
  };
}

export function messageContent(raw: FeishuRawMessage): unknown {
  return parseContent(raw);
}

function parseContent(raw: FeishuRawMessage): Record<string, unknown> {
  const source = raw.body?.content ?? raw.content;
  if (source && typeof source === "object") return source as Record<string, unknown>;
  if (typeof source === "string" && source.trim()) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return { text: source };
    }
  }
  return {};
}

function stringField(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function namesFromMentions(mentions: FeishuMention[]): NormalizeResult["names"] {
  const names: NormalizeResult["names"] = [];
  for (const mention of mentions) {
    const person = mentionPerson(mention);
    if (!person) continue;
    names.push({ stableId: `feishu:${person.openId}`, ref: person.openId, name: person.name, isBot: person.isBot });
  }
  return names;
}

/** open_id from `openId`, `open_id`, or `id`. A user_id is not an open_id. */
export function mentionOpenId(mention: FeishuMention): string | undefined {
  const direct = textField(mention.openId) || textField(mention.open_id);
  if (direct) return direct;
  if (typeof mention.id === "string") return mention.id_type === "open_id" || !mention.id_type ? mention.id : undefined;
  return textField(mention.id?.open_id) || textField(mention.id?.openId);
}

/** Display name from the payload. Nickname wins over name. Empty when neither is present. */
export function mentionDisplayName(mention: FeishuMention): string {
  const nickname = textField(mention.nickname) ?? "";
  const name = textField(mention.name) ?? "";
  return nickname || name;
}

/** A mentioned account. Skips @all and any id that is not `ou_…`. Does not invent a name. */
export function mentionPerson(mention: FeishuMention): { openId: string; name: string; isBot: boolean } | undefined {
  const openId = mentionOpenId(mention);
  const name = mentionDisplayName(mention);
  if (!openId || openId === "all" || !/^ou_[A-Za-z0-9]+$/.test(openId) || !name) return undefined;
  return { openId, name, isBot: mention.mentioned_type === "bot" };
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mentionsSelfFrom(mentions: FeishuMention[], botOpenId?: string): boolean {
  if (!botOpenId) return false;
  return mentions.some((mention) => mentionOpenId(mention) === botOpenId);
}

function mentionsOthersFrom(mentions: FeishuMention[], botOpenId?: string): boolean {
  return mentions.some((mention) => {
    if (mention.key === "@_all") return true;
    const openId = mentionOpenId(mention);
    return Boolean(openId && openId !== botOpenId);
  });
}

export function renderTextMentions(text: string, mentions: FeishuMention[], _botOpenId?: string): string {
  let rendered = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    rendered = rendered.split(mention.key).join(mentionLabel(mention));
  }
  rendered = rendered.replaceAll("@_all", atTag("all", ""));
  return rendered;
}

/** Feishu's own @ syntax, the same form the model writes to @ someone. */
export function atTag(userId: string, name: string): string {
  return userId === "all" ? `<at user_id="all"></at>` : `<at user_id="${userId}">${name}</at>`;
}

function mentionLabel(mention: FeishuMention): string {
  const openId = mentionOpenId(mention);
  const name = mentionDisplayName(mention);
  if (mention.key === "@_all" || openId === "all") return atTag("all", "");
  return atTag(openId || "unknown", name || fallbackName(openId || mention.key || "user"));
}

function collectMentions(mentions: FeishuMention[], post?: Record<string, unknown>): { ref: string; name: string; isBot?: boolean }[] {
  const out: { ref: string; name: string; isBot?: boolean }[] = [];
  const add = (ref: string, name: string, isBot = false) => {
    if (!ref || !name || out.some((item) => item.ref === ref)) return;
    out.push(isBot ? { ref, name, isBot: true } : { ref, name });
  };
  for (const mention of mentions) {
    const person = mentionPerson(mention);
    const openId = mentionOpenId(mention);
    if (mention.key === "@_all" || openId === "all") add("all", mentionDisplayName(mention) || "所有人");
    else if (person) add(person.openId, person.name, person.isBot);
  }
  if (post) {
    for (const row of pickRich(post).rows) {
      for (const node of row) {
        if (node.tag === "at") {
          const userId = String(node.user_id ?? "");
          const known = mentions.find((item) => mentionOpenId(item) === userId);
          const person = known ? mentionPerson(known) : undefined;
          const nodeName = typeof node.user_name === "string" ? node.user_name.trim() : "";
          const name = person?.name || nodeName;
          if (userId === "all") add("all", name || "所有人");
          else if (name && /^ou_[A-Za-z0-9]+$/.test(userId)) add(userId, name, person?.isBot === true);
        } else if (node.tag === "md" || node.tag === "text") {
          for (const match of String(node.text ?? "").matchAll(/<at\s+user_id="([^"]+)"[^>]*>([^<]*)<\/at>/g)) {
            const known = mentions.find((item) => mentionOpenId(item) === match[1]);
            const person = known ? mentionPerson(known) : undefined;
            const name = person?.name || match[2].trim();
            if (match[1] === "all") add("all", name || "所有人");
            else if (name && /^ou_[A-Za-z0-9]+$/.test(match[1])) add(match[1], name, person?.isBot === true);
          }
        }
      }
    }
  }
  return out;
}

function renderPost(
  content: Record<string, unknown>,
  ctx: NormalizeContext,
  attachments: AttachmentRef[],
  mode: "full" | "label",
): string {
  const rich = pickRich(content);
  const lines: string[] = [];
  if (rich.title) lines.push(`**${rich.title}**`);
  for (const row of rich.rows) {
    const parts: string[] = [];
    for (const node of row) parts.push(renderPostNode(node, ctx, attachments, mode));
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

function pickRich(content: Record<string, unknown>): { title: string; rows: Record<string, unknown>[][] } {
  const v2 = asRecord(content.content_v2) ?? content.content_v2;
  const source = v2 && typeof v2 === "object" ? contentWithV2(content) : content;
  const localized = firstLocale(source) ?? source;
  const title = typeof localized.title === "string" ? localized.title : typeof source.title === "string" ? source.title : "";
  const rows = Array.isArray(localized.content) ? (localized.content as unknown[]) : Array.isArray(source.content) ? (source.content as unknown[]) : [];
  return {
    title,
    rows: rows.map((row) => (Array.isArray(row) ? (row.filter((node) => node && typeof node === "object") as Record<string, unknown>[]) : [])),
  };
}

function contentWithV2(content: Record<string, unknown>): Record<string, unknown> {
  const v2 = content.content_v2;
  if (Array.isArray(v2)) return { title: content.title, content: v2 };
  if (v2 && typeof v2 === "object") return v2 as Record<string, unknown>;
  return content;
}

function firstLocale(content: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["zh_cn", "zh_tw", "en_us", "ja_jp"]) {
    const value = content[key];
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  const nested = Object.values(content).find((value) => value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).content));
  return nested as Record<string, unknown> | undefined;
}

function renderPostNode(
  node: Record<string, unknown>,
  ctx: NormalizeContext,
  attachments: AttachmentRef[],
  mode: "full" | "label",
): string {
  const tag = String(node.tag ?? "text");
  switch (tag) {
    case "text":
    case "md":
      return renderMd(String(node.text ?? ""), ctx);
    case "a": {
      const label = String(node.text ?? node.href ?? "");
      const href = String(node.href ?? "");
      return href ? `[${label}](${href})` : label;
    }
    case "at":
      return renderAtTag(node, ctx);
    case "code_block": {
      const lang = typeof node.language === "string" ? node.language : "";
      return `\n\`\`\`${lang}\n${String(node.text ?? "")}\n\`\`\`\n`;
    }
    case "hr":
      return "\n---\n";
    case "emotion":
      return `[${String(node.emoji_type ?? "EMOJI")}]`;
    case "img": {
      const key = String(node.image_key ?? "");
      return pushAttachment(attachments, mode, ctx.messageId, "image", key, undefined, "[图片");
    }
    case "media": {
      const key = String(node.file_key ?? "");
      const name = String(node.file_name ?? "video");
      return pushAttachment(attachments, mode, ctx.messageId, "video", key, name, `[视频：${name}`);
    }
    default:
      return typeof node.text === "string" ? node.text : "";
  }
}

function renderMd(text: string, ctx: NormalizeContext): string {
  return text.replace(/<at\s+user_id="([^"]+)"[^>]*>\s*<\/at>/g, (_all, userId: string) => {
    if (userId === "all") return atTag("all", "");
    const mention = (ctx.mentions ?? []).find((item) => mentionOpenId(item) === userId);
    return atTag(userId, mention?.name || fallbackName(userId));
  });
}

function renderAtTag(node: Record<string, unknown>, ctx: NormalizeContext): string {
  const userId = String(node.user_id ?? "");
  if (userId === "all" || node.user_name === "所有人") return atTag("all", "");
  const mention = (ctx.mentions ?? []).find((item) => mentionOpenId(item) === userId);
  const tagName = typeof node.user_name === "string" && node.user_name ? node.user_name : undefined;
  const name = tagName ?? mention?.name ?? fallbackName(userId || "user");
  return atTag(userId || "unknown", name);
}

function postMentionsSelf(content: Record<string, unknown>, botOpenId?: string): boolean {
  if (!botOpenId) return false;
  return JSON.stringify(content).includes(botOpenId);
}

function postMentionsOthers(content: Record<string, unknown>, botOpenId?: string): boolean {
  const rich = pickRich(content);
  return rich.rows.some((row) =>
    row.some((node) => {
      if (node.tag !== "at") return false;
      const userId = String(node.user_id ?? "");
      return userId === "all" || (userId !== "" && userId !== botOpenId);
    }),
  );
}

function pushAttachment(
  attachments: AttachmentRef[],
  mode: "full" | "label",
  messageId: string,
  kind: AttachmentRef["kind"],
  key: string,
  name: string | undefined,
  label: string,
): string {
  if (mode === "label" || !key) {
    if (kind === "image") return "[图片]";
    if (kind === "video") return `[视频：${name || "video"}]`;
    if (kind === "file") return `[文件：${name || "file"}]`;
    return `[${kind}]`;
  }
  attachments.push({ kind, messageId, key, name });
  return `${label} att:${attachments.length}]`;
}

function renderAudio(
  content: Record<string, unknown>,
  ctx: NormalizeContext,
  attachments: AttachmentRef[],
  mode: "full" | "label",
): string {
  const durationMs = ctx.audio?.durationMs ?? numberField(content, "duration");
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const key = stringField(content, "file_key");
  let att = "";
  if (mode === "full" && key) {
    attachments.push({ kind: "audio", messageId: ctx.messageId, key });
    att = ` att:${attachments.length}`;
  }
  if (durationMs > 5 * 60_000 || ctx.audio?.status === "too_long") return `[语音 ${seconds}秒] 过长未转写${att}`;
  if (ctx.audio?.status === "ok" && ctx.audio.transcript) return `[语音 ${seconds}秒] 转写：${ctx.audio.transcript}${att}`;
  return `[语音 ${seconds}秒] 转写失败${att}`;
}

function renderVideo(content: Record<string, unknown>, ctx: NormalizeContext, attachments: AttachmentRef[], mode: "full" | "label"): string {
  const name = stringField(content, "file_name") || "video";
  const seconds = Math.round(numberField(content, "duration") / 1000);
  const key = stringField(content, "file_key");
  const duration = seconds > 0 ? ` ${seconds}秒` : "";
  if (mode === "label" || !key) return `[视频：${name}${duration}]`;
  attachments.push({ kind: "video", messageId: ctx.messageId, key, name });
  return `[视频：${name}${duration} att:${attachments.length}]`;
}

function renderCard(content: Record<string, unknown>): string {
  const title = cardTitle(content);
  const lines: string[] = [`[卡片]${title ? ` ${title}` : ""}`.trim()];
  const bits: string[] = [];
  walk(content, (node) => {
    const tag = String(node.tag ?? "");
    if (tag === "button" || tag === "select_static" || tag === "overflow" || tag === "picker") {
      const label = plainText(node.text) || plainText(node.placeholder) || "";
      if (label) bits.push(`[按钮：${label}]`);
      return;
    }
    if (tag === "img" || node.img_key || node.image_key) {
      if (tag === "img") bits.push("[图片]");
      return;
    }
    if (tag === "note" || tag === "div" || tag === "markdown" || tag === "lark_md" || tag === "plain_text") {
      const text = plainText(node) || (typeof node.content === "string" ? node.content : "");
      if (text && tag !== "plain_text") bits.push(text);
    }
  });
  if (bits.length) lines.push(bits.join(" "));
  return lines.join("\n");
}

function cardTitle(content: Record<string, unknown>): string {
  if (typeof content.title === "string") return content.title;
  const header = asRecord(content.header);
  const title = header ? plainText(header.title) || (typeof header.title === "string" ? header.title : "") : "";
  return title;
}

function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const record = node as Record<string, unknown>;
  visit(record);
  for (const value of Object.values(record)) walk(value, visit);
}

function plainText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return "";
}

async function renderMerge(raw: FeishuRawMessage, content: Record<string, unknown>, ctx: NormalizeContext): Promise<string> {
  const depth = ctx.depth ?? 0;
  const children = collectChildren(raw, content);
  let loaded = children;
  if (loaded.length === 0 && ctx.loadMessage && raw.message_id && depth === 0) {
    const fetched = await ctx.loadMessage(raw.message_id);
    if (fetched) loaded = collectChildren(fetched, parseContent(fetched));
  }
  const budget = ctx.budget ?? { remaining: MERGE_LIMIT };
  const visible: string[] = [];
  let hidden = 0;
  for (const child of loaded) {
    if (depth + 1 > MERGE_DEPTH || budget.remaining <= 0) {
      hidden += 1;
      continue;
    }
    budget.remaining -= 1;
    const childId = child.message_id || `${ctx.messageId}:${visible.length + hidden}`;
    const normalized = await normalizeFeishuMessage(child, {
      ...ctx,
      messageId: childId,
      depth: depth + 1,
      budget,
      attachmentMode: "label",
      audio: undefined,
      loadMessage: depth + 1 >= MERGE_DEPTH ? undefined : ctx.loadMessage,
    });
    const sender = senderName(child, ctx);
    const when = child.create_time ? formatMessageTime(millisToIso(child.create_time), ctx.timeZone ?? "Asia/Shanghai", ctx.now) : "";
    const body = normalized.text.replaceAll("\n", " ");
    visible.push(`> ${sender}${when ? ` ${when}` : ""}：${body}`);
  }
  const header = `[合并转发 ${loaded.length || visible.length}条]`;
  const extra = hidden > 0 ? `\n…（另 ${hidden} 条未展开）` : "";
  return [header, ...visible].join("\n") + extra;
}

function collectChildren(raw: FeishuRawMessage, content: Record<string, unknown>): FeishuRawMessage[] {
  if (Array.isArray(raw.items) && raw.items.length) return raw.items;
  for (const key of ["messages", "items", "sub_messages"]) {
    const value = content[key];
    if (Array.isArray(value)) return value as FeishuRawMessage[];
  }
  return [];
}

async function prependQuote(text: string, raw: FeishuRawMessage, ctx: NormalizeContext): Promise<string> {
  const parentId = raw.parent_id || "";
  if (!parentId || (ctx.depth ?? 0) > 0) return text;
  if (ctx.inWindow?.has(parentId)) return text;
  if (!ctx.loadMessage) return text;
  const parent = await ctx.loadMessage(parentId);
  if (!parent) return text;
  const normalized = await normalizeFeishuMessage(
    { ...parent, parent_id: undefined, root_id: undefined },
    { ...ctx, messageId: parent.message_id || parentId, depth: 1, loadMessage: undefined, attachmentMode: "label" },
  );
  const name = senderName(parent, ctx);
  let quoted = normalized.text.replaceAll("\n", " ").trim();
  const chars = [...quoted];
  if (chars.length > QUOTE_LIMIT) quoted = `${chars.slice(0, QUOTE_LIMIT).join("")}…`;
  return `> 引用 ${name}：${quoted}\n${text}`;
}

function senderName(raw: FeishuRawMessage, ctx: NormalizeContext): string {
  const openId = raw.sender?.sender_id?.open_id || (raw.sender?.id_type === "open_id" ? raw.sender.id : undefined);
  if (ctx.botOpenId && openId === ctx.botOpenId) return "我";
  const mention = (raw.mentions ?? ctx.mentions ?? []).find((item) => mentionOpenId(item) === openId);
  if (mention?.name) return mention.name;
  return fallbackName(openId || raw.sender?.id || "user");
}

async function renderShareChat(content: Record<string, unknown>, ctx: NormalizeContext): Promise<string> {
  const chatId = stringField(content, "chat_id");
  const name = chatId && ctx.chatName ? await ctx.chatName(chatId) : undefined;
  return `[分享群聊：${name || chatId || "群聊"}]`;
}

async function renderShareUser(content: Record<string, unknown>, ctx: NormalizeContext): Promise<string> {
  const userId = stringField(content, "user_id") || stringField(content, "open_id");
  const name = userId && ctx.userName ? await ctx.userName(userId) : undefined;
  return `[分享名片：${name || fallbackName(userId || "user")}]`;
}

function renderSystem(content: Record<string, unknown>): string {
  let template = stringField(content, "template") || stringField(content, "text");
  if (!template) return "系统消息";
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(content)) {
    if (key === "template") continue;
    values[key] = formatSystemValue(value);
  }
  const divider = asRecord(content.divider_text);
  const i18n = divider ? asRecord(divider.i18n_text) : undefined;
  if (i18n?.zh_cn) values.divider_text = String(i18n.zh_cn);
  template = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_all, key: string) => values[key] ?? "");
  return template.replaceAll(/\s+/g, " ").trim();
}

function formatSystemValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => formatSystemValue(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    const i18n = asRecord(record.i18n_text);
    if (i18n?.zh_cn) return String(i18n.zh_cn);
  }
  return "";
}

function renderLocation(content: Record<string, unknown>): string {
  const name = stringField(content, "name");
  const longitude = stringField(content, "longitude");
  const latitude = stringField(content, "latitude");
  return `[位置：${name} ${longitude},${latitude}]`.replace("  ,", " ");
}

async function renderTodo(content: Record<string, unknown>, ctx: NormalizeContext): Promise<string> {
  const summary = content.summary;
  let title = "";
  if (typeof summary === "string") title = summary;
  else if (summary && typeof summary === "object") {
    const rendered = renderPost(summary as Record<string, unknown>, ctx, [], "label");
    title = rendered.replaceAll("\n", " ").replace(/\*\*/g, "");
  }
  const due = stringField(content, "due_time");
  const dueText = due ? ` 截止 ${formatMessageTime(millisToIso(due), ctx.timeZone ?? "Asia/Shanghai", ctx.now)}` : "";
  return `[任务：${title || "待办"}${dueText}]`;
}

function renderVote(content: Record<string, unknown>): string {
  const topic = stringField(content, "topic");
  const options = Array.isArray(content.options)
    ? content.options
        .map((option) => (typeof option === "string" ? option : plainText(option) || stringField(asRecord(option) ?? {}, "text") || stringField(asRecord(option) ?? {}, "content")))
        .filter(Boolean)
    : [];
  return `[投票：${topic}${options.length ? ` 选项：${options.join("/")}` : ""}]`;
}

function renderCalendar(content: Record<string, unknown>, ctx: NormalizeContext): string {
  const summary = stringField(content, "summary") || stringField(content, "topic") || "日程";
  const start = stringField(content, "start_time");
  const end = stringField(content, "end_time");
  const zone = ctx.timeZone ?? "Asia/Shanghai";
  const startText = start ? formatMessageTime(millisToIso(start), zone, ctx.now) : "";
  const endText = end ? formatClock(millisToIso(end), zone) : "";
  const range = startText ? ` ${startText}${endText ? `–${endText}` : ""}` : "";
  return `[日程：${summary}${range}]`;
}

function renderVideoChat(content: Record<string, unknown>, ctx: NormalizeContext): string {
  const topic = stringField(content, "topic") || "会议";
  const start = stringField(content, "start_time");
  const when = start ? ` ${formatMessageTime(millisToIso(start), ctx.timeZone ?? "Asia/Shanghai", ctx.now)}` : "";
  return `[视频会议：${topic}${when}]`;
}

function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("hour")}:${pick("minute")}`;
}

export function millisToIso(value: string): string {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    const ms = value.length <= 10 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  return value;
}

function numberField(content: Record<string, unknown>, key: string): number {
  const value = content[key];
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stripControl(text: string): string {
  return stripControlChars(text);
}
