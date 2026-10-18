import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LarklingConfig } from "../config.js";
import { runtimeLimits } from "../config.js";
import type {
  ActiveTurn,
  Actor,
  AttachmentRef,
  ChannelAdapter,
  ChannelEvent,
  ImRecord,
  InputMessage,
  MessageEvent,
  OutboundAction,
  QueuedInput,
  RuntimeAdapter,
  RuntimeEvent,
  Scope,
  SessionKind,
  SessionRecord,
  TaskRecord,
  TokenRecord,
  TranscriptEntry,
  TranscriptWrite,
  TurnInput,
} from "../protocol/types.js";
import { conversationSessionId, scopeKey, taskSessionId } from "../protocol/types.js";
import { applyAudience, AudienceError, emptyAudience, neutralizeUntrustedMentions, readAudiencePatch, renderNotifyingReply, storedAudience } from "../protocol/audience.js";
import { parseCheckReply, parseConversationReply, parseJudgeReply } from "../protocol/reply.js";
import { buildSeed, transcriptTokens } from "../protocol/seed.js";
import { backInstructions, compactInstructions, frontInstructions, heartbeatInstructions, relevanceInstructions, withFile } from "../tasks/prompts.js";
import { listenApi, type TaskStartBody, type TaskUpdateBody } from "../tasks/api.js";
import { heartbeatDue, slotsUsed } from "../tasks/scheduler.js";
import { newId, sha256 } from "../util/id.js";
import { Logger } from "../log.js";
import { purgeOldFiles } from "./cleanup.js";
import { systemClock, type Clock } from "./clock.js";
import { checkContext, conversationContext, isSelf, judgeContext, taskContext, type YouProfile } from "./context.js";
import { batchTrigger, classifyArrival, takeBatch, withoutMessage } from "./delivery.js";
import { ApiError, isSteerRejected, SteerRejected } from "./errors.js";
import { Gate, logGateDecision } from "./gate.js";
import { ImLog, type StoredMessage } from "./imlog.js";
import { KeyedLock } from "./lock.js";
import { PersonDirectory } from "./persons.js";
import { Directory } from "./directory.js";
import { StateStore } from "./state.js";
import { TranscriptStore } from "./transcript.js";
import { resolveTrust, trustAtLeast } from "./trust.js";
import { selectWindow } from "./window.js";
import { advanceMark, localIso, newSince, toTurnMessage, type HistoryMark, type StructuredTurn } from "./turninput.js";

const INCREMENTAL_LIMIT = 500;
const HISTORY_RETRIES = 2;
const HISTORY_BACKOFF_MS = 300;

export interface BotIdentity {
  ref: string;
  stableId: string;
  name: string;
}

export interface HostOptions {
  config: LarklingConfig;
  channel: ChannelAdapter;
  runtimes: Map<string, RuntimeAdapter>;
  clock?: Clock;
  logger?: Logger;
  bot?: BotIdentity;
  /** Production starts timers. Tests drive `tick` and `flushGate` themselves. */
  timers?: boolean;
}

interface Waiter {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface Finish {
  kind: "completed" | "failed" | "interrupted";
  turnId?: string;
  text?: string;
  error?: string;
  retryable?: boolean;
  reason?: ActiveTurn["interruptReason"];
}

const FILE_TTL_MS = 7 * 86_400_000;
const IM_TTL_MS = 180 * 86_400_000;
const TASK_TTL_MS = 30 * 86_400_000;

export class Host {
  readonly config: LarklingConfig;
  readonly channel: ChannelAdapter;
  readonly clock: Clock;
  readonly log: Logger;
  apiUrl = "";
  ownerToken = "";
  /** How agents invoke this CLI: the node binary plus the absolute script path. */
  cli: string[] = [process.execPath, resolve(process.argv[1] ?? "larkling")];

  private readonly runtimes: Map<string, RuntimeAdapter>;
  private readonly lock = new KeyedLock();
  private readonly gate: Gate;
  private readonly waiters = new Map<string, Waiter>();
  private readonly disabled = new Set<string>();
  private readonly losses = new Map<string, number[]>();
  private readonly attachments = new Map<string, AttachmentRef[]>();
  private readonly visibleMessages = new Map<string, Set<string>>();
  private readonly historyMarks = new Map<string, HistoryMark>();
  private stateStore!: StateStore;
  private persons!: PersonDirectory;
  private directory!: Directory;
  private transcripts!: TranscriptStore;
  private imlog!: ImLog;
  private bot: BotIdentity;
  private stopping = false;
  private inflight = 0;
  private checksRunning = 0;
  private judgesRunning = 0;
  private judgeWait: Array<{ scope: Scope; messages: MessageEvent[] }> = [];
  private lastHeartbeat = 0;
  private readonly useTimers: boolean;
  private readParticipated: () => readonly string[] = () => [];
  private timerHandles: NodeJS.Timeout[] = [];
  private apiClose: (() => Promise<void>) | undefined;
  private loops: Promise<void>[] = [];

  constructor(options: HostOptions) {
    this.config = options.config;
    this.channel = options.channel;
    this.runtimes = options.runtimes;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? new Logger(join(options.config.stateDir, "log.jsonl"), "info");
    this.bot = options.bot ?? { ref: "bot", stableId: `${options.channel.channel}:bot`, name: "bot" };
    this.useTimers = options.timers ?? false;
    this.gate = new Gate(options.config, options.channel.capabilities.readGroupMessages, this.clock, () => this.readParticipated(), this.log);
  }

