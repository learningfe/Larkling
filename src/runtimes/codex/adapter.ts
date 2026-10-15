import type { HealthItem, RuntimeAdapter, RuntimeEvent, RuntimeProfile, RuntimeRef, Seed, SessionSpec, TurnInput } from "../../protocol/types.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { SteerRejected } from "../../core/errors.js";
import { MemoryCodexTransport, StdioCodexTransport, type CodexTransport } from "./transport.js";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number; data?: unknown };
}

interface ThreadState {
  sessionId: string;
  threadId: string;
  profile: RuntimeProfile;
  codexTurnId?: string;
  ourTurnId?: string;
  agentText: string;
  failed?: { message: string; retryable: boolean };
  /** Seed for a brand-new thread. Sent on the first turn, then dropped. */
  pendingSeed?: Seed;
  /** Highest transcript seq already given to this thread. A seed at or below it is skipped. */
  seededThroughSeq?: number;
}

/** Preface for transcript text injected into a new thread. The model must not answer it. */
export const SEED_PREFACE = "Earlier conversation transcript (already happened; do not reply to it again):";

const RETRYABLE = /HttpConnectionFailed|ResponseStreamConnectionFailed|ResponseStreamDisconnected|ResponseTooManyFailedAttempts|timeout/i;

/**
 * One `codex app-server` process per Larkling process.
 * Stable instructions are sent as `developerInstructions` at thread start.
 * `updateInstructions` is unsupported: the core releases and reseeds.
 */
export class CodexRuntime implements RuntimeAdapter {
  readonly name = "codex";
  readonly capabilities = { steer: true, approvals: true };
  private transport?: CodexTransport;
  private reader?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly eventsQueue = new AsyncQueue<RuntimeEvent>();
  private readonly threads = new Map<string, ThreadState>();
  private readonly byThread = new Map<string, string>();
  private readonly approvals = new Map<string, number>();
  private initialized = false;
  private closed = false;

  constructor(
    private readonly options: { command?: string; args?: string[]; transport?: CodexTransport; env?: NodeJS.ProcessEnv } = {},
  ) {}

  async open(session: SessionSpec): Promise<RuntimeRef> {
    await this.connect();
    const profile = session.profile;
    if (session.runtimeRef) {
      const result = await this.request("thread/resume", { threadId: session.runtimeRef, ...threadConfig(profile) });
      const threadId = String(asRecord(result.thread)?.id ?? session.runtimeRef);
      this.remember(threadId, session.sessionId, profile);
      return threadId;
    }
    const result = await this.request("thread/start", {
      ...threadConfig(profile),
      model: profile.model,
      developerInstructions: session.instructions,
      ephemeral: session.kind === "check" || session.kind === "judge" || session.kind === "compact",
      serviceName: "larkling",
    });
    const threadId = String(asRecord(result.thread)?.id ?? "");
    if (!threadId) throw new Error("thread/start did not return a thread id");
    this.remember(threadId, session.sessionId, profile, session.seed);
    return threadId;
  }

  async start(ref: RuntimeRef, input: TurnInput): Promise<void> {
    const state = this.require(ref);
    const seed = this.takeSeed(state);
    const result = await this.request("turn/start", {
      threadId: state.threadId,
      input: toCodexInput(input, seed),
      ...turnConfig(state.profile),
    });
    state.codexTurnId = String(asRecord(result.turn)?.id ?? "");
    state.ourTurnId = input.turnId;
    state.agentText = "";
    state.failed = undefined;
  }

  async steer(ref: RuntimeRef, input: TurnInput): Promise<void> {
    const state = this.require(ref);
    if (!state.codexTurnId) throw new SteerRejected("no active codex turn");
    try {
      await this.request("turn/steer", {
        threadId: state.threadId,
        expectedTurnId: state.codexTurnId,
        input: toCodexInput(input),
      });
    } catch (error) {
      throw new SteerRejected(error instanceof Error ? error.message : String(error));
    }
  }

  async interrupt(ref: RuntimeRef): Promise<void> {
    const state = this.threads.get(ref);
    if (!state?.codexTurnId) return;
    await this.request("turn/interrupt", { threadId: state.threadId, turnId: state.codexTurnId });
  }

