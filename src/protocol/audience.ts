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

const AT_TAG = /<\s*at\b([^<>]*)>([\s\S]*?)<\s*\/\s*at\s*>/gi;
const KEPT_AT = /\u0000(\d+)\u0000/g;

/**
 * Model-written Feishu `<at>` tags. Group and topic replies keep a tag only when
 * `user_id` is a well-formed `ou_` open id. `all` and any other id become plain
 * text. A DM renders no real mention: every tag becomes plain text.
 * Kept tags are held aside so the unpaired-tag sweep does not strip them.
 */
export function renderOutboundMentions(text: string, scopeKind: Scope["kind"]): string {
  const dm = scopeKind === "dm";
  const kept: string[] = [];
  const replaced = text.replace(AT_TAG, (_whole, attrs: string, inner: string) => {
    const id = /\buser_id\s*=\s*["']?([^\s"'<>]+)/i.exec(attrs)?.[1] ?? "";
    const name = cleanName(inner);
    if (!dm && OPEN_ID.test(id)) {
      kept.push(`<at user_id="${id}">${name}</at>`);
      return `\u0000${kept.length - 1}\u0000`;
    }
    if (id === "all") return "@all";
    return name ? `@${name}` : "";
  });
  const stripped = replaced.replace(/<\s*at\b[^<>]*>/gi, "").replace(/<\s*\/\s*at\s*>/gi, "");
  return stripped.replace(KEPT_AT, (_mark, index: string) => kept[Number(index)] ?? "");
}
