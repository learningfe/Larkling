/**
 * Larkling protocol. Adapters depend only on these shapes.
 *
 * Extensions beyond the written union, required to carry section 6.2:
 * - MessageEvent.disposition: store-only and unsupported types have no protocol field.
 * - MessageEvent.mentionsOthers: gate drops messages that mention someone else and not this bot.
 * - SessionSpec.kind includes "compact" because transcript compaction is specified
 *   but omitted from the session-kind union.
 * - Person.refs: platform address ids, so owner DMs can be sent from a stableId.
 */

export type Trust = "owner" | "trusted" | "allowed" | "denied";

export interface Scope {
  channel: string;
  kind: "dm" | "group" | "topic";
  id: string;
  parentId?: string;
}

export interface Actor {
  channel: string;
  /** Platform address id. Only the channel adapter interprets it. */
  ref: string;
  /** Stable key. Feishu uses `feishu:<open_id>`. */
  stableId: string;
  name: string;
  isBot: boolean;
}

export interface Person {
  personId: string;
  identities: string[];
  /** Most recently seen display name first. */
  names: string[];
  lastSeenAt: string;
  /** Platform refs (Feishu open_id), most recent first. Not used as identity. */
  refs: string[];
  /**
   * True when this record was seen as a bot. Omitted on older files; readers treat that as false.
   * A later human sighting does not clear it.
   */
  isBot?: boolean;
}

export type AttachmentKind = "image" | "file" | "audio" | "video";

export interface AttachmentRef {
  kind: AttachmentKind;
  messageId: string;
  key: string;
  name?: string;
}

export interface MentionRef {
  ref: string;
  name: string;
  /** From Feishu `mentioned_type: bot`. Omitted means a person. */
  isBot?: boolean;
}

export type MessageDisposition = "normal" | "store_only" | "unsupported";

export interface MessageEvent {
  type: "message";
  eventId: string;
  messageId: string;
  scope: Scope;
  actor: Actor;
  text: string;
  attachments: AttachmentRef[];
  mentionsSelf: boolean;
  mentionsOthers?: boolean;
  /** Real @ mentions (authoritative); ref "all" means @all. */
  mentions?: MentionRef[];
  disposition?: MessageDisposition;
  replyTo?: string;
  occurredAt: string;
  /** Wall time spent preparing this message before enqueue (e.g. Feishu speech-to-text). */
  audioPrepMs?: number;
}

export type ChannelEvent =
  | MessageEvent
  | { type: "recalled"; eventId: string; messageId: string; scope: Scope }
  | {
      type: "reaction";
      eventId: string;
      messageId: string;
      scope: Scope;
      actor: Actor;
      emoji: string;
      action: "added" | "removed";
    }
  | {
      type: "approval_decision";
      approvalId: string;
      actor: Actor;
      decision: "approve" | "deny";
    }
  | { type: "names"; entries: { stableId: string; ref: string; name: string; isBot?: boolean }[] }
  /** Group info changed (Feishu `im.chat.updated_v1`). */
  | { type: "chat_updated"; chatId: string; name?: string };

export type SessionKind = "conversation" | "task" | "check" | "judge" | "compact";

export interface TranscriptEntryBase {
  seq: number;
  at: string;
  turnId?: string;
}

export type TranscriptEntry = TranscriptEntryBase &
  (
    | { type: "turn.started"; trigger: "message" | "task_event" | "steer" }
    | {
        type: "inbound";
        messageId: string;
        actor: Actor;
        trust: Trust;
        text: string;
        attachments: AttachmentRef[];
      }
    | { type: "recalled"; messageId: string }
    | { type: "reply"; reply: FinalReply; delivered: boolean }
    | { type: "task_event"; taskId: string; reason: "ended" | "failed" | "check"; text: string }
    | { type: "task_result"; text: string }
    | {
        type: "approval";
        approvalId: string;
        kind: string;
        summary: string;
        decision?: "approve" | "deny";
      }
    | { type: "turn.ended"; outcome: "completed" | "failed" | "interrupted"; error?: string }
    | { type: "compacted"; throughSeq: number; summary: string }
  );

/** Input to the transcript log. `seq` and `at` are filled by the store when omitted. */
export type TranscriptWrite = {
  [T in TranscriptEntry["type"]]: Omit<Extract<TranscriptEntry, { type: T }>, "seq" | "at"> & {
    at?: string;
    seq?: number;
  };
}[TranscriptEntry["type"]];