  async resolveApproval(ref: RuntimeRef, approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const rpcId = this.approvals.get(approvalId);
    if (rpcId == null || !this.transport) return;
    this.approvals.delete(approvalId);
    this.transport.send({ id: rpcId, result: { decision: decision === "approve" ? "accept" : "decline" } });
    void ref;
  }

  async updateInstructions(_ref: RuntimeRef, _instructions: string): Promise<"unsupported"> {
    return "unsupported";
  }

  async release(ref: RuntimeRef): Promise<void> {
    const state = this.threads.get(ref);
    if (!state || !this.transport) return;
    await this.request("thread/unsubscribe", { threadId: state.threadId }).catch(() => undefined);
    this.threads.delete(ref);
    this.byThread.delete(state.threadId);
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this.eventsQueue;
  }

  async health(): Promise<HealthItem[]> {
    return [{ name: "codex", ok: this.initialized && !this.closed, detail: this.initialized ? "app-server" : "not started" }];
  }

  close(): void {
    this.closed = true;
    this.transport?.close();
    this.eventsQueue.close();
  }

  private remember(threadId: string, sessionId: string, profile: RuntimeProfile, seed?: Seed): void {
    const state: ThreadState = { sessionId, threadId, profile, agentText: "" };
    if (seed?.text.trim()) state.pendingSeed = seed;
    this.threads.set(threadId, state);
    this.byThread.set(threadId, threadId);
  }

  /**
   * One seed per new thread. A seed that does not extend past `seededThroughSeq`
   * is dropped so compacted entries already in the thread are not sent again.
   */
  private takeSeed(state: ThreadState): string | undefined {
    const seed = state.pendingSeed;
    state.pendingSeed = undefined;
    if (!seed?.text.trim()) return undefined;
    if (state.seededThroughSeq != null && seed.throughSeq <= state.seededThroughSeq) return undefined;
    state.seededThroughSeq = seed.throughSeq;
    return seed.text;
  }

  private require(ref: string): ThreadState {
    const state = this.threads.get(ref);
    if (!state) throw new Error(`unknown codex thread ${ref}`);
    return state;
  }

