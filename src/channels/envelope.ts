const BODY_LIMIT = 8000;

export function stripControlChars(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) out += char;
  }
  return out;
}

export function truncateBody(text: string, limit = BODY_LIMIT): string {
  const clean = stripControlChars(text);
  if ([...clean].length <= limit) return clean;
  const chars = [...clean];
  const sliced = chars.slice(0, limit).join("");
  return `${sliced}…（已截断，共 ${chars.length} 字）`;
}

export function formatMessageTime(occurredAt: string, timeZone: string, now = new Date()): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return occurredAt;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const nowYear = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now);
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  if (year !== nowYear) return `${year}-${month}-${day} ${hour}:${minute}`;
  return `${month}-${day} ${hour}:${minute}`;
}

/** One header line plus the body, for human-facing history display. Not model input. */
export function renderEnvelope(options: {
  name: string;
  isSelf: boolean;
  occurredAt: string;
  messageId: string;
  body: string;
  timeZone: string;
  now?: Date;
}): string {
  const who = options.isSelf ? "我" : options.name;
  const when = formatMessageTime(options.occurredAt, options.timeZone, options.now);
  return `[${who} ${when} #${options.messageId}]\n${options.body}`;
}

export function fallbackName(refOrStable: string): string {
  return `用户${refOrStable.slice(-4)}`;
}
