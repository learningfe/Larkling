import type { PersonRef, Scope, TaskAudience } from "./types.js";

const OPEN_ID = /^ou_[A-Za-z0-9]+$/;
const ROLES = ["own", "drive", "track"] as const;

export class AudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceError";
  }
}

export function emptyAudience(): TaskAudience {
  return { own: [], drive: [], track: [] };
}

/** Old records omit audience. That is empty, not a guess about who belongs. */
export function storedAudience(audience: TaskAudience | undefined): TaskAudience {
  return canonicalAudience({
    own: audience?.own ?? [],
    drive: audience?.drive ?? [],
    track: audience?.track ?? [],
  });
}

/**
 * A person is kept once, in the earliest role (Own, then Drive, then Track).
 * Moving someone requires the earlier role to be sent without them.
 */
export function canonicalAudience(audience: TaskAudience): TaskAudience {
  const seen = new Set<string>();
  const take = (people: PersonRef[]): PersonRef[] => {
    const out: PersonRef[] = [];
    for (const person of people) {
      if (seen.has(person.openId)) continue;
      seen.add(person.openId);
      out.push(person);
    }
    return out;
  };
  return { own: take(audience.own), drive: take(audience.drive), track: take(audience.track) };
}

/** Roles omitted from a patch stay as they are. A sent role replaces that role. */
export function applyAudience(current: TaskAudience | undefined, patch: Partial<TaskAudience>): TaskAudience {
  const base = storedAudience(current);
  return canonicalAudience({
    own: patch.own ?? base.own,
    drive: patch.drive ?? base.drive,
    track: patch.track ?? base.track,
  });
}

/** Validate a model-supplied audience object. Does not invent people. */
export function readAudiencePatch(value: unknown): Partial<TaskAudience> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudienceError("audience must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROLES.includes(key as (typeof ROLES)[number])) throw new AudienceError(`unknown audience field ${key}`);
  }
  const patch: Partial<TaskAudience> = {};
  for (const role of ROLES) {
    if (!Object.hasOwn(record, role)) continue;
    patch[role] = readPeople(record[role], role);
  }
  return patch;
}

function readPeople(value: unknown, role: string): PersonRef[] {
  if (!Array.isArray(value)) throw new AudienceError(`audience.${role} must be an array`);
  return value.map((item, index) => readPerson(item, `audience.${role}[${index}]`));
}

function readPerson(value: unknown, where: string): PersonRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudienceError(`${where} must be a person`);
  const openId = (value as { openId?: unknown }).openId;
  const name = (value as { name?: unknown }).name;
  if (typeof openId !== "string" || !OPEN_ID.test(openId)) {
    throw new AudienceError(`${where}.openId must be a Feishu open_id (ou_…)`);
  }
  if (typeof name !== "string") throw new AudienceError(`${where}.name is required`);
  const cleaned = cleanName(name);
  if (!cleaned) throw new AudienceError(`${where}.name is required`);
  return { openId, name: cleaned };
}

/** Drop characters that would close a Feishu `<at>` tag or start another line. */
function cleanName(name: string): string {
  return name.replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Feishu treats `<at user_id="ou_…">` and `<at user_id="all">` in outbound text as real
 * mentions. Model text is untrusted, so those tags become plain `@name` before the
 * harness inserts its own. Call this on the model text only, never on the prefix.
 */
export function neutralizeUntrustedMentions(text: string): string {
  const paired = /<\s*at\b([^<>]*)>([\s\S]*?)<\s*\/\s*at\s*>/gi;
  return text
    .replace(paired, (_whole, attrs: string, inner: string) => plainMention(attrs, inner))
    .replace(/<\s*at\b[^<>]*>/gi, "")
    .replace(/<\s*\/\s*at\s*>/gi, "");
}

function plainMention(attrs: string, inner: string): string {
  const id = /\buser_id\s*=\s*["']?([^\s"'<>]+)/i.exec(attrs)?.[1] ?? "";
  if (id === "all") return "@all";
  const name = inner.replace(/<[^>]*>/g, "").trim();
  return name ? `@${name}` : "";
}

/** Feishu mention tags in Own, Drive, Track order. Skips ids in `skipOpenIds` and repeats. */
export function renderAudienceMentions(audience: TaskAudience | undefined, skipOpenIds: Iterable<string> = []): string {
  const skip = new Set(skipOpenIds);
  const people = storedAudience(audience);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const person of [...people.own, ...people.drive, ...people.track]) {
    if (!person || typeof person.openId !== "string" || !OPEN_ID.test(person.openId)) continue;
    if (skip.has(person.openId) || seen.has(person.openId)) continue;
    const name = cleanName(person.name ?? "");
    if (!name) continue;
    seen.add(person.openId);
    tags.push(`<at user_id="${person.openId}">${name}</at>`);
  }
  return tags.join(" ");
}

/**
 * Group and topic replies that opt in get the task audience prepended.
 * DMs keep the text and do not @.
 */
export function renderNotifyingReply(options: {
  text: string;
  scopeKind: Scope["kind"];
  audience?: TaskAudience;
  skipOpenIds?: Iterable<string>;
}): string {
  const text = neutralizeUntrustedMentions(options.text);
  if (options.scopeKind === "dm") return text;
  const prefix = renderAudienceMentions(options.audience, options.skipOpenIds);
  if (!prefix) return text;
  return text ? `${prefix} ${text}` : prefix;
}