  private async connect(): Promise<void> {
    if (this.initialized) return;
    this.transport = this.options.transport ?? new StdioCodexTransport(this.options.command ?? "codex", ["app-server", ...(this.options.args ?? [])], this.options.env);
    this.reader = this.readLoop();
    await this.request("initialize", {
      clientInfo: { name: "larkling", title: "Larkling", version: "0.1.0" },
    });
    this.transport.send({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.transport?.send({ method, id, params });
    return promise;
  }

  private async readLoop(): Promise<void> {
    if (!this.transport) return;
    try {
      for await (const message of this.transport.messages()) this.onMessage(message as RpcMessage);
    } finally {
      if (!this.closed) {
        const sessionIds = [...this.threads.values()].map((thread) => thread.sessionId);
        for (const [id, waiter] of this.pending) {
          waiter.reject(new Error("codex app-server closed"));
          this.pending.delete(id);
        }
        if (sessionIds.length) this.eventsQueue.push({ type: "runtime.lost", sessionIds });
      }
    }
  }

  private onMessage(message: RpcMessage): void {
    if (message.id != null && message.method && message.result === undefined && message.error === undefined) {
      this.onServerRequest(message);
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "codex request failed"));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.onNotification(message.method, message.params ?? {});
  }

  private onServerRequest(message: RpcMessage): void {
    const method = message.method ?? "";
    const params = message.params ?? {};
    const kind = approvalKind(method);
    if (!kind || message.id == null) {
      this.transport?.send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    const threadId = String(params.threadId ?? "");
    const state = this.threads.get(threadId);
    const approvalId = String(params.approvalId ?? message.id);
    this.approvals.set(approvalId, message.id);
    if (!state) {
      this.transport?.send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    const summary = String(params.command ?? params.reason ?? params.cwd ?? kind).slice(0, 500);
    this.eventsQueue.push({
      type: "approval.requested",
      sessionId: state.sessionId,
      turnId: state.ourTurnId ?? "",
      approvalId,
      kind,
      summary,
    });
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item) ?? params;
      const threadId = String(params.threadId ?? item.threadId ?? "");
      const state = this.threads.get(threadId) ?? this.onlyThread();
      if (!state) return;
      if (method === "item/completed" && String(item.type ?? "") === "agentMessage") {
        const text = itemText(item);
        if (text) state.agentText = text;
      }
      if (method === "item/started") {
        const summary = String(item.command ?? item.type ?? "").slice(0, 200);
        this.eventsQueue.push({ type: "activity", sessionId: state.sessionId, turnId: state.ourTurnId ?? "", summary });
      }
      return;
    }
    if (method === "error") {
      const threadId = String(params.threadId ?? "");
      const state = this.threads.get(threadId) ?? this.onlyThread();
      if (!state) return;
      const error = asRecord(params.error) ?? params;
      const message = String(error.message ?? "codex error");
      state.failed = { message, retryable: RETRYABLE.test(JSON.stringify(error)) };
      return;
    }
    if (method !== "turn/completed" && method !== "turn/started") return;
    const turn = asRecord(params.turn) ?? params;
    const threadId = String(params.threadId ?? turn.threadId ?? "");
    const state = this.threads.get(threadId) ?? this.onlyThread();
    if (!state) return;
    if (method === "turn/started") {
      if (!state.codexTurnId) state.codexTurnId = String(turn.id ?? "");
      this.eventsQueue.push({ type: "turn.started", sessionId: state.sessionId, turnId: state.ourTurnId ?? "" });
      return;
    }
    const status = String(turn.status ?? "");
    const turnId = state.ourTurnId ?? "";
    if (status === "interrupted") {
      this.eventsQueue.push({ type: "turn.interrupted", sessionId: state.sessionId, turnId });
      return;
    }
    if (status === "failed") {
      const error = asRecord(turn.error) ?? state.failed ?? { message: "turn failed" };
      const message = String(error.message ?? state.failed?.message ?? "turn failed");
      const retryable = state.failed?.retryable || RETRYABLE.test(JSON.stringify(error));
      this.eventsQueue.push({ type: "turn.failed", sessionId: state.sessionId, turnId, error: message, retryable });
      return;
    }
    const text = state.agentText || itemText(asRecord(turn.items) ? {} : turn) || textFromItems(turn.items);
    this.eventsQueue.push({ type: "turn.completed", sessionId: state.sessionId, turnId, text });
  }

  private onlyThread(): ThreadState | undefined {
    if (this.threads.size !== 1) return undefined;
    return [...this.threads.values()][0];
  }
}

/** app-server thread config expects kebab-case sandbox variants. */
export function mapSandbox(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === "read-only" || value === "readOnly") return "read-only";
  if (value === "workspace-write" || value === "workspaceWrite") return "workspace-write";
  if (value === "danger-full-access" || value === "dangerFullAccess") return "danger-full-access";
  return value;
}

function threadConfig(profile: RuntimeProfile): Record<string, unknown> {
  return {
    cwd: profile.cwd,
    approvalPolicy: profile.approvalPolicy,
    sandbox: mapSandbox(profile.sandbox),
  };
}

function turnConfig(profile: RuntimeProfile): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: profile.model,
    effort: profile.effort,
    approvalPolicy: profile.approvalPolicy,
    sandbox: mapSandbox(profile.sandbox),
  };
  // Config calls this `fast`. The app-server field is serviceTier.
  if (profile.fast) config.serviceTier = "priority";
  return config;
}

export function toCodexInput(input: TurnInput, seed?: string): unknown[] {
  const items: unknown[] = [];
  if (seed?.trim()) items.push({ type: "text", text: `${SEED_PREFACE}\n${seed.trim()}` });
  const text = [input.context, ...input.messages.map((message) => message.text)].filter(Boolean).join("\n\n");
  if (text) items.push({ type: "text", text });
  for (const message of input.messages) {
    for (const image of message.images ?? []) items.push({ type: "localImage", path: image.path });
  }
  return items;
}

function approvalKind(method: string): "command" | "file_change" | "permission" | "tool" | undefined {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "file_change";
  if (method === "item/permissions/requestApproval") return "permission";
  if (method === "item/tool/call" || method === "tool/requestUserInput" || method === "item/tool/requestUserInput") return "tool";
  return undefined;
}

function textFromItems(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => asRecord(item)?.type === "agentMessage")
    .map((item) => itemText(asRecord(item) ?? {}))
    .filter(Boolean)
    .join("\n");
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => (typeof part === "string" ? part : String(asRecord(part)?.text ?? ""))).join("");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export { MemoryCodexTransport };