  async start(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.config.stateDir, "files"), { recursive: true });
    this.stateStore = await StateStore.open(this.config.stateDir);
    this.persons = await PersonDirectory.open(this.config.stateDir);
    this.directory = await Directory.open(this.config.stateDir);
    const channel = this.channel;
    if (channel.chatInfo && channel.chatMembers) {
      this.directory.attach({ chatInfo: (id) => channel.chatInfo!(id), chatMembers: (id) => channel.chatMembers!(id) });
    }
    this.transcripts = new TranscriptStore(this.config.stateDir);
    this.imlog = new ImLog(this.config.stateDir);
    this.readParticipated = () => this.stateStore.get().participatedTopics;
    await this.recover();
    await this.cleanup();
    const api = await listenApi({
      taskStart: (token, body) => this.taskStart(token, body),
      taskContinue: (token, body) => this.taskContinue(token, body),
      taskUpdate: (token, body) => this.taskUpdate(token, body),
      taskGet: (token, body) => this.taskGet(token, body),
      taskList: (token) => this.taskList(token),
      taskCancel: (token, taskId) => this.taskCancel(token, taskId),
      imHistory: (token, body) => this.imHistory(token, body),
      imFile: (token, body) => this.imFile(token, body),
      personLookup: (token, body) => this.personLookup(token, body),
      groupLookup: (token, body) => this.groupLookup(token, body),
    });
    this.apiUrl = api.url;
    this.apiClose = api.close;
    await writeFile(join(this.config.stateDir, "api.url"), api.url, { mode: 0o600 });
    await mkdir(this.frontDir(), { recursive: true });
    this.ownerToken = await this.ensureOwnerToken();
    this.loops = [this.consumeChannel(), ...[...this.runtimes.values()].map((runtime) => this.consumeRuntime(runtime))];
    await this.redeliverPending();
    await this.pumpTasks();
    await this.drainIdle();
    if (this.useTimers) this.armTimers();
    this.log.info("started", { api: this.apiUrl });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timerHandles) clearInterval(timer);
    if ("close" in this.channel && typeof (this.channel as { close?: () => void }).close === "function") {
      (this.channel as { close: () => void }).close();
    }
    for (const runtime of this.runtimes.values()) {
      if ("close" in runtime && typeof (runtime as { close?: () => void }).close === "function") (runtime as { close: () => void }).close();
    }
    await Promise.allSettled(this.loops);
    await this.apiClose?.();
  }

  /** Wait until accepted turns have finished. Approval waits are idle. */
  async settle(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    for (;;) {
      const busy = this.inflight > 0 || this.checksRunning > 0 || this.judgesRunning > 0 || this.runtimePending() || this.sessionsBusy();
      if (!busy) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`settle timed out (inflight=${this.inflight}, checks=${this.checksRunning}, judges=${this.judgesRunning})`);
      }
      await delay(10);
    }
  }

  async tick(now = this.clock.now()): Promise<void> {
    await this.watchdog(now);
    await this.taskTimeouts(now);
    await this.releaseIdle(now);
    if (this.config.tasks.heartbeat.enabled && now - this.lastHeartbeat >= this.config.tasks.heartbeat.scanIntervalMs) {
      this.lastHeartbeat = now;
      await this.scanHeartbeat(now);
    }
    await this.pumpTasks();
    await this.flushGate(now);
  }

  async flushGate(now = this.clock.now()): Promise<void> {
    for (const batch of this.gate.due(now)) this.judgeWait.push({ scope: batch.scope, messages: batch.messages });
    await this.pumpJudges();
  }

  snapshot() {
    return this.stateStore.get();
  }

  private armTimers(): void {
    this.timerHandles.push(setInterval(() => void this.tick().catch((error) => this.log.error("tick", { error: String(error) })), 1000));
  }

  private async recover(): Promise<void> {
    const now = this.iso();
    await this.stateStore.update((draft) => {
      for (const approval of Object.values(draft.approvals)) {
        if (approval.status !== "pending") continue;
        approval.status = "denied";
        approval.decidedAt = now;
      }
      for (const session of Object.values(draft.sessions)) {
        if (session.kind === "check" || session.kind === "judge" || session.kind === "compact") {
          delete draft.sessions[session.sessionId];
          delete draft.tokens[session.token];
          continue;
        }
        // The runtime process is gone. Keep runtimeRef so the next turn can resume.
        session.live = false;
        // The configured runtime changed (e.g. codex -> pi). The old ref belongs to the other
        // runtime, so drop it; the next turn opens a fresh session with the transcript seed.
        const configured = session.kind === "task" ? this.config.agents.back.runtime : this.config.agents.front.runtime;
        if (session.runtimeName !== configured) {
          session.runtimeName = configured;
          session.runtimeRef = undefined;
          session.instructionsHash = undefined;
        }
        if (session.activeTurn) {
          session.activeTurn.interruptReason = "restart";
          session.activeTurn.suppressOutbound = true;
          session.activeTurn = undefined;
          session.phase = "idle";
          session.pendingApprovalIds = [];
          session.idleSince = now;
        }
      }
      for (const task of Object.values(draft.tasks)) {
        if (task.status === "cancelling") {
          task.status = "cancelled";
          task.followUpEnabled = false;
          task.pendingEvent = undefined;
          task.updatedAt = now;
        } else if (task.status === "running") {
          task.status = "ended";
          task.pendingEvent = { reason: "failed", text: "interrupted by process restart", at: now };
          task.updatedAt = now;
        }
      }
    });
    for (const session of Object.values(this.stateStore.get().sessions)) {
      const max = await this.transcripts.maxSeq(session.sessionId);
      if (max > session.lastSeq) {
        await this.stateStore.update((draft) => {
          const current = draft.sessions[session.sessionId];
          if (current && current.lastSeq < max) current.lastSeq = max;
        });
      }
      if (session.activeTurn === undefined) {
        const previous = await this.transcripts.load(session.sessionId);
        const open = [...previous].reverse().find((entry) => entry.type === "turn.started");
        const closed = [...previous].reverse().find((entry) => entry.type === "turn.ended");
        if (open && (!closed || closed.seq < open.seq)) {
          await this.append(session.sessionId, { type: "turn.ended", outcome: "interrupted", error: "process restart", turnId: open.turnId });
        }
      }
    }
  }

  private async cleanup(): Promise<void> {
    const now = this.clock.now();
    await purgeOldFiles(join(this.config.stateDir, "files"), FILE_TTL_MS, now);
    await this.imlog.purgeOlderThan(new Date(now - IM_TTL_MS).toISOString());
    const cutoff = new Date(now - TASK_TTL_MS).toISOString();
    await this.stateStore.update((draft) => {
      for (const [id, task] of Object.entries(draft.tasks)) {
        if ((task.status === "ended" || task.status === "cancelled") && task.updatedAt < cutoff) {
          delete draft.tasks[id];
          if (task.sessionId) delete draft.sessions[task.sessionId];
        }
      }
    });
  }

  private async ensureOwnerToken(): Promise<string> {
    const existing = Object.values(this.stateStore.get().tokens).find((token) => token.role === "owner");
    if (existing) {
      await writeFile(join(this.config.stateDir, "owner.token"), existing.token, { mode: 0o600 });
      return existing.token;
    }
    const token = newId();
    await this.stateStore.update((draft) => {
      draft.tokens[token] = { token, sessionId: "owner", role: "owner" };
    });
    await writeFile(join(this.config.stateDir, "owner.token"), token, { mode: 0o600 });
    return token;
  }

  private async consumeChannel(): Promise<void> {
    try {
      for await (const event of this.channel.events()) {
        if (this.stopping) return;
        await this.tracked(this.onChannelEvent(event));
      }
    } catch (error) {
      if (!this.stopping) this.log.error("channel.loop", { error: String(error) });
    }
  }

  private async consumeRuntime(runtime: RuntimeAdapter): Promise<void> {
    try {
      for await (const event of runtime.events()) {
        if (this.stopping) return;
        await this.tracked(this.onRuntimeEvent(runtime, event));
      }
    } catch (error) {
      if (!this.stopping) this.log.error("runtime.loop", { runtime: runtime.name, error: String(error) });
    }
    if (!this.stopping) {
      const sessionIds = Object.values(this.stateStore.get().sessions)
        .filter((session) => session.runtimeName === runtime.name && session.live)
        .map((session) => session.sessionId);
      await this.onRuntimeLost(runtime.name, sessionIds);
    }
  }

  private async onChannelEvent(event: ChannelEvent): Promise<void> {
    if (event.type === "names") {
      for (const entry of event.entries) await this.persons.observeName(entry, this.iso());
      return;
    }
    if (event.type === "chat_updated") {
      if (event.name) await this.directory.setGroupName(event.chatId, event.name);
      return;
    }
    if (event.type !== "message") {
      const seen = await this.markEvent(event.type === "approval_decision" ? `approval:${event.approvalId}:${event.decision}` : event.eventId);
      if (!seen) return;
    }
    if (event.type === "recalled") {
      await this.onRecall(event.messageId, event.scope);
      return;
    }
    if (event.type === "reaction") return;
    if (event.type === "approval_decision") {
      await this.onApprovalDecision(event.approvalId, event.actor, event.decision);
      return;
    }
    await this.onMessage(event);
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const fresh = await this.markEvent(event.eventId);
    if (!fresh) return;
    const newMessage = await this.stateStore.update((draft) => {
      if (draft.seenMessageIds.includes(event.messageId)) return false;
      draft.seenMessageIds.push(event.messageId);
      if (draft.seenMessageIds.length > 5000) draft.seenMessageIds.splice(0, draft.seenMessageIds.length - 5000);
      return true;
    });
    if (!newMessage) return;
    await this.persons.observe(event.actor, event.occurredAt);
    await this.observeDirectory(event);
    const trust = resolveTrust(event.actor, event.scope, this.config);
    const fromBot = event.actor.stableId === this.bot.stableId || (event.actor.isBot && event.actor.ref === this.bot.ref);
    this.rememberAttachments(event.messageId, event.attachments);
    const participated = this.stateStore.get().participatedTopics;
    const store = this.imlog.shouldStore({ scope: event.scope, mentionsSelf: event.mentionsSelf, fromBot }, participated);
    if (store) {
      await this.imlog.append(this.storedFrom(event, fromBot, trust));
      if (event.scope.kind === "topic" && fromBot) {
        await this.stateStore.update((draft) => {
          if (!draft.participatedTopics.includes(event.scope.id)) draft.participatedTopics.push(event.scope.id);
        });
      }
    }
    if (!event.actor.isBot) {
      await this.stateStore.update((draft) => {
        draft.botChains[scopeKey(event.scope)] = 0;
      });
    }
    if (fromBot || event.disposition === "store_only") {
      this.logGateShortCircuit(event, "skip", fromBot ? "self" : "store_only");
      return;
    }
    if (!trustAtLeast(trust, "allowed")) {
      this.logGateShortCircuit(event, "skip", "trust");
      return;
    }
    const blocked = await this.stateStore.update((draft) => {
      const key = scopeKey(event.scope);
      if (!event.actor.isBot) return false;
      draft.botChains[key] = (draft.botChains[key] ?? 0) + 1;
      return draft.botChains[key] >= this.config.session.botChainLimit;
    });
    if (blocked) {
      this.logGateShortCircuit(event, "skip", "bot_chain");
      return;
    }
    if (event.disposition === "unsupported") {
      if (event.mentionsSelf || event.scope.kind === "dm") {
        const sessionId = await this.ensureConversation(event.scope);
        await this.deliver(
          {
            type: "text",
            scope: event.scope,
            text: "暂不支持该消息类型，请改发文字。",
            replyTo: event.messageId,
            idempotencyKey: newId(),
          },
          [event.scope],
          sessionId,
        );
      }
      this.logGateShortCircuit(event, "skip", "unsupported");
      return;
    }
    const gated = this.gate.accept(event, trust);
    if (gated === "dropped" || gated === "buffered") return;
    await this.deliverMessages(event.scope, gated);
  }

  private async deliverMessages(scope: Scope, messages: MessageEvent[]): Promise<void> {
    const sessionId = await this.ensureConversation(scope);
    const items: QueuedInput[] = messages.map((message) => ({
      kind: "message",
      messageId: message.messageId,
      actor: message.actor,
      trust: resolveTrust(message.actor, message.scope, this.config),
      text: message.text,
      attachments: message.attachments,
      occurredAt: message.occurredAt,
      audioPrepMs: message.audioPrepMs,
      mentions: message.mentions,
    }));
    await this.enqueue(sessionId, items);
  }

  private async onRecall(messageId: string, scope: Scope): Promise<void> {
    await this.imlog.recall(scope.id, messageId, this.iso());
    const sessionId = conversationSessionId(scope);
    const session = this.stateStore.get().sessions[sessionId];
    if (!session) return;
    await this.lock.run(sessionId, async () => {
      await this.stateStore.update((draft) => {
        const current = draft.sessions[sessionId];
        if (!current) return;
        current.queue = withoutMessage(current.queue, messageId);
        if (current.activeTurn?.messageIds.includes(messageId)) current.activeTurn.recalledMessageIds.push(messageId);
      });
      await this.append(sessionId, { type: "recalled", messageId });
    });
  }

  private async enqueue(sessionId: string, items: QueuedInput[]): Promise<void> {
    await this.lock.run(sessionId, async () => {
      const session = this.must(sessionId);
      const caps = this.capabilities(session);
      for (const item of items) {
        if (classifyArrival(session.phase, caps, item) === "steer") {
          try {
            await this.doSteer(sessionId, item);
          } catch (error) {
            if (!isSteerRejected(error)) throw error;
            await this.stateStore.update((draft) => {
              draft.sessions[sessionId]?.queue.unshift(item);
            });
          }
        } else {
          await this.stateStore.update((draft) => {
            draft.sessions[sessionId]?.queue.push(item);
          });
        }
      }
      if (this.must(sessionId).phase === "idle") await this.drain(sessionId);
    });
  }

  private async drain(sessionId: string): Promise<void> {
    const session = this.must(sessionId);
    if (session.phase !== "idle" || session.queue.length === 0) return;
    const { batch, rest } = takeBatch(session.queue);
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      if (current) current.queue = rest;
    });
    await this.doStart(sessionId, batch);
  }

  private async drainIdle(): Promise<void> {
    for (const session of Object.values(this.stateStore.get().sessions)) {
      if (session.phase === "idle" && session.queue.length) await this.enqueue(session.sessionId, []);
    }
  }

  private async doStart(sessionId: string, batch: QueuedInput[]): Promise<void> {
    const session = this.must(sessionId);
    if (session.kind === "task" && session.taskId) {
      const task = this.stateStore.get().tasks[session.taskId];
      if (!task || task.status === "cancelled" || task.status === "cancelling") {
        await this.stateStore.update((draft) => {
          const current = session.taskId ? draft.tasks[session.taskId] : undefined;
          if (current && current.status !== "cancelled") {
            current.status = "cancelled";
            current.followUpEnabled = false;
            current.pendingEvent = undefined;
            current.updatedAt = this.iso();
          }
          const live = draft.sessions[sessionId];
          if (live) {
            live.phase = "idle";
            live.queue = [];
            live.activeTurn = undefined;
          }
        });
        return;
      }
    }
    const prepStarted = Date.now();
    const cold = !(session.live && session.runtimeRef);
    let ensure: { seedMs: number; openMs: number };
    try {
      ensure = await this.ensureRuntime(session);
    } catch (error) {
      await this.failUndelivered(sessionId, batch, error instanceof Error ? error.message : String(error));
      return;
    }
    const ensureRuntimeMs = Date.now() - prepStarted;
    const buildStarted = Date.now();
    const built = await this.buildTurn(sessionId, batch, cold);
    const buildTurnMs = Date.now() - buildStarted;
    const turnId = newId();
    const input: TurnInput = { ...built.input, turnId };
    const audioMs = batch.reduce((sum, item) => sum + (item.kind === "message" ? item.audioPrepMs ?? 0 : 0), 0);
    this.log.info("turn.prep", {
      sessionId,
      turnId,
      cold,
      ensureRuntimeMs,
      seedMs: ensure.seedMs,
      openMs: ensure.openMs,
      buildTurnMs,
      historyMs: built.historyMs,
      audioMs,
      totalMs: Date.now() - prepStarted,
    });
    const messageIds = batch.flatMap((item) => (item.kind === "message" ? [item.messageId] : []));
    const now = this.iso();
    const turn: ActiveTurn = {
      turnId,
      trigger: batchTrigger(batch),
      messageIds,
      recalledMessageIds: [],
      suppressOutbound: false,
      sourceStableId: batch.find((item) => item.kind === "message")?.actor.stableId,
      retries: 0,
      startedAt: now,
      lastActivityAt: now,
      input,
    };
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      current.phase = "running";
      current.activeTurn = turn;
      current.idleSince = undefined;
      current.lastUsedAt = now;
      current.updatedAt = now;
    });
    await this.append(sessionId, { type: "turn.started", trigger: turn.trigger, turnId });
    for (const item of batch) {
      if (item.kind === "message") {
        await this.append(sessionId, {
          type: "inbound",
          turnId,
          messageId: item.messageId,
          actor: item.actor,
          trust: item.trust,
          text: item.text,
          attachments: item.attachments,
        });
      } else if (item.kind === "task_event") {
        await this.append(sessionId, { type: "task_event", turnId, taskId: item.taskId, reason: item.reason, text: item.text });
      }
    }
    try {
      await this.runtimeFor(this.must(sessionId)).start(this.must(sessionId).runtimeRef as string, input);
    } catch (error) {
      await this.finishTurn(sessionId, { kind: "failed", turnId, error: error instanceof Error ? error.message : String(error), retryable: true });
    }
  }

  private async doSteer(sessionId: string, item: QueuedInput): Promise<void> {
    const session = this.must(sessionId);
    const turn = session.activeTurn;
    if (!turn || !session.runtimeRef || !session.live) throw new SteerRejected("no active turn");
    const built = await this.buildTurn(sessionId, [item]);
    const input: TurnInput = { turnId: turn.turnId, context: built.input.context, messages: built.input.messages };
    await this.runtimeFor(session).steer(session.runtimeRef, input);
    turn.input = { turnId: turn.turnId, context: built.input.context, messages: [...turn.input.messages, ...built.input.messages] };
    if (item.kind === "message") turn.messageIds.push(item.messageId);
    turn.lastActivityAt = this.iso();
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      if (current?.activeTurn) current.activeTurn = turn;
    });
    if (item.kind === "message") {
      await this.append(sessionId, {
        type: "inbound",
        turnId: turn.turnId,
        messageId: item.messageId,
        actor: item.actor,
        trust: item.trust,
        text: item.text,
        attachments: item.attachments,
      });
    } else if (item.kind === "task_event") {
      await this.append(sessionId, { type: "task_event", turnId: turn.turnId, taskId: item.taskId, reason: item.reason, text: item.text });
    }
  }

  private async onRuntimeEvent(runtime: RuntimeAdapter, event: RuntimeEvent): Promise<void> {
    if (event.type === "runtime.lost") {
      await this.onRuntimeLost(runtime.name, event.sessionIds);
      return;
    }
    const session = this.stateStore.get().sessions[event.sessionId];
    if (!session) return;
    await this.lock.run(event.sessionId, async () => {
      const current = this.must(event.sessionId);
      const turn = current.activeTurn;
      if (!turn) return;
      if (event.turnId && event.turnId !== turn.turnId) return;
      if (event.type === "turn.started" || event.type === "activity") {
        turn.lastActivityAt = this.iso();
        if (event.type === "activity" && current.taskId) {
          const task = this.stateStore.get().tasks[current.taskId];
          if (task && event.summary) task.activity = event.summary;
        }
        await this.stateStore.update(() => undefined);
        return;
      }
      if (event.type === "approval.requested") {
        await this.onApprovalRequested(current, event.approvalId, event.kind, event.summary);
        return;
      }
      if (event.type === "turn.completed") {
        await this.finishTurn(event.sessionId, { kind: "completed", turnId: event.turnId, text: event.text });
        return;
      }
      if (event.type === "turn.failed") {
        await this.finishTurn(event.sessionId, { kind: "failed", turnId: event.turnId, error: event.error, retryable: event.retryable });
        return;
      }
      if (event.type === "turn.interrupted") {
        await this.finishTurn(event.sessionId, { kind: "interrupted", turnId: event.turnId, reason: turn.interruptReason });
      }
    });
  }

  private async finishTurn(sessionId: string, outcome: Finish): Promise<void> {
    const followups: Array<() => Promise<void>> = [];
    const session = this.must(sessionId);
    const turn = session.activeTurn;
    if (!turn) return;
    if (outcome.turnId && outcome.turnId !== turn.turnId) return;
    if (outcome.kind === "failed" && outcome.retryable && turn.retries < 2 && !turn.suppressOutbound && !turn.interruptReason) {
      turn.retries += 1;
      await this.stateStore.update((draft) => {
        const current = draft.sessions[sessionId];
        if (current?.activeTurn) current.activeTurn.retries = turn.retries;
      });
      await this.clock.sleep(200 * 2 ** (turn.retries - 1));
      try {
        await this.runtimeFor(session).start(session.runtimeRef as string, turn.input);
        return;
      } catch (error) {
        outcome = { kind: "failed", turnId: turn.turnId, error: error instanceof Error ? error.message : String(error), retryable: false };
      }
    }
    const text = outcome.text ?? "";
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      if (!current) return;
      current.phase = "idle";
      current.activeTurn = undefined;
      current.pendingApprovalIds = [];
      current.idleSince = this.iso();
      current.updatedAt = this.iso();
    });
    const ended: TranscriptEntry["type"] = "turn.ended";
    await this.append(sessionId, {
      type: ended,
      turnId: turn.turnId,
      outcome: outcome.kind === "completed" ? "completed" : outcome.kind === "interrupted" ? "interrupted" : "failed",
      error: outcome.error,
    });
      if (session.kind === "conversation") {
      let reply = parseConversationReply(text);
      const recalled = turn.messageIds.length > 0 && turn.messageIds.every((id) => turn.recalledMessageIds.includes(id));
      const suppress = turn.suppressOutbound || Boolean(turn.interruptReason) || outcome.kind !== "completed" || recalled;
      let delivered = false;
      if (!suppress && reply.kind === "text" && session.scope) {
        const scope = session.scope;
        const rendered = this.notifyingText(session, reply);
        reply = { ...reply, text: rendered };
        if (rendered.trim()) {
          await this.deliver({ type: "text", scope, text: rendered, replyTo: turn.messageIds.at(-1), idempotencyKey: newId() }, [scope], sessionId);
          delivered = true;
        }
      } else if (outcome.kind === "failed" && !turn.interruptReason && session.scope) {
        const scope = session.scope;
        await this.deliver(
          { type: "text", scope, text: `这一轮没有完成：${outcome.error ?? "unknown error"}`, idempotencyKey: newId() },
          [scope],
          sessionId,
        );
      }
      await this.append(sessionId, { type: "reply", turnId: turn.turnId, reply: suppress ? { kind: "silent" } : reply, delivered });
      if (turn.interruptReason === "watchdog") followups.push(() => this.notifyOwner(`会话 ${sessionId} 超过空闲时限，已中断。`, `watchdog:${turn.turnId}`));
      this.tracked(this.maybeCompact(sessionId));
    } else if (session.kind === "task" && session.taskId) {
      const taskId = session.taskId;
      await this.append(sessionId, { type: "task_result", turnId: turn.turnId, text });
      if (session.queue.length > 0 && turn.interruptReason !== "cancel" && turn.interruptReason !== "timeout" && turn.interruptReason !== "lost") {
        await this.drain(sessionId);
        for (const follow of followups) await follow();
        return;
      }
      let deliver = false;
      await this.stateStore.update((draft) => {
        const task = draft.tasks[taskId];
        if (!task) return;
        if (turn.interruptReason === "cancel" || task.status === "cancelling") {
          task.status = "cancelled";
          task.followUpEnabled = false;
          task.pendingEvent = undefined;
        } else if (outcome.kind === "completed") {
          task.status = "ended";
          task.lastResult = text;
          task.pendingEvent = { reason: "ended", text, at: this.iso() };
          deliver = true;
        } else {
          task.status = "ended";
          const reasonText = outcome.error ?? (turn.interruptReason === "timeout" ? "task idle timeout" : "task failed");
          task.pendingEvent = { reason: "failed", text: reasonText, at: this.iso() };
          task.lastResult = reasonText;
          deliver = true;
        }
        task.updatedAt = this.iso();
      });
      if (deliver) followups.push(() => this.deliverPending(taskId));
      followups.push(async () => {
        if (this.must(sessionId).phase === "idle") await this.releaseSession(sessionId);
      });
      followups.push(() => this.pumpTasks());
    } else if (session.kind === "check" || session.kind === "judge" || session.kind === "compact") {
      const waiter = this.waiters.get(sessionId);
      this.waiters.delete(sessionId);
      followups.push(() => this.releaseSession(sessionId));
      followups.push(async () => {
        await this.stateStore.update((draft) => {
          const current = draft.sessions[sessionId];
          if (!current) return;
          delete draft.tokens[current.token];
          delete draft.sessions[sessionId];
        });
      });
      if (outcome.kind === "completed") waiter?.resolve(text);
      else waiter?.reject(new Error(outcome.error ?? outcome.kind));
    }
    if (session.kind === "conversation" || session.kind === "task") await this.drain(sessionId);
    for (const follow of followups) await follow();
  }

  private async failUndelivered(sessionId: string, batch: QueuedInput[], error: string): Promise<void> {
    const session = this.stateStore.get().sessions[sessionId];
    if (session?.kind === "task" && session.taskId) {
      const taskId = session.taskId;
      await this.stateStore.update((draft) => {
        const task = draft.tasks[taskId];
        if (!task) return;
        task.status = "ended";
        task.pendingEvent = { reason: "failed", text: error, at: this.iso() };
        task.updatedAt = this.iso();
      });
      await this.deliverPending(taskId);
      return;
    }
    if (session?.scope) {
      await this.deliver(
        { type: "text", scope: session.scope, text: `这一轮没有完成：${error}`, idempotencyKey: newId() },
        [session.scope],
        sessionId,
      );
    }
    void batch;
  }

  private async onApprovalRequested(session: SessionRecord, approvalId: string, kind: string, summary: string): Promise<void> {
    const runtime = this.runtimeFor(session);
    if (session.kind === "check" || session.kind === "judge" || session.kind === "compact" || !runtime.capabilities.approvals) {
      if (session.runtimeRef) await runtime.resolveApproval(session.runtimeRef, approvalId, "deny");
      return;
    }
    const now = this.iso();
    await this.stateStore.update((draft) => {
      draft.approvals[approvalId] = {
        approvalId,
        sessionId: session.sessionId,
        turnId: session.activeTurn?.turnId ?? "",
        kind,
        summary,
        status: "pending",
        createdAt: now,
      };
      const current = draft.sessions[session.sessionId];
      if (!current) return;
      current.phase = "awaiting_approval";
      current.pendingApprovalIds.push(approvalId);
    });
    await this.append(session.sessionId, { type: "approval", approvalId, kind, summary, turnId: session.activeTurn?.turnId });
    const owner = this.ownerActor();
    if (!owner) {
      this.log.error("approval.owner_missing", { approvalId });
      return;
    }
    await this.deliver(
      { type: "approval_card", owner, approvalId, summary, idempotencyKey: newId() },
      [{ kind: "dm", id: owner.ref }],
      session.sessionId,
    );
  }

  private async onApprovalDecision(approvalId: string, actor: Actor, decision: "approve" | "deny"): Promise<void> {
    const trust = resolveTrust(actor, undefined, this.config);
    if (trust !== "owner" && actor.stableId !== this.config.owner) return;
    const approval = this.stateStore.get().approvals[approvalId];
    if (!approval || approval.status !== "pending") return;
    const session = this.stateStore.get().sessions[approval.sessionId];
    if (!session?.runtimeRef) return;
    await this.stateStore.update((draft) => {
      const current = draft.approvals[approvalId];
      if (!current || current.status !== "pending") return;
      current.status = decision === "approve" ? "approved" : "denied";
      current.decidedBy = actor.stableId;
      current.decidedAt = this.iso();
      const owner = draft.sessions[approval.sessionId];
      if (owner) owner.pendingApprovalIds = owner.pendingApprovalIds.filter((id) => id !== approvalId);
      if (owner && owner.pendingApprovalIds.length === 0 && owner.phase === "awaiting_approval") owner.phase = "running";
    });
    await this.append(approval.sessionId, { type: "approval", approvalId, kind: approval.kind, summary: approval.summary, decision, turnId: approval.turnId });
    await this.runtimeFor(session).resolveApproval(session.runtimeRef, approvalId, decision);
    await this.lock.run(session.sessionId, async () => {
      const current = this.must(session.sessionId);
      if (current.phase !== "running" || !this.capabilities(current).steer) return;
      while (current.queue.length && current.phase === "running") {
        const item = current.queue[0];
        current.queue.shift();
        try {
          await this.doSteer(session.sessionId, item);
        } catch (error) {
          if (!isSteerRejected(error)) throw error;
          current.queue.unshift(item);
          break;
        }
      }
      await this.stateStore.update((draft) => {
        const live = draft.sessions[session.sessionId];
        if (live) live.queue = current.queue;
      });
    });
  }

  private async interrupt(sessionId: string, reason: NonNullable<ActiveTurn["interruptReason"]>): Promise<void> {
    const session = this.stateStore.get().sessions[sessionId];
    if (!session?.activeTurn || !session.runtimeRef) return;
    await this.stateStore.update((draft) => {
      const turn = draft.sessions[sessionId]?.activeTurn;
      if (!turn) return;
      turn.interruptReason = reason;
      turn.suppressOutbound = true;
    });
    await this.runtimeFor(session).interrupt(session.runtimeRef);
  }

  private async onRuntimeLost(runtimeName: string, sessionIds: string[]): Promise<void> {
    const now = this.clock.now();
    const recent = (this.losses.get(runtimeName) ?? []).filter((at) => now - at <= 60_000);
    recent.push(now);
    this.losses.set(runtimeName, recent);
    if (recent.length >= 3 && !this.disabled.has(runtimeName)) {
      this.disabled.add(runtimeName);
      await this.notifyOwner(`运行时 ${runtimeName} 在 60 秒内断开 3 次，已停用。`, `runtime-disabled:${runtimeName}:${now}`);
    }
    for (const sessionId of sessionIds) {
      const session = this.stateStore.get().sessions[sessionId];
      if (!session) continue;
      await this.stateStore.update((draft) => {
        const current = draft.sessions[sessionId];
        if (!current) return;
        current.live = false;
        if (current.activeTurn) {
          current.activeTurn.interruptReason = "lost";
          current.activeTurn.suppressOutbound = true;
        }
      });
      if (session.activeTurn) await this.finishTurn(sessionId, { kind: "interrupted", turnId: session.activeTurn.turnId, reason: "lost" });
    }
  }

  private async watchdog(now: number): Promise<void> {
    for (const session of Object.values(this.stateStore.get().sessions)) {
      if (session.kind !== "conversation" || session.phase !== "running" || !session.activeTurn) continue;
      const idle = now - Date.parse(session.activeTurn.lastActivityAt);
      if (idle >= this.config.session.turnIdleTimeoutMs) await this.interrupt(session.sessionId, "watchdog");
    }
  }

  private async taskTimeouts(now: number): Promise<void> {
    for (const task of Object.values(this.stateStore.get().tasks)) {
      if (task.status !== "running" || !task.sessionId) continue;
      const session = this.stateStore.get().sessions[task.sessionId];
      if (!session?.activeTurn || session.phase !== "running") continue;
      const idle = now - Date.parse(session.activeTurn.lastActivityAt);
      if (idle >= this.config.tasks.taskIdleTimeoutMs) await this.interrupt(session.sessionId, "timeout");
    }
  }

  private async releaseIdle(now: number): Promise<void> {
    for (const session of Object.values(this.stateStore.get().sessions)) {
      if (!this.idleReleaseDue(session, now)) continue;
      // The session lock is held across resume and turn/start. Re-check inside it so a
      // tick cannot unsubscribe a thread that is being brought back.
      await this.lock.run(session.sessionId, async () => {
        const current = this.stateStore.get().sessions[session.sessionId];
        if (!current?.live || current.phase !== "idle" || current.queue.length) return;
        if (!this.idleReleaseDue(current, now)) return;
        await this.releaseSession(current.sessionId);
      });
    }
  }

  private idleReleaseDue(session: SessionRecord, now: number): boolean {
    if (session.kind !== "conversation" || !session.live || session.phase !== "idle" || session.queue.length) return false;
    const limits = runtimeLimits(this.config, session.runtimeName);
    const idleSince = Date.parse(session.idleSince ?? session.updatedAt);
    return now - idleSince >= limits.idleReleaseMs;
  }

  private async scanHeartbeat(now: number): Promise<void> {
    if (this.checksRunning >= this.config.limits.maxConcurrentChecks) return;
    for (const task of Object.values(this.stateStore.get().tasks)) {
      if (this.checksRunning >= this.config.limits.maxConcurrentChecks) return;
      const parent = this.stateStore.get().sessions[task.parentSessionId];
      if (!heartbeatDue(task, parent, now, this.config.tasks.heartbeat.intervalMs)) continue;
      await this.runCheck(task.taskId);
    }
  }

  private async runCheck(taskId: string): Promise<void> {
    const task = this.stateStore.get().tasks[taskId];
    if (!task) return;
    const version = task.version;
    const status = task.status;
    this.checksRunning += 1;
    try {
      const text = await this.runOneShot("check", checkContext(task), [task.body]);
      const verdict = parseCheckReply(text);
      let wake = false;
      await this.stateStore.update((draft) => {
        const current = draft.tasks[taskId];
        if (!current) return;
        const discarded = current.version !== version || current.status === "cancelled" || current.status === "cancelling" || current.status !== status;
        current.lastCheck = { at: this.iso(), progress: discarded ? "discarded" : text };
        if (!discarded && verdict === "wake" && !current.pendingEvent) {
          current.pendingEvent = { reason: "check", text, at: this.iso() };
          wake = true;
        }
        current.updatedAt = this.iso();
      });
      if (wake) await this.deliverPending(taskId);
    } catch (error) {
      this.log.warn("check.failed", { taskId, error: String(error) });
    } finally {
      this.checksRunning -= 1;
    }
  }

  private async pumpJudges(): Promise<void> {
    while (this.judgeWait.length && this.judgesRunning < this.config.limits.maxConcurrentJudges) {
      const batch = this.judgeWait.shift();
      if (!batch) return;
      this.judgesRunning += 1;
      void this.runJudge(batch)
        .catch((error) => this.log.warn("judge.failed", { error: String(error) }))
        .finally(() => {
          this.judgesRunning -= 1;
          void this.pumpJudges();
        });
    }
  }

  private async runJudge(batch: { scope: Scope; messages: MessageEvent[] }): Promise<void> {
    const history = await this.safeHistory(batch.scope, this.config.im.gate.judgeContext, new Date(this.clock.now() - this.config.im.window.maxAgeMs).toISOString());
    const candidateIds = new Set(batch.messages.map((message) => message.messageId));
    // Platform history already includes the messages being judged. recent is only
    // what came before them; the oldest history row is the topic root when we have one.
    const earlier = history.filter((record) => !candidateIds.has(record.messageId));
    const root = batch.scope.kind === "topic" ? history[0] : undefined;
    const candidates = batch.messages.map((message) => this.turnMessage(this.recordFromMessage(message)));
    let text: string;
    try {
      text = await this.runOneShot(
        "judge",
        judgeContext({
          you: this.youProfile(),
          recent: earlier.map((record) => this.turnMessage(record)),
          candidates,
          root: root ? this.turnMessage(root) : undefined,
        }),
        batch.messages.map((message) => message.text),
      );
    } catch (error) {
      logGateDecision(this.log, {
        scope: batch.scope,
        messages: batch.messages,
        decision: "skip",
        reason: "judge_failed",
        mode: this.gate.modeFor(batch.scope),
        source: "judge",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const judged = parseJudgeReply(text);
    logGateDecision(this.log, {
      scope: batch.scope,
      messages: batch.messages,
      decision: judged.verdict === "respond" ? "allow" : "skip",
      reason: judged.reason,
      mode: this.gate.modeFor(batch.scope),
      source: "judge",
    });
    if (judged.verdict === "respond") await this.deliverMessages(batch.scope, batch.messages);
  }

  private logGateShortCircuit(event: MessageEvent, decision: "allow" | "skip", reason: string): void {
    logGateDecision(this.log, {
      scope: event.scope,
      messages: [event],
      decision,
      reason,
      mode: this.gate.modeFor(event.scope),
      source: "short_circuit",
    });
  }

  private async maybeCompact(sessionId: string): Promise<void> {
    const session = this.stateStore.get().sessions[sessionId];
    if (!session || session.kind !== "conversation" || session.phase !== "idle") return;
    const entries = await this.transcripts.load(sessionId);
    if (transcriptTokens(entries) < this.config.sessions.compactAfterTokens) return;
    const active = entries.filter((entry) => entry.type !== "compacted");
    const midpoint = active[Math.floor(active.length / 2)];
    if (!midpoint) return;
    const summary = await this.runOneShot("compact", active.slice(0, Math.ceil(active.length / 2)).map((entry) => JSON.stringify(entry)).join("\n"), ["Summarize the earlier transcript."]);
    await this.append(sessionId, { type: "compacted", throughSeq: midpoint.seq, summary });
  }

  private async runOneShot(kind: "check" | "judge" | "compact", context: string, messages: string[]): Promise<string> {
    const sessionId = `${kind}:${newId()}`;
    const token = newId();
    const promise = new Promise<string>((resolve, reject) => {
      this.waiters.set(sessionId, { resolve, reject });
    });
    await this.stateStore.update((draft) => {
      draft.sessions[sessionId] = blankSession({
        sessionId,
        kind,
        runtimeName: this.config.agents.front.runtime,
        token,
        createdAt: this.iso(),
      });
      draft.tokens[token] = { token, sessionId, role: "session" };
    });
    await this.lock.run(sessionId, async () => {
      const session = this.must(sessionId);
      await this.ensureRuntime(session);
      const turnId = newId();
      const input: TurnInput = {
        turnId,
        context,
        // Judge candidates already live in the Turn input JSON. inContext stops Codex and pi
        // from appending that raw text after the JSON.
        messages: messages.map((text) => ({ text, ...(kind === "judge" ? { inContext: true } : {}) })),
      };
      const now = this.iso();
      await this.stateStore.update((draft) => {
        const current = draft.sessions[sessionId];
        current.phase = "running";
        current.activeTurn = {
          turnId,
          trigger: "message",
          messageIds: [],
          recalledMessageIds: [],
          suppressOutbound: true,
          retries: 0,
          startedAt: now,
          lastActivityAt: now,
          input,
        };
      });
      await this.runtimeFor(this.must(sessionId)).start(this.must(sessionId).runtimeRef as string, input);
    });
    return promise;
  }

  private async ensureRuntime(session: SessionRecord): Promise<{ seedMs: number; openMs: number }> {
    const runtime = this.runtimeFor(session);
    if (this.disabled.has(runtime.name)) throw new Error(`runtime ${runtime.name} is disabled`);
    if (session.live && session.runtimeRef) return { seedMs: 0, openMs: 0 };
    await this.evict(runtime, session.sessionId);
    const instructions = this.instructionsFor(session.kind);
    const hash = sha256(instructions);
    const profile = this.profileFor(session.kind);
    let seedMs = 0;
    let openMs = 0;
    const openNew = async (seedText?: Awaited<ReturnType<typeof buildSeed>>) => {
      const openStarted = Date.now();
      const ref = await runtime.open({
        sessionId: session.sessionId,
        kind: session.kind,
        seed: seedText && seedText.text ? seedText : undefined,
        profile,
        instructions,
        toolEnv: this.toolEnvFor(session),
      });
      openMs += Date.now() - openStarted;
      const now = this.iso();
      await this.stateStore.update((draft) => {
        const current = draft.sessions[session.sessionId];
        current.runtimeRef = ref;
        current.instructionsHash = hash;
        current.runtimeName = session.runtimeName;
        current.live = true;
        current.idleSince = now;
        current.lastUsedAt = now;
      });
    };
    if (session.runtimeRef && session.instructionsHash && session.instructionsHash !== hash) {
      const updated = await runtime.updateInstructions(session.runtimeRef, instructions);
      if (updated === "unsupported") {
        await runtime.release(session.runtimeRef).catch(() => undefined);
        const seedStarted = Date.now();
        const seed = await this.seedFor(session.sessionId);
        seedMs += Date.now() - seedStarted;
        await this.stateStore.update((draft) => {
          draft.sessions[session.sessionId].runtimeRef = undefined;
        });
        session.runtimeRef = undefined;
        await openNew(seed);
        return { seedMs, openMs };
      }
      await this.stateStore.update((draft) => {
        draft.sessions[session.sessionId].instructionsHash = hash;
      });
    }
    if (session.runtimeRef) {
      try {
        const openStarted = Date.now();
        const ref = await runtime.open({
          sessionId: session.sessionId,
          kind: session.kind,
          runtimeRef: session.runtimeRef,
          profile,
          instructions,
          toolEnv: this.toolEnvFor(session),
        });
        openMs += Date.now() - openStarted;
        const now = this.iso();
        await this.stateStore.update((draft) => {
          const current = draft.sessions[session.sessionId];
          current.runtimeRef = ref;
          current.instructionsHash = hash;
          current.live = true;
          current.idleSince = now;
          current.lastUsedAt = now;
        });
        return { seedMs, openMs };
      } catch {
        const seedStarted = Date.now();
        const seed = await this.seedFor(session.sessionId);
        seedMs += Date.now() - seedStarted;
        await this.stateStore.update((draft) => {
          draft.sessions[session.sessionId].runtimeRef = undefined;
        });
        session.runtimeRef = undefined;
        await openNew(seed);
        return { seedMs, openMs };
      }
    }
    const seedStarted = Date.now();
    const seed = session.lastSeq > 0 ? await this.seedFor(session.sessionId) : undefined;
    seedMs += Date.now() - seedStarted;
    await openNew(seed);
    return { seedMs, openMs };
  }

  private async evict(runtime: RuntimeAdapter, keepId: string): Promise<void> {
    const max = runtimeLimits(this.config, runtime.name).maxLiveSessions;
    const live = Object.values(this.stateStore.get().sessions).filter((session) => session.live && session.runtimeName === runtime.name && session.sessionId !== keepId);
    if (live.length < max) return;
    const idle = live.filter((session) => session.phase === "idle").sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""));
    if (!idle[0]) return;
    await this.releaseSession(idle[0].sessionId);
  }

  private async releaseSession(sessionId: string): Promise<void> {
    const session = this.stateStore.get().sessions[sessionId];
    if (!session?.runtimeRef || !session.live) return;
    await this.runtimeFor(session).release(session.runtimeRef).catch(() => undefined);
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      if (current) current.live = false;
    });
  }

  private async buildTurn(sessionId: string, batch: QueuedInput[], runtimeOpened = false): Promise<{ input: TurnInput; historyMs: number }> {
    const session = this.must(sessionId);
    const token = session.token;
    if (session.kind === "task") {
      const task = session.taskId ? this.stateStore.get().tasks[session.taskId] : undefined;
      const prompt = batch.map((item) => (item.kind === "prompt" ? item.text : "")).filter(Boolean).join("\n") || task?.body || "";
      return {
        input: {
          turnId: "",
          context: taskContext({
            body: task?.body || prompt,
            apiUrl: this.apiUrl,
            token,
            parentContainer: session.imContainer,
            cli: this.cli,
            taskId: task?.taskId ?? session.taskId,
            version: task?.version,
            backTaskTools: this.usesAgentTools(session),
            you: this.youProfile(),
          }),
          messages: [{ text: prompt }],
        },
        historyMs: 0,
      };
    }
    const scope = session.scope;
    const messages = batch.filter((item): item is Extract<QueuedInput, { kind: "message" }> => item.kind === "message");
    const records = messages.map((message) => this.recordFromQueued(message, scope));
    const triggerIds = new Set(records.map((record) => record.messageId));
    const runtimeRef = session.runtimeRef ?? "";
    let mark = this.historyMarks.get(sessionId);
    // Cold when the live runtime was (re)opened for this turn or the ref changed (reseed).
    const cold = runtimeOpened || !mark || mark.runtimeRef !== runtimeRef || mark.highMs <= 0;
    if (cold || !mark) {
      mark = { runtimeRef, highMs: 0, seen: new Set<string>() };
      this.historyMarks.set(sessionId, mark);
    }
    const sinceMs = mark.highMs;
    let history: ImRecord[] = [];
    let historyMs = 0;
    if (scope && (scope.kind === "dm" || this.channel.capabilities.readGroupMessages)) {
      const historyStarted = Date.now();
      if (cold) {
        const limit = scope.kind === "topic" ? this.config.im.window.topic : this.config.im.window.group;
        const fetched = await this.safeHistory(scope, limit, new Date(this.clock.now() - this.config.im.window.maxAgeMs).toISOString());
        history = selectWindow(
          fetched.filter((item) => !triggerIds.has(item.messageId)),
          { limit, maxTokens: this.config.im.window.maxTokens, maxAgeMs: this.config.im.window.maxAgeMs, now: this.clock.now() },
        );
      } else {
        const fetched = await this.safeHistory(scope, INCREMENTAL_LIMIT, new Date(sinceMs).toISOString());
        history = newSince(fetched, mark)
          .filter((item) => !triggerIds.has(item.messageId))
          .sort((x, y) => x.occurredAt.localeCompare(y.occurredAt) || x.messageId.localeCompare(y.messageId));
      }
      historyMs = Date.now() - historyStarted;
    }
    advanceMark(mark, [...history, ...records]);
    for (const record of [...history, ...records]) this.noteVisible(sessionId, record);
    const tasks = Object.values(this.stateStore.get().tasks).filter((task) => task.parentSessionId === sessionId);
    const structured: StructuredTurn | undefined = scope
      ? {
          turn: { kind: session.kind, cold, scope: { kind: scope.kind, id: scope.id } },
          history: cold
            ? {
                mode: "full",
                range: history.length ? { from: localIso(history[0].occurredAt, this.config.timezone), to: localIso(history[history.length - 1].occurredAt, this.config.timezone) } : null,
                messages: history.map((record) => this.turnMessage(record)),
              }
            : { mode: "incremental", since: localIso(sinceMs, this.config.timezone), newCount: history.length, messages: history.map((record) => this.turnMessage(record)) },
          trigger: records.map((record) => this.turnMessage(record)),
        }
      : undefined;
    if (structured) this.log.info("turn.input", { sessionId, cold, mode: structured.history.mode, historyCount: history.length, triggerCount: records.length });
    const context = scope
      ? conversationContext({
          scope,
          now: this.iso(),
          turnJson: structured ? JSON.stringify(structured, null, 2) : undefined,
          batch,
          tasks,
          apiUrl: this.apiUrl,
          token,
          sessionId,
          cli: this.cli,
          frontTaskTools: this.usesAgentTools(session),
          you: this.youProfile(),
        })
      : "";
    const windowIds = scope ? records.map((record) => record.messageId) : [];
    const renderedIds = new Set(windowIds);
    const inputMessages: InputMessage[] = [];
    for (const item of batch) {
      if (item.kind === "message") {
        const images = session.kind === "conversation" ? await this.downloadImages(item.attachments) : [];
        inputMessages.push({
          text: item.text,
          messageId: item.messageId,
          images: images.length ? images : undefined,
          inContext: renderedIds.has(item.messageId) || undefined,
        });
      } else if (item.kind === "task_event") inputMessages.push({ text: item.text });
      else inputMessages.push({ text: item.text });
    }
    return { input: { turnId: "", context, messages: inputMessages }, historyMs };
  }

  private async downloadImages(attachments: AttachmentRef[]): Promise<{ path: string; name?: string }[]> {
    const images = [];
    for (const attachment of attachments) {
      if (attachment.kind !== "image") continue;
      try {
        images.push({ path: await this.channel.download(attachment), name: attachment.name });
      } catch (error) {
        this.log.warn("image.download_failed", { key: attachment.key, error: String(error) });
      }
    }
    return images;
  }

  /** Platform history only. Retries twice with backoff, then degrades to empty. */
  private async safeHistory(scope: Scope, limit: number, start: string): Promise<ImRecord[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.channel.history({ container: scope.id, limit, start, withRoot: scope.kind === "topic" });
      } catch (error) {
        if (attempt >= HISTORY_RETRIES) {
          this.log.warn("history.failed", { container: scope.id, attempts: attempt + 1, error: String(error) });
          return [];
        }
        await new Promise((done) => setTimeout(done, HISTORY_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  private async deliverPending(taskId: string): Promise<void> {
    const task = this.stateStore.get().tasks[taskId];
    if (!task?.pendingEvent) return;
    const event = task.pendingEvent;
    const parent = this.stateStore.get().sessions[task.parentSessionId];
    if (!parent) return;
    await this.enqueue(parent.sessionId, [{ kind: "task_event", taskId, reason: event.reason, text: event.text, at: event.at }]);
    await this.stateStore.update((draft) => {
      const current = draft.tasks[taskId];
      if (current?.pendingEvent?.at === event.at) current.pendingEvent = undefined;
    });
  }

  private async redeliverPending(): Promise<void> {
    for (const task of Object.values(this.stateStore.get().tasks)) {
      if (task.pendingEvent) await this.deliverPending(task.taskId);
    }
  }

  private async pumpTasks(): Promise<void> {
    const queued = Object.values(this.stateStore.get().tasks).filter((task) => task.status === "queued");
    for (const task of queued) {
      const running = Object.values(this.stateStore.get().tasks).filter((item) => item.status === "running" || item.status === "cancelling").length;
      if (running >= this.config.limits.maxConcurrentTasks) return;
      await this.startTaskSession(task.taskId, task.body);
    }
  }

  private async startTaskSession(taskId: string, prompt: string): Promise<void> {
    const task = this.stateStore.get().tasks[taskId];
    if (!task || task.status === "cancelled" || task.status === "cancelling") return;
    const sessionId = task.sessionId ?? taskSessionId(taskId);
    const parent = this.stateStore.get().sessions[task.parentSessionId];
    await this.stateStore.update((draft) => {
      const current = draft.tasks[taskId];
      if (!current) return;
      current.status = "running";
      current.sessionId = sessionId;
      current.updatedAt = this.iso();
      if (!draft.sessions[sessionId]) {
        const token = newId();
        draft.sessions[sessionId] = blankSession({
          sessionId,
          kind: "task",
          runtimeName: this.config.agents.back.runtime,
          token,
          parentSessionId: task.parentSessionId,
          taskId,
          imContainer: parent?.scope?.id,
          createdAt: this.iso(),
        });
        draft.tokens[token] = { token, sessionId, role: "task" };
      }
    });
    await this.enqueue(sessionId, [{ kind: "prompt", text: prompt }]);
  }

  /**
   * Opt-in only. `[[notify <taskId>]]` selects a task this conversation owns.
   * The @ list is that task's audience. Nothing is added from the turn.
   */
  private notifyingText(session: SessionRecord, reply: { text: string; notifyTaskId?: string }): string {
    const scope = session.scope;
    if (!scope) return neutralizeUntrustedMentions(reply.text);
    const taskId = reply.notifyTaskId;
    let audience: TaskRecord["audience"];
    if (taskId) {
      const task = this.stateStore.get().tasks[taskId];
      if (task?.parentSessionId === session.sessionId) audience = task.audience;
      else this.log.warn("notify.skipped", { taskId, sessionId: session.sessionId, reason: task ? "wrong-session" : "missing" });
    }
    return renderNotifyingReply({
      text: reply.text,
      scopeKind: scope.kind,
      audience,
      skipOpenIds: [this.bot.ref],
    });
  }

  async taskStart(token: string, body: TaskStartBody): Promise<TaskRecord> {
    if (!this.config.tasks.enabled) throw new ApiError("FORBIDDEN", "tasks are disabled", 403);
    const auth = this.authorize(token);
    if (auth.role !== "session") throw new ApiError("FORBIDDEN", "only a front conversation can start a task", 403);
    const parent = this.must(auth.sessionId);
    if (parent.kind !== "conversation") throw new ApiError("FORBIDDEN", "only a front conversation can start a task", 403);
    if (!body.body?.trim()) throw new ApiError("BAD_REQUEST", "body is required");
    const taskId = newId();
    const now = this.iso();
    const stableId = parent.activeTurn?.sourceStableId ?? "";
    const source = {
      messageId: parent.activeTurn?.messageIds[0] ?? "",
      personId: stableId ? this.persons.byStableId(stableId)?.personId ?? stableId : "",
      turnId: parent.activeTurn?.turnId ?? "",
    };
    const created = await this.stateStore.update((draft) => {
      if (slotsUsed(draft.tasks) >= this.config.limits.maxConcurrentTasks) {
        throw new ApiError("CAPACITY_EXHAUSTED", "task slots are full", 409);
      }
      const task: TaskRecord = {
        taskId,
        parentSessionId: parent.sessionId,
        source,
        body: body.body,
        audience: body.audience === undefined ? emptyAudience() : applyAudience(emptyAudience(), readAudience(body.audience)),
        followUpEnabled: body.followUpEnabled ?? false,
        version: 1,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      draft.tasks[taskId] = task;
      return task;
    });
    await this.pumpTasks();
    return presentTask(this.stateStore.get().tasks[created.taskId] ?? created);
  }

  async taskContinue(token: string, body: { taskId: string; message: string }): Promise<TaskRecord> {
    const task = this.requireTask(token, body.taskId, true);
    if (!body.message?.trim()) throw new ApiError("BAD_REQUEST", "message is required");
    if (task.status === "cancelled" || task.status === "cancelling") throw new ApiError("FORBIDDEN", "task is cancelled", 403);
    if (task.status === "running") {
      if (!task.sessionId) throw new ApiError("NOT_FOUND", "task session is missing", 404);
      await this.enqueue(task.sessionId, [{ kind: "prompt", text: body.message }]);
      return presentTask(this.stateStore.get().tasks[task.taskId]);
    }
    if (task.status !== "ended" && task.status !== "queued") throw new ApiError("FORBIDDEN", `cannot continue a ${task.status} task`, 403);
    await this.stateStore.update((draft) => {
      const current = draft.tasks[task.taskId];
      if (!current) throw new ApiError("NOT_FOUND", "task not found", 404);
      if (current.status !== "running" && slotsUsed(draft.tasks) >= this.config.limits.maxConcurrentTasks) {
        throw new ApiError("CAPACITY_EXHAUSTED", "task slots are full", 409);
      }
      current.status = "queued";
      current.updatedAt = this.iso();
    });
    await this.startTaskSession(task.taskId, body.message);
    return presentTask(this.stateStore.get().tasks[task.taskId]);
  }

  async taskUpdate(token: string, body: TaskUpdateBody): Promise<TaskRecord> {
    this.requireTask(token, body.taskId, true);
    const hasBody = Object.hasOwn(body, "body");
    const hasFollow = Object.hasOwn(body, "followUpEnabled");
    const hasAudience = Object.hasOwn(body, "audience");
    if (!hasBody && !hasFollow && !hasAudience) throw new ApiError("BAD_REQUEST", "nothing to update");
    if (hasBody && typeof body.body !== "string") throw new ApiError("BAD_REQUEST", "body must be a string");
    if (hasFollow && typeof body.followUpEnabled !== "boolean") throw new ApiError("BAD_REQUEST", "followUpEnabled must be a boolean");
    const audiencePatch = hasAudience ? readAudience(body.audience) : undefined;
    return presentTask(
      await this.stateStore.update((draft) => {
        const task = draft.tasks[body.taskId];
        if (!task) throw new ApiError("NOT_FOUND", "task not found", 404);
        if (task.version !== body.version) throw new ApiError("VERSION_CONFLICT", "task version conflict", 409);
        if (hasBody) task.body = body.body ?? "";
        if (hasFollow) task.followUpEnabled = body.followUpEnabled ?? false;
        if (audiencePatch) task.audience = applyAudience(task.audience, audiencePatch);
        task.version += 1;
        task.updatedAt = this.iso();
        return task;
      }),
    );
  }

  async taskGet(token: string, taskId: string): Promise<unknown> {
    const task = this.requireTask(token, taskId, false);
    return {
      taskId: task.taskId,
      body: task.body,
      audience: storedAudience(task.audience),
      status: task.status,
      version: task.version,
      followUpEnabled: task.followUpEnabled,
      lastCheck: task.lastCheck,
      activity: task.activity,
      lastResult: task.lastResult,
      pendingEvent: task.pendingEvent,
      updatedAt: task.updatedAt,
    };
  }

  async taskList(token: string): Promise<unknown> {
    const auth = this.authorize(token);
    const tasks = Object.values(this.stateStore.get().tasks).filter((task) => {
      if (auth.role === "owner") return true;
      if (auth.role === "session") return task.parentSessionId === auth.sessionId;
      return task.sessionId === auth.sessionId;
    });
    return tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      version: task.version,
      followUpEnabled: task.followUpEnabled,
      body: task.body,
      audience: storedAudience(task.audience),
    }));
  }

  async taskCancel(token: string, taskId: string): Promise<TaskRecord> {
    const task = this.requireTask(token, taskId, true);
    if (this.authorize(token).role === "task") throw new ApiError("FORBIDDEN", "a task session cannot cancel itself", 403);
    const wasRunning = task.status === "running";
    await this.stateStore.update((draft) => {
      const current = draft.tasks[taskId];
      if (!current) return;
      current.followUpEnabled = false;
      current.pendingEvent = undefined;
      current.updatedAt = this.iso();
      if (current.status === "running") current.status = "cancelling";
      else current.status = "cancelled";
      if (current.sessionId && draft.sessions[current.sessionId]) draft.sessions[current.sessionId].queue = [];
    });
    if (wasRunning && task.sessionId) await this.interrupt(task.sessionId, "cancel");
    return presentTask(this.stateStore.get().tasks[taskId]);
  }

  async imHistory(token: string, body: { container: string; start?: string; end?: string; limit?: number }): Promise<unknown> {
    const auth = this.authorize(token);
    this.assertContainer(auth, body.container);
    const limit = body.limit ?? 50;
    const stored = (await this.imlog.load(body.container)).filter((item) => inRange(item.occurredAt, body.start, body.end));
    let records: ImRecord[] = stored;
    if (stored.length < limit) {
      const remote = await this.channel.history({ container: body.container, start: body.start, end: body.end, limit });
      const merged = new Map<string, ImRecord>();
      for (const item of remote) merged.set(item.messageId, item);
      for (const item of stored) merged.set(item.messageId, item);
      records = [...merged.values()];
    }
    records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return records.slice(-limit).map((record) => {
      const message = this.turnMessage(record);
      return record.attachments.length ? { ...message, attachments: record.attachments } : message;
    });
  }

  async imFile(token: string, body: { messageId: string; key: string }): Promise<unknown> {
    const auth = this.authorize(token);
    const container = this.containerFor(auth);
    const stored = container ? await this.imlog.load(container) : [];
    const known = stored.some((item) => item.messageId === body.messageId) || this.visibleMessages.get(auth.sessionId)?.has(body.messageId);
    if (!known && auth.role !== "owner") throw new ApiError("FORBIDDEN", "message is outside this session", 403);
    const attachment = this.lookupAttachment(body.messageId, body.key);
    try {
      const path = await this.channel.download(attachment);
      const targetDir = join(this.config.stateDir, "files");
      await mkdir(targetDir, { recursive: true });
      if (path.startsWith(targetDir)) return { path };
      const target = join(targetDir, `${body.messageId}-${attachment.key}`.replace(/[^a-zA-Z0-9._-]+/g, "_"));
      await copyFile(path, target);
      return { path: target };
    } catch (error) {
      throw new ApiError("DOWNLOAD_FAILED", error instanceof Error ? error.message : String(error), 400);
    }
  }

  async personLookup(token: string, body: { openId?: string; query?: string; scope?: "current" | "all" }): Promise<unknown> {
    const auth = this.authorizeBack(token);
    if (!body.openId && !body.query?.trim()) throw new ApiError("BAD_REQUEST", "pass openId or query");
    if (body.scope && body.scope !== "current" && body.scope !== "all") throw new ApiError("BAD_REQUEST", "scope must be current or all");
    return this.directory.lookupPerson({ openId: body.openId, query: body.query, scope: body.scope, currentGroup: this.groupFor(auth) });
  }

  async groupLookup(token: string, body: { chatId?: string; query?: string; includeMembers?: boolean }): Promise<unknown> {
    this.authorizeBack(token);
    if (!body.chatId && !body.query?.trim()) throw new ApiError("BAD_REQUEST", "pass chatId or query");
    return this.directory.lookupGroup({ chatId: body.chatId, query: body.query, includeMembers: body.includeMembers === true });
  }

  /** Directory lookups belong to background work; front sessions do not get them. */
  private authorizeBack(token: string): TokenRecord {
    const auth = this.authorize(token);
    if (auth.role === "session") throw new ApiError("FORBIDDEN", "lookups are for background work", 403);
    return auth;
  }

  private groupFor(auth: TokenRecord): string | undefined {
    const session = this.stateStore.get().sessions[auth.sessionId];
    return [session?.scope?.parentId, session?.scope?.id, session?.imContainer].find((id): id is string => Boolean(id?.startsWith("oc_")));
  }

  /** Passive cache upkeep from inbound messages and mentions. Never blocks on errors. */
  private async observeDirectory(event: MessageEvent): Promise<void> {
    const chatId = event.scope.kind === "topic" ? event.scope.parentId : event.scope.kind === "group" ? event.scope.id : undefined;
    try {
      if (chatId) void this.directory.touchGroup(chatId).catch(() => undefined);
      if (event.actor.ref !== this.bot.ref && event.actor.name) await this.directory.observePerson(event.actor.ref, event.actor.name, chatId);
      for (const mention of event.mentions ?? []) {
        if (mention.ref !== this.bot.ref) await this.directory.observePerson(mention.ref, mention.name, chatId);
      }
    } catch (error) {
      this.log.warn("directory.observe_failed", { error: String(error) });
    }
  }

  private authorize(token: string): TokenRecord {
    const record = this.stateStore.get().tokens[token];
    if (!record) throw new ApiError("UNAUTHORIZED", "unknown token", 401);
    return record;
  }

  private requireTask(token: string, taskId: string, write: boolean): TaskRecord {
    const auth = this.authorize(token);
    const task = this.stateStore.get().tasks[taskId];
    if (!task) throw new ApiError("NOT_FOUND", "task not found", 404);
    if (auth.role === "owner") return task;
    if (auth.role === "session" && auth.sessionId === task.parentSessionId) return task;
    if (auth.role === "task" && auth.sessionId === task.sessionId) {
      if (write && task.sessionId === auth.sessionId) return task;
      if (!write) return task;
    }
    throw new ApiError("FORBIDDEN", "task is outside this session", 403);
  }

  private assertContainer(auth: TokenRecord, container: string): void {
    if (auth.role === "owner") return;
    const session = this.stateStore.get().sessions[auth.sessionId];
    const allowed = new Set([session?.scope?.id, session?.scope?.parentId, session?.imContainer].filter(Boolean));
    if (!allowed.has(container)) throw new ApiError("FORBIDDEN", "container is outside this session", 403);
  }

  private containerFor(auth: TokenRecord): string | undefined {
    const session = this.stateStore.get().sessions[auth.sessionId];
    return session?.imContainer ?? session?.scope?.id;
  }

  private lookupAttachment(messageId: string, key: string): AttachmentRef {
    const list = this.attachments.get(messageId) ?? [];
    const marker = /^att:(\d+)$/.exec(key);
    if (marker) {
      const found = list[Number(marker[1]) - 1];
      if (!found) throw new ApiError("NOT_FOUND", `${key} was not found on ${messageId}`, 404);
      return found;
    }
    return list.find((item) => item.key === key) ?? { kind: "file", messageId, key };
  }

  private async ensureConversation(scope: Scope): Promise<string> {
    const sessionId = conversationSessionId(scope);
    await this.stateStore.update((draft) => {
      const existing = draft.sessions[sessionId];
      if (existing) {
        existing.scope = scope;
        return;
      }
      const token = newId();
      draft.sessions[sessionId] = blankSession({
        sessionId,
        kind: "conversation",
        scope,
        runtimeName: this.config.agents.front.runtime,
        token,
        imContainer: scope.id,
        createdAt: this.iso(),
      });
      draft.tokens[token] = { token, sessionId, role: "session" };
    });
    return sessionId;
  }

  private async deliver(action: OutboundAction, allowed: Array<{ kind: string; id: string }>, sessionId: string): Promise<void> {
    const target = action.type === "text" ? { kind: action.scope.kind, id: action.scope.id } : { kind: "dm", id: action.owner.ref };
    if (!allowed.some((item) => item.kind === target.kind && item.id === target.id)) {
      this.log.warn("outbound.rejected", { sessionId, target });
      return;
    }
    const cached = this.stateStore.get().outbound[action.idempotencyKey];
    if (cached?.result.ok) return;
    const result = await this.channel.send(action);
    await this.stateStore.update((draft) => {
      if (result.ok) draft.outbound[action.idempotencyKey] = { idempotencyKey: action.idempotencyKey, result, at: this.iso() };
    });
    if (result.ok && result.messageId && action.type === "text") {
      const stored: StoredMessage = {
        messageId: result.messageId,
        scope: action.scope,
        container: action.scope.id,
        actor: { channel: this.channel.channel, ref: this.bot.ref, stableId: this.bot.stableId, name: this.bot.name, isBot: true },
        text: action.text,
        attachments: [],
        mentionsSelf: false,
        occurredAt: this.iso(),
        fromBot: true,
        disposition: "normal",
      };
      await this.imlog.append(stored);
      if (action.scope.kind === "topic") {
        await this.stateStore.update((draft) => {
          if (!draft.participatedTopics.includes(action.scope.id)) draft.participatedTopics.push(action.scope.id);
        });
      }
    }
  }

  private async notifyOwner(text: string, key: string): Promise<void> {
    const owner = this.ownerActor();
    if (!owner) return;
    const scope: Scope = { channel: this.channel.channel, kind: "dm", id: owner.ref };
    await this.deliver({ type: "text", scope, text, idempotencyKey: key }, [scope], "owner");
  }

  private ownerActor(): Actor | undefined {
    const person = this.persons.byStableId(this.config.owner);
    const ref = person?.refs[0];
    if (!ref) return undefined;
    return { channel: this.channel.channel, ref, stableId: this.config.owner, name: person.names[0] ?? "owner", isBot: false };
  }

  private async append(sessionId: string, entry: TranscriptWrite): Promise<void> {
    const session = this.stateStore.get().sessions[sessionId];
    if (!session) return;
    const seq = session.lastSeq + 1;
    const at = entry.at ?? this.iso();
    const { seq: _ignored, ...rest } = entry;
    void _ignored;
    await this.transcripts.append(sessionId, { ...rest, seq, at } as TranscriptEntry);
    await this.stateStore.update((draft) => {
      const current = draft.sessions[sessionId];
      if (current && current.lastSeq < seq) current.lastSeq = seq;
    });
  }

  private async seedFor(sessionId: string) {
    const entries = await this.transcripts.load(sessionId);
    return buildSeed(entries, this.config.sessions.seedMaxTokens);
  }

  private instructionsFor(kind: SessionKind): string {
    if (kind === "task") return withFile(backInstructions(), this.config.agents.back.instructions);
    if (kind === "check") return heartbeatInstructions();
    if (kind === "judge") return relevanceInstructions();
    if (kind === "compact") return compactInstructions();
    return withFile(frontInstructions(), this.config.agents.front.instructions);
  }

  private youProfile(): YouProfile {
    const duty = this.config.persona.duty.trim();
    return {
      name: this.config.persona.name || this.bot.name || "assistant",
      persona: this.config.persona.text,
      ...(duty ? { duty } : {}),
    };
  }

  private turnMessage(record: ImRecord) {
    return toTurnMessage(record, {
      timeZone: this.config.timezone,
      now: new Date(this.clock.now()),
      isSelf: (ref, full) => (full ? isSelf(full, this.bot.ref, this.bot.stableId) : Boolean(this.bot.ref) && ref === this.bot.ref),
      nameOf: (item) => (isSelf(item, this.bot.ref, this.bot.stableId) && this.bot.name) || item.actor.name || this.persons.displayName(item.actor.stableId, item.actor.ref),
    });
  }

  private recordFromMessage(message: MessageEvent): ImRecord {
    return {
      messageId: message.messageId,
      scope: message.scope,
      actor: message.actor,
      text: message.text,
      attachments: message.attachments,
      mentionsSelf: message.mentionsSelf,
      mentions: message.mentions,
      occurredAt: message.occurredAt,
      replyTo: message.replyTo,
    };
  }

  /** Env for agent tools (pi extensions / Codex dynamicTools). Conversation and task sessions. */
  private toolEnvFor(session: SessionRecord): Record<string, string> | undefined {
    if (session.runtimeName !== "pi" && session.runtimeName !== "codex") return undefined;
    if (session.kind !== "conversation" && session.kind !== "task") return undefined;
    return { LARKLING_API_URL: this.apiUrl, LARKLING_SESSION_TOKEN: session.token };
  }

  /** Dedicated task tools (pi extensions or Codex dynamicTools) instead of CLI wrappers. */
  private usesAgentTools(session: SessionRecord): boolean {
    return (session.runtimeName === "pi" || session.runtimeName === "codex") &&
      (session.kind === "conversation" || session.kind === "task");
  }

  private profileFor(kind: SessionKind) {
    const agent = kind === "task" ? this.config.agents.back : this.config.agents.front;
    const light = kind === "check" || kind === "judge" || kind === "compact";
    return {
      provider: agent.provider,
      model: light ? agent.lightModel ?? agent.model : agent.model,
      effort: light ? undefined : agent.effort,
      sandbox: light ? "read-only" : agent.sandbox,
      approvalPolicy: light ? "never" : agent.approvalPolicy,
      // The front agent defaults to an empty work dir so it does not browse the install.
      cwd: agent.cwd ?? (kind === "task" ? undefined : this.frontDir()),
      // Check, judge, and compact use the light profile and keep the same fast flag.
      fast: agent.fast,
      network: light ? false : agent.network,
      extra: light ? {} : agent.extra,
    };
  }

  private frontDir(): string {
    return join(this.config.stateDir, "front");
  }

  private runtimeFor(session: SessionRecord): RuntimeAdapter {
    const runtime = this.runtimes.get(session.runtimeName);
    if (!runtime) throw new Error(`runtime ${session.runtimeName} is not registered`);
    return runtime;
  }

  private capabilities(session: SessionRecord): { steer: boolean } {
    return { steer: this.runtimes.get(session.runtimeName)?.capabilities.steer ?? false };
  }

  private must(sessionId: string): SessionRecord {
    const session = this.stateStore.get().sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} is missing`);
    return session;
  }

  private storedFrom(event: MessageEvent, fromBot: boolean, trust: string): StoredMessage {
    return {
      messageId: event.messageId,
      scope: event.scope,
      container: event.scope.id,
      actor: event.actor,
      text: event.text,
      attachments: event.attachments,
      mentionsSelf: event.mentionsSelf,
      occurredAt: event.occurredAt,
      replyTo: event.replyTo,
      fromBot,
      disposition: event.disposition ?? "normal",
      trust,
      recalled: false,
    };
  }

  private recordFromQueued(message: Extract<QueuedInput, { kind: "message" }>, scope?: Scope): ImRecord {
    return {
      messageId: message.messageId,
      scope: scope ?? { channel: this.channel.channel, kind: "dm", id: "unknown" },
      actor: message.actor,
      text: message.text,
      attachments: message.attachments,
      mentionsSelf: false,
      mentions: message.mentions,
      occurredAt: message.occurredAt,
    };
  }

  private rememberAttachments(messageId: string, attachments: AttachmentRef[]): void {
    if (!attachments.length) return;
    this.attachments.set(messageId, attachments);
  }

  private noteVisible(sessionId: string, record: ImRecord): void {
    const set = this.visibleMessages.get(sessionId) ?? new Set<string>();
    set.add(record.messageId);
    this.visibleMessages.set(sessionId, set);
    if (record.attachments.length) this.attachments.set(record.messageId, record.attachments);
  }

  private async markEvent(eventId: string): Promise<boolean> {
    return this.stateStore.update((draft) => {
      if (draft.seenEventIds.includes(eventId)) return false;
      draft.seenEventIds.push(eventId);
      if (draft.seenEventIds.length > 5000) draft.seenEventIds.splice(0, draft.seenEventIds.length - 5000);
      return true;
    });
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private runtimePending(): boolean {
    for (const runtime of this.runtimes.values()) {
      if ("pendingWork" in runtime && typeof (runtime as { pendingWork?: () => number }).pendingWork === "function") {
        if ((runtime as { pendingWork: () => number }).pendingWork() > 0) return true;
      }
    }
    return false;
  }

  private sessionsBusy(): boolean {
    return Object.values(this.stateStore?.get().sessions ?? {}).some((session) => session.phase === "running" || (session.phase === "idle" && session.queue.length > 0));
  }

  private tracked(work: Promise<unknown>): Promise<void> {
    this.inflight += 1;
    return work.then(
      () => {
        this.inflight -= 1;
      },
      (error) => {
        this.inflight -= 1;
        this.log.error("background", { error: error instanceof Error ? error.message : String(error) });
      },
    );
  }
}

function blankSession(init: { sessionId: string; kind: SessionKind; runtimeName: string; token: string; createdAt: string; scope?: Scope; parentSessionId?: string; taskId?: string; imContainer?: string }): SessionRecord {
  return {
    sessionId: init.sessionId,
    kind: init.kind,
    scope: init.scope,
    runtimeName: init.runtimeName,
    lastSeq: 0,
    phase: "idle",
    queue: [],
    pendingApprovalIds: [],
    parentSessionId: init.parentSessionId,
    taskId: init.taskId,
    imContainer: init.imContainer,
    token: init.token,
    createdAt: init.createdAt,
    updatedAt: init.createdAt,
    live: false,
  };
}

function inRange(value: string, start?: string, end?: string): boolean {
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function presentTask(task: TaskRecord | undefined): TaskRecord {
  if (!task) throw new ApiError("NOT_FOUND", "task not found", 404);
  return { ...task, audience: storedAudience(task.audience) };
}

function readAudience(value: unknown) {
  try {
    return readAudiencePatch(value);
  } catch (error) {
    if (error instanceof AudienceError) throw new ApiError("BAD_REQUEST", error.message);
    throw error;
  }
}

export async function createHost(options: HostOptions): Promise<Host> {
  return new Host(options);
}