export type FinalReply = { kind: "text"; text: string } | { kind: "silent" };

export type RuntimeRef = string;

export interface RuntimeProfile {
  /** LLM provider id, used by runtimes such as pi that serve several providers. */
  provider?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  approvalPolicy?: string;
  cwd?: string;
  /** When true, the runtime should prefer a faster service tier. */
  fast?: boolean;
  /** When true, sandboxed commands may use the network. */
  network?: boolean;
  extra?: Record<string, unknown>;
}

export interface Seed {
  text: string;
  throughSeq: number;
  estimatedTokens: number;
}

export interface SessionSpec {
  sessionId: string;
  kind: SessionKind;
  runtimeRef?: string;
  seed?: Seed;
  profile: RuntimeProfile;
  instructions: string;
  /** Env vars the runtime should pass to the child (e.g. task API url and session token for front tools). */
  toolEnv?: Record<string, string>;
}

export interface InputImage {
  path: string;
  name?: string;
}

export interface InputMessage {
  text: string;
  messageId?: string;
  images?: InputImage[];
  /** The text already appears, with its header, in the turn context window. */
  inContext?: boolean;
}

export interface TurnInput {
  turnId: string;
  context: string;
  messages: InputMessage[];
}

export type ApprovalKind = "command" | "file_change" | "permission" | "tool";

export type RuntimeEvent =
  | { type: "turn.started"; sessionId: string; turnId: string }
  | { type: "activity"; sessionId: string; turnId: string; summary?: string }
  | {
      type: "approval.requested";
      sessionId: string;
      turnId: string;
      approvalId: string;
      kind: ApprovalKind;
      summary: string;
    }
  | { type: "turn.completed"; sessionId: string; turnId: string; text: string }
  | { type: "turn.failed"; sessionId: string; turnId: string; error: string; retryable: boolean }
  | { type: "turn.interrupted"; sessionId: string; turnId: string }
  | { type: "runtime.lost"; sessionIds: string[] };

export interface RuntimeAdapter {
  readonly name: string;
  readonly capabilities: { steer: boolean; approvals: boolean };
  open(session: SessionSpec): Promise<RuntimeRef>;
  start(ref: RuntimeRef, input: TurnInput): Promise<void>;
  steer(ref: RuntimeRef, input: TurnInput): Promise<void>;
  interrupt(ref: RuntimeRef): Promise<void>;
  resolveApproval(ref: RuntimeRef, approvalId: string, decision: "approve" | "deny"): Promise<void>;
  updateInstructions(ref: RuntimeRef, instructions: string): Promise<"applied" | "unsupported">;
  release(ref: RuntimeRef): Promise<void>;
  events(): AsyncIterable<RuntimeEvent>;
  health(): Promise<HealthItem[]>;
}

export interface HealthItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export type OutboundAction =
  | { type: "text"; scope: Scope; text: string; replyTo?: string; idempotencyKey: string }
  | {
      type: "approval_card";
      owner: Actor;
      approvalId: string;
      summary: string;
      idempotencyKey: string;
    };

export interface DeliveryResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ImRecord {
  messageId: string;
  scope: Scope;
  actor: Actor;
  text: string;
  attachments: AttachmentRef[];
  mentionsSelf: boolean;
  mentions?: MentionRef[];
  occurredAt: string;
  recalled?: boolean;
  replyTo?: string;
}

export interface ChannelAdapter {
  readonly channel: string;
  readonly capabilities: { readGroupMessages: boolean };
  events(): AsyncIterable<ChannelEvent>;
  send(action: OutboundAction): Promise<DeliveryResult>;
  profile(target: Scope | Actor): Promise<Profile | undefined>;
  history(q: {
    container: string;
    start?: string;
    end?: string;
    limit: number;
    withRoot?: boolean;
  }): Promise<ImRecord[]>;
  download(ref: AttachmentRef): Promise<string>;
  health(): Promise<HealthItem[]>;
  /** Group info for the directory cache. Optional per channel. */
  chatInfo?(chatId: string): Promise<{ name?: string } | undefined>;
  /** Every member of a group for the directory cache. Optional per channel. */
  chatMembers?(chatId: string): Promise<{ openId: string; name: string }[]>;
}

export interface Profile {
  name?: string;
  stableId?: string;
  ref?: string;
}

/** A Feishu person the model has placed in a task audience. `openId` is `ou_…`. */
export interface PersonRef {
  openId: string;
  name: string;
}

