import type { HealthItem, RuntimeAdapter, RuntimeEvent, RuntimeRef, SessionSpec, TurnInput } from "../protocol/types.js";
import { AsyncQueue } from "../util/async-queue.js";
import { SteerRejected } from "../core/errors.js";

export interface ScriptTurn {
  method: "start" | "steer";
  ref: RuntimeRef;
  spec: SessionSpec;
  input: TurnInput;
  emit: (event: { type: "turn.completed"; text: string } | { type: "turn.failed"; error: string; retryable: boolean } | { type: "activity"; summary?: string } | { type: "approval.requested"; approvalId: string; kind: "command" | "file_change" | "permission" | "tool"; summary: string }) => void;
  waitApproval: (approvalId: string) => Promise<"approve" | "deny">;
}

/**
 * In-process runtime whose turns are played by a test handler.
 * `start` and `steer` accept the call and run the handler asynchronously.
 */
export class ScriptedRuntime implements RuntimeAdapter {
  readonly capabilities: { steer: boolean; approvals: boolean };
  readonly opens: SessionSpec[] = [];
  readonly starts: { ref: string; input: TurnInput }[] = [];
  readonly steers: { ref: string; input: TurnInput }[] = [];
  readonly interrupts: string[] = [];
  readonly releases: string[] = [];
  readonly instructionUpdates: { ref: string; instructions: string }[] = [];
  instructionResult: "applied" | "unsupported" = "applied";
  /** When set, open() with a runtimeRef fails so the core must reseed. */
  failResume = false;
  rejectSteer = false;
  handler: (turn: ScriptTurn) => Promise<void> = async (turn) => {
    turn.emit({ type: "turn.completed", text: "ok" });
  };

  private readonly eventsQueue = new AsyncQueue<RuntimeEvent>();
  private readonly specs = new Map<string, SessionSpec>();
  private readonly approvals = new Map<string, (decision: "approve" | "deny") => void>();
  private readonly turnIds = new Map<string, string>();
  private readonly aborted = new Set<string>();
  private readonly emitTokens = new Map<string, number>();
  private pending = 0;

  constructor(
    readonly name: string,
    capabilities: { steer?: boolean; approvals?: boolean } = {},
  ) {
    this.capabilities = { steer: capabilities.steer ?? true, approvals: capabilities.approvals ?? true };
  }

  pendingWork(): number {
    return this.pending;
  }

  async open(session: SessionSpec): Promise<RuntimeRef> {
    if (session.runtimeRef && this.failResume) throw new Error("resume failed");
    const ref = session.runtimeRef ?? `scripted:${session.sessionId}`;
    this.specs.set(ref, session);
    this.opens.push(session);
    return ref;
  }

  async start(ref: RuntimeRef, input: TurnInput): Promise<void> {
    this.starts.push({ ref, input });
    this.aborted.delete(ref);
    this.turnIds.set(ref, input.turnId);
    this.launch("start", ref, input);
  }

  async steer(ref: RuntimeRef, input: TurnInput): Promise<void> {
    this.steers.push({ ref, input });
    if (this.rejectSteer) throw new SteerRejected();
    this.turnIds.set(ref, input.turnId);
    this.launch("steer", ref, input);
  }

  async interrupt(ref: RuntimeRef): Promise<void> {
    this.interrupts.push(ref);
    this.aborted.add(ref);
    const spec = this.specs.get(ref);
    if (!spec) return;
    this.eventsQueue.push({ type: "turn.interrupted", sessionId: spec.sessionId, turnId: this.turnIds.get(ref) ?? "" });
  }

  async resolveApproval(_ref: RuntimeRef, approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const waiter = this.approvals.get(approvalId);
    if (!waiter) return;
    this.approvals.delete(approvalId);
    waiter(decision);
  }

  async updateInstructions(ref: RuntimeRef, instructions: string): Promise<"applied" | "unsupported"> {
    this.instructionUpdates.push({ ref, instructions });
    return this.instructionResult;
  }

  async release(ref: RuntimeRef): Promise<void> {
    this.releases.push(ref);
    this.specs.delete(ref);
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this.eventsQueue;
  }

  async health(): Promise<HealthItem[]> {
    return [{ name: this.name, ok: true }];
  }

  /** Inject a runtime-level event, such as runtime.lost. */
  push(event: RuntimeEvent): void {
    this.eventsQueue.push(event);
  }

  close(): void {
    this.eventsQueue.close();
  }

  private launch(method: "start" | "steer", ref: string, input: TurnInput): void {
    const spec = this.specs.get(ref);
    if (!spec) return;
    const token = (this.emitTokens.get(ref) ?? 0) + 1;
    this.emitTokens.set(ref, token);
    this.pending += 1;
    queueMicrotask(() => {
      void this.run(method, ref, spec, input, token).finally(() => {
        this.pending -= 1;
      });
    });
  }

  private async run(method: "start" | "steer", ref: string, spec: SessionSpec, input: TurnInput, token: number): Promise<void> {
    const emit: ScriptTurn["emit"] = (event) => {
      if (this.aborted.has(ref) || this.emitTokens.get(ref) !== token) return;
      if (event.type === "turn.completed") {
        this.eventsQueue.push({ type: "turn.completed", sessionId: spec.sessionId, turnId: input.turnId, text: event.text });
        return;
      }
      if (event.type === "turn.failed") {
        this.eventsQueue.push({ type: "turn.failed", sessionId: spec.sessionId, turnId: input.turnId, error: event.error, retryable: event.retryable });
        return;
      }
      if (event.type === "activity") {
        this.eventsQueue.push({ type: "activity", sessionId: spec.sessionId, turnId: input.turnId, summary: event.summary });
        return;
      }
      this.eventsQueue.push({
        type: "approval.requested",
        sessionId: spec.sessionId,
        turnId: input.turnId,
        approvalId: event.approvalId,
        kind: event.kind,
        summary: event.summary,
      });
    };
    try {
      await this.handler({
        method,
        ref,
        spec,
        input,
        emit,
        waitApproval: (approvalId) =>
          new Promise((resolve) => {
            this.approvals.set(approvalId, resolve);
          }),
      });
    } catch (error) {
      this.eventsQueue.push({
        type: "turn.failed",
        sessionId: spec.sessionId,
        turnId: input.turnId,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }
  }
}