/**
 * Who a matter's group/topic replies @, in order.
 * Own is the original asker, Drive pushes the matter, Track is notified.
 * Not cancel rights, approval, memory ownership, or trust.
 */
export interface TaskAudience {
  own: PersonRef[];
  drive: PersonRef[];
  track: PersonRef[];
}

export interface TaskRecord {
  taskId: string;
  parentSessionId: string;
  source: { messageId: string; personId: string; turnId: string };
  /** Goal / current progress / next step / recent notes. Maintained by the front agent. */
  body: string;
  /**
   * Present once a task is created or its audience is written.
   * Records from before audience existed omit it; readers treat that as empty.
   * The harness does not fill this from the asker, history, or a ticket owner.
   */
  audience?: TaskAudience;
  followUpEnabled: boolean;
  version: number;
  status: "queued" | "running" | "ended" | "cancelling" | "cancelled";
  sessionId?: string;
  lastResult?: string;
  lastCheck?: { at: string; progress: string };
  pendingEvent?: TaskEvent;
  /** Latest runtime activity line. Returned by task get; not part of the durable body. */
  activity?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskEvent = { reason: "ended" | "failed" | "check"; text: string; at: string };

export type QueuedInput =
  | {
      kind: "message";
      messageId: string;
      actor: Actor;
      trust: Trust;
      text: string;
      attachments: AttachmentRef[];
      occurredAt: string;
      mentions?: MentionRef[];
      /** Wall time spent preparing audio for this message, when present. */
      audioPrepMs?: number;
    }
  | { kind: "task_event"; taskId: string; reason: TaskEvent["reason"]; text: string; at: string }
  | { kind: "prompt"; text: string };

export type SessionPhase = "idle" | "running" | "awaiting_approval";

export interface ActiveTurn {
  turnId: string;
  trigger: "message" | "task_event" | "steer";
  messageIds: string[];
  recalledMessageIds: string[];
  suppressOutbound: boolean;
  retries: number;
  startedAt: string;
  lastActivityAt: string;
  input: TurnInput;
  /** Stable id of the user message that opened the turn, when there was one. */
  sourceStableId?: string;
  /** Why the core interrupted, if it did. */
  interruptReason?: "watchdog" | "cancel" | "timeout" | "lost" | "restart";
}

export interface SessionRecord {
  sessionId: string;
  kind: SessionKind;
  scope?: Scope;
  runtimeName: string;
  runtimeRef?: string;
  instructionsHash?: string;
  lastSeq: number;
  phase: SessionPhase;
  queue: QueuedInput[];
  activeTurn?: ActiveTurn;
  pendingApprovalIds: string[];
  idleSince?: string;
  parentSessionId?: string;
  taskId?: string;
  /** Container id used by `larkling im` for task sessions (the parent scope). */
  imContainer?: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  /** Runtime handle is currently open. */
  live: boolean;
  lastUsedAt?: string;
}

export interface ApprovalRecord {
  approvalId: string;
  sessionId: string;
  turnId: string;
  kind: string;
  summary: string;
  status: "pending" | "approved" | "denied";
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface OutboundRecord {
  idempotencyKey: string;
  result: DeliveryResult;
  at: string;
}

export interface TokenRecord {
  token: string;
  sessionId: string;
  role: "session" | "task" | "owner";
}

export interface BotState {
  version: 1;
  sessions: Record<string, SessionRecord>;
  tasks: Record<string, TaskRecord>;
  tokens: Record<string, TokenRecord>;
  seenEventIds: string[];
  seenMessageIds: string[];
  botChains: Record<string, number>;
  participatedTopics: string[];
  outbound: Record<string, OutboundRecord>;
  approvals: Record<string, ApprovalRecord>;
  memberSyncAt: Record<string, string>;
  botIdentity?: { openId?: string; stableId?: string; name?: string };
}

export function emptyState(): BotState {
  return {
    version: 1,
    sessions: {},
    tasks: {},
    tokens: {},
    seenEventIds: [],
    seenMessageIds: [],
    botChains: {},
    participatedTopics: [],
    outbound: {},
    approvals: {},
    memberSyncAt: {},
  };
}

export function conversationSessionId(scope: Scope): string {
  return `${scope.channel}:${scope.kind}:${scope.id}`;
}

export function taskSessionId(taskId: string): string {
  return `task:${taskId}`;
}

export function scopeKey(scope: Scope): string {
  return `${scope.channel}:${scope.kind}:${scope.id}`;
}
