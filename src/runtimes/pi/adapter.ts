import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HealthItem, RuntimeAdapter, RuntimeEvent, RuntimeProfile, RuntimeRef, SessionSpec, TurnInput } from "../../protocol/types.js";
import { AsyncQueue } from "../../util/async-queue.js";
import { atomicWrite } from "../../util/fs.js";
import { SteerRejected } from "../../core/errors.js";
import { SEED_PREFACE } from "../codex/adapter.js";
import { PI_KILL_GRACE_MS, spawnPi, type PiProcess, type PiProcessFactory } from "./transport.js";

export interface PiRuntimeOptions {
  command?: string;
  /** Extra CLI args appended after the ones Larkling sets. */
  args?: string[];
  /** Larkling-owned pi session directory, e.g. ~/.larkling/state/pi-sessions. */
  sessionDir: string;
  /** Provider used when the profile does not name one. pi itself defaults to google, so this is required in practice. */
  provider?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: PiProcessFactory;
  /** Override for tests. Checks that a session file exists before resuming it. */
  fileExists?: (path: string) => Promise<boolean>;
  /**
   * Larkling state directory. Extension files are copied under `<stateDir>/pi-extensions`
   * before spawn so pi does not open the install tree.
   */
  stateDir?: string;
  /** Timeout for staging an extension and for each RPC command response. */
  requestTimeoutMs?: number;
  /** SIGTERM-to-SIGKILL delay after an RPC timeout. */
  killGraceMs?: number;
  /** Absolute path to the front-tools pi extension. Default: next to this module. */
  frontToolsExtension?: string;
  /** Absolute path to the back-tools pi extension. Default: next to this module. */
  backToolsExtension?: string;
  log?: PiRuntimeLog;
}

export interface PiRuntimeLog {
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface PiResponse {
  id?: string;
  type: "response";
  command?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface SessionState {
  ref: string;
  sessionId: string;
  process: PiProcess;
  profile: RuntimeProfile;
  ephemeral: boolean;
  pendingSeed?: string;
  ourTurnId?: string;
  streaming: boolean;
  /** Text streamed in the current assistant message. */
  text: string;
  /** Text of the last finished assistant message in the current run. */
  lastText: string;
  interrupted: boolean;
  /** Last assistant message seen in any agent_end of the current run. */
  lastAssistant?: Record<string, unknown>;
  /** Paths passed to pi via --extension. */
  extensions: string[];
  /** Install-tree paths those extensions were copied from. */
  extensionSources: string[];
  /** Secret env values to strip from logged stderr. */
  secrets: string[];
  pending: Map<string, { resolve: (value: PiResponse) => void; reject: (error: Error) => void }>;
  closing: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** One blocked install-tree read per source. A second read would take another libuv worker. */
const pendingExtensionReads = new Map<string, Promise<void>>();

const RETRYABLE = /overloaded|rate.?limit|429|5\d\d|timeout|ECONNRESET|ETIMEDOUT|network|fetch failed/i;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * One `pi --mode rpc` process per open session.
 * The ref is the pi session file path, or `ephemeral:<uuid>` for check/judge/compact.
 * pi has no sandbox and no approval requests, so `sandbox`, `approvalPolicy`, and `network` are not enforced.
 * pi takes the system prompt at process start, so `updateInstructions` is unsupported and the core reseeds.
 */
export class PiRuntime implements RuntimeAdapter {
  readonly name = "pi";
  readonly capabilities = { steer: true, approvals: false };
  private readonly eventsQueue = new AsyncQueue<RuntimeEvent>();
  private readonly sessions = new Map<string, SessionState>();
  private nextId = 1;
  private closed = false;
  private lastError?: string;

  constructor(private readonly options: PiRuntimeOptions) {}

  async open(session: SessionSpec): Promise<RuntimeRef> {
    const profile = session.profile;
    const ephemeral = session.kind === "check" || session.kind === "judge" || session.kind === "compact";
    // pi silently starts an empty session when --session points at a missing file.
    // Fail instead, so the core opens a fresh session and re-sends the transcript seed.
    if (session.runtimeRef && !ephemeral && !(await (this.options.fileExists ?? exists)(session.runtimeRef))) {
      throw new PiSessionMissing(session.runtimeRef);
    }
    const extensionSource =
      session.kind === "conversation"
        ? (this.options.frontToolsExtension ?? frontToolsExtensionPath())
        : session.kind === "task"
          ? (this.options.backToolsExtension ?? backToolsExtensionPath())
          : undefined;
    const staged = await this.prepareExtension(extensionSource);
    const toolsExtension = staged?.path;
    const args = piArgs({
      profile,
      instructions: session.instructions,
      provider: profile.provider ?? this.options.provider,
      sessionDir: this.options.sessionDir,
      resume: ephemeral ? undefined : session.runtimeRef,
      ephemeral,
      toolsExtension,
      extra: this.options.args,
    });
    const env = { ...(this.options.env ?? process.env), ...(session.toolEnv ?? {}) };
    const child = (this.options.spawn ?? spawnPi)({ command: this.options.command ?? "pi", args, cwd: profile.cwd, env });
    const state: SessionState = {
      ref: "",
      sessionId: session.sessionId,
      process: child,
      profile,
      ephemeral,
      streaming: false,
      text: "",
      lastText: "",
      interrupted: false,
      extensions: toolsExtension ? [toolsExtension] : [],
      extensionSources: extensionSource ? [extensionSource] : [],
      secrets: secretValues(env),
      pending: new Map(),
      closing: false,
    };
    void this.readLoop(state);
    try {
      const response = await this.request(state, { type: "get_state" });
      const file = typeof response.data?.sessionFile === "string" ? response.data.sessionFile : "";
      state.ref = ephemeral || !file ? `ephemeral:${randomUUID()}` : file;
    } catch (error) {
      state.closing = true;
      child.close();
      throw error;
    }
    // A resumed session already holds its history, so only new sessions take the seed.
    if (!session.runtimeRef && session.seed?.text.trim()) state.pendingSeed = session.seed.text.trim();
    this.sessions.set(state.ref, state);
    return state.ref;
  }

  async start(ref: RuntimeRef, input: TurnInput): Promise<void> {
    const state = this.require(ref);
    const seed = state.pendingSeed;
    state.pendingSeed = undefined;
    state.ourTurnId = input.turnId;
    state.text = "";
    state.lastText = "";
    state.interrupted = false;
    state.lastAssistant = undefined;
    const command: Record<string, unknown> = { type: "prompt", message: toPiMessage(input, seed) };
    const images = await loadImages(input);
    if (images.length) command.images = images;
    // Set before the response so a fast agent_start is not mistaken for idle.
    state.streaming = true;
    const response = await this.request(state, command).catch((error: Error) => ({ type: "response", success: false, error: error.message }) as PiResponse);
    if (response.success === false) {
      state.streaming = false;
      throw new Error(response.error || "pi rejected the prompt");
    }
    // An input handler consumed the prompt and no run will follow.
    if (response.data?.disposition === "handled") {
      state.streaming = false;
      this.eventsQueue.push({ type: "turn.completed", sessionId: state.sessionId, turnId: input.turnId, text: "" });
    }
  }

  async steer(ref: RuntimeRef, input: TurnInput): Promise<void> {
    const state = this.require(ref);
    if (!state.streaming) throw new SteerRejected("no active pi run");
    const command: Record<string, unknown> = { type: "steer", message: toPiMessage(input) };
    const images = await loadImages(input);
    if (images.length) command.images = images;
    const response = await this.request(state, command).catch((error: Error) => ({ type: "response", success: false, error: error.message }) as PiResponse);
    if (response.success === false) throw new SteerRejected(response.error || "pi rejected steer");
  }

  async interrupt(ref: RuntimeRef): Promise<void> {
    const state = this.sessions.get(ref);
    if (!state?.streaming) return;
    state.interrupted = true;
    await this.request(state, { type: "abort" }).catch(() => undefined);
  }

  async resolveApproval(): Promise<void> {
    // pi never asks for approval.
  }

  async updateInstructions(_ref: RuntimeRef, _instructions: string): Promise<"unsupported"> {
    return "unsupported";
  }

  /** Ask pi to compact the session. The core does its own transcript compaction; this is for callers that want pi's. */
  async compact(ref: RuntimeRef, customInstructions?: string): Promise<string> {
    const state = this.require(ref);
    const response = await this.request(state, customInstructions ? { type: "compact", customInstructions } : { type: "compact" });
    if (response.success === false) throw new Error(response.error || "pi compact failed");
    return String(response.data?.summary ?? "");
  }

  async release(ref: RuntimeRef): Promise<void> {
    const state = this.sessions.get(ref);
    if (!state) return;
    this.sessions.delete(ref);
    state.closing = true;
    state.process.close();
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this.eventsQueue;
  }

  async health(): Promise<HealthItem[]> {
    return [{ name: "pi", ok: !this.closed && !this.lastError, detail: this.lastError ?? `${this.sessions.size} live` }];
  }

  close(): void {
    this.closed = true;
    for (const state of this.sessions.values()) {
      state.closing = true;
      state.process.close();
    }
    this.sessions.clear();
    this.eventsQueue.close();
  }

  private require(ref: string): SessionState {
    const state = this.sessions.get(ref);
    if (!state) throw new Error(`unknown pi session ${ref}`);
    return state;
  }

  private request(state: SessionState, command: Record<string, unknown>): Promise<PiResponse> {
    const id = `lk-${this.nextId++}`;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const commandType = String(command.type);
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        this.reportTimeout(state, commandType);
        // SIGTERM leaves a child blocked in open(); SIGKILL is what actually reaps it.
        state.process.close({ force: true, graceMs: this.options.killGraceMs ?? PI_KILL_GRACE_MS });
        reject(timeoutError(commandType, state.extensions));
      }, timeoutMs);
      timer.unref?.();
      state.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      state.process.send({ ...command, id });
    });
  }

  private async prepareExtension(source: string | undefined): Promise<{ path: string; fresh: boolean } | undefined> {
    if (!source) return undefined;
    const stateDir = this.options.stateDir;
    if (!stateDir) return { path: source, fresh: true };
    try {
      const staged = await stagePiExtension(source, stateDir, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      if (!staged.fresh) this.emit("warn", "pi.extension_stale", { source, extension: staged.path });
      return staged;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("error", "pi.extension_stage_failed", { source, error: message });
      throw error;
    }
  }

  private reportTimeout(state: SessionState, command: string): void {
    this.lastError = `pi ${command} timed out`;
    this.emit("error", "pi.rpc_timeout", {
      command,
      extensions: state.extensions,
      sources: state.extensionSources,
      stderr: redact(state.process.stderr ?? "", state.secrets).slice(-4000),
    });
  }

  private emit(level: "warn" | "error", event: string, fields: Record<string, unknown>): void {
    const log = this.options.log;
    if (log) {
      log[level](event, fields);
      return;
    }
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level, event, ...fields })}\n`);
  }

  private async readLoop(state: SessionState): Promise<void> {
    try {
      for await (const message of state.process.messages()) this.onMessage(state, asRecord(message) ?? {});
    } finally {
      for (const [id, waiter] of state.pending) {
        waiter.reject(new Error("pi process exited"));
        state.pending.delete(id);
      }
      const known = state.ref && this.sessions.get(state.ref) === state;
      if (known) this.sessions.delete(state.ref);
      if (!state.closing && !this.closed && known) {
        this.lastError = "pi process exited";
        this.eventsQueue.push({ type: "runtime.lost", sessionIds: [state.sessionId] });
      }
    }
  }

  private onMessage(state: SessionState, message: Record<string, unknown>): void {
    const type = String(message.type ?? "");
    if (type === "response") {
      const id = typeof message.id === "string" ? message.id : "";
      const waiter = state.pending.get(id);
      if (!waiter) return;
      state.pending.delete(id);
      waiter.resolve(message as unknown as PiResponse);
      return;
    }
    if (type === "extension_ui_request") {
      // Extensions are disabled; decline any dialog so pi does not block.
      const method = String(message.method ?? "");
      if (["select", "confirm", "input", "editor"].includes(method)) state.process.send({ type: "extension_ui_response", id: message.id, cancelled: true });
      return;
    }
    const turnId = state.ourTurnId ?? "";
    const sessionId = state.sessionId;
    switch (type) {
      case "agent_start":
        state.streaming = true;
        this.eventsQueue.push({ type: "turn.started", sessionId, turnId });
        return;
      case "message_update": {
        const event = asRecord(message.assistantMessageEvent);
        if (event?.type === "text_delta" && typeof event.delta === "string") state.text += event.delta;
        return;
      }
      case "message_end": {
        const msg = asRecord(message.message);
        if (msg?.role === "assistant") {
          const text = assistantText(msg) || state.text;
          if (text) state.lastText = text;
          state.text = "";
        }
        return;
      }
      case "tool_execution_start": {
        this.eventsQueue.push({ type: "activity", sessionId, turnId, summary: toolSummary(message) });
        return;
      }
      case "compaction_start":
        this.eventsQueue.push({ type: "activity", sessionId, turnId, summary: "compaction" });
        return;
      case "agent_end": {
        const messages = Array.isArray(message.messages) ? message.messages.map((item) => asRecord(item) ?? {}) : [];
        const last = [...messages].reverse().find((item) => item.role === "assistant");
        if (last) state.lastAssistant = last;
        // pi 1.x follows agent_end with agent_settled; retries and queued work may run in between.
        // Older pi has no willRetry field and no agent_settled, so finish here.
        if (message.willRetry === undefined) {
          state.streaming = false;
          this.finish(state, false);
        }
        return;
      }
      case "agent_settled":
        if (!state.streaming) return;
        state.streaming = false;
        this.finish(state, message.aborted === true);
        return;
      default:
        return;
    }
  }

  private finish(state: SessionState, aborted: boolean): void {
    const turnId = state.ourTurnId ?? "";
    const sessionId = state.sessionId;
    const last = state.lastAssistant;
    const stopReason = String(last?.stopReason ?? "");
    if (aborted || stopReason === "aborted" || (state.interrupted && !last)) {
      this.eventsQueue.push({ type: "turn.interrupted", sessionId, turnId });
      return;
    }
    if (stopReason === "error") {
      const error = String(last?.errorMessage ?? "pi turn failed");
      this.eventsQueue.push({ type: "turn.failed", sessionId, turnId, error, retryable: RETRYABLE.test(error) });
      return;
    }
    const text = (last ? assistantText(last) : "") || state.lastText || state.text;
    this.eventsQueue.push({ type: "turn.completed", sessionId, turnId, text });
  }
}

export class PiSessionMissing extends Error {
  constructor(readonly path: string) {
    super(`pi session file missing: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Larkling effort names to pi thinking levels. Unknown values are left to pi's default. */
export function mapThinking(effort?: string): string | undefined {
  if (!effort) return undefined;
  const value = effort.toLowerCase();
  if (value === "none") return "off";
  return THINKING.has(value) ? value : undefined;
}

export function piArgs(options: {
  profile: RuntimeProfile;
  instructions: string;
  provider?: string;
  sessionDir: string;
  resume?: string;
  ephemeral: boolean;
  /** Absolute path to a tools extension; loaded with -e even when --no-extensions is set. */
  toolsExtension?: string;
  extra?: string[];
}): string[] {
  const { profile } = options;
  if (!options.provider) throw new Error("pi runtime needs a provider (agents.<name>.provider or runtimes.pi.provider)");
  if (!profile.model) throw new Error("pi runtime needs agents.<name>.model");
  const args = ["--mode", "rpc", "--provider", options.provider, "--model", profile.model];
  const thinking = mapThinking(profile.effort);
  if (thinking) args.push("--thinking", thinking);
  args.push("--system-prompt", options.instructions || " ");
  args.push("--no-context-files", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes");
  if (options.toolsExtension) args.push("--extension", options.toolsExtension);
  if (options.ephemeral) args.push("--no-session");
  else {
    args.push("--session-dir", options.sessionDir);
    if (options.resume) args.push("--session", options.resume);
  }
  // `fast` has no pi equivalent and is ignored. `network` cannot be enforced; pi's bash tool is unsandboxed.
  return [...args, ...(options.extra ?? [])];
}

/**
 * Copy a pi extension out of the install tree before spawn.
 * pi loads `--extension` with a blocking read. When that path cannot be read
 * (macOS ~/Downloads is one case), the child never answers get_state, and
 * SIGTERM does not unblock the read. The copy lives under stateDir. A read
 * that exceeds `timeoutMs` reuses the previous copy when one exists; otherwise
 * the open fails instead of pointing pi back at the install tree. A read that
 * is still stuck is not started again, so it cannot fill the libuv pool.
 */
export async function stagePiExtension(source: string, stateDir: string, timeoutMs: number): Promise<{ path: string; fresh: boolean }> {
  const dest = join(stateDir, "pi-extensions", basename(source));
  const key = `${stateDir}\0${source}`;
  if (pendingExtensionReads.has(key)) return reuseStagedExtension(dest, source);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = (async () => {
    const data = await readFile(source);
    await atomicWrite(dest, data, 0o600);
  })();
  const settled = copy.then(
    () => undefined,
    () => undefined,
  );
  pendingExtensionReads.set(key, settled);
  const release = () => {
    if (pendingExtensionReads.get(key) === settled) pendingExtensionReads.delete(key);
  };
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      copy.then(
        () => "ok" as const,
        (error: unknown) => ({ error }),
      ),
      timeout,
    ]);
    if (outcome === "ok") {
      release();
      return { path: dest, fresh: true };
    }
    if (outcome === "timeout") return reuseStagedExtension(dest, source);
    release();
    throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  } finally {
    if (timer) clearTimeout(timer);
    void settled.then(release);
  }
}

async function reuseStagedExtension(dest: string, source: string): Promise<{ path: string; fresh: boolean }> {
  try {
    await access(dest);
    return { path: dest, fresh: false };
  } catch {
    throw new Error(`timed out staging pi extension from ${source}`);
  }
}

function timeoutError(command: string, extensions: string[]): Error {
  const where = extensions.length ? ` (extension ${extensions.join(", ")})` : "";
  return new Error(`pi ${command} timed out${where}`);
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) values.push(value);
  }
  return values;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function frontToolsExtensionPath(): string {
  return fileURLToPath(new URL("./front-tools.ext.ts", import.meta.url));
}

export function backToolsExtensionPath(): string {
  return fileURLToPath(new URL("./back-tools.ext.ts", import.meta.url));
}

export function toPiMessage(input: TurnInput, seed?: string): string {
  const parts: string[] = [];
  if (seed?.trim()) parts.push(`${SEED_PREFACE}\n${seed.trim()}`);
  // Messages already rendered in the context window are not repeated.
  const text = [input.context, ...input.messages.map((message) => (message.inContext ? "" : message.text))].filter(Boolean).join("\n\n");
  if (text) parts.push(text);
  return parts.join("\n\n");
}

async function loadImages(input: TurnInput): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const message of input.messages) {
    for (const image of message.images ?? []) {
      const mimeType = MIME[extname(image.path).toLowerCase()];
      if (!mimeType) continue;
      try {
        out.push({ type: "image", data: (await readFile(image.path)).toString("base64"), mimeType });
      } catch {
        // A missing image file is skipped; the text still goes through.
      }
    }
  }
  return out;
}

function toolSummary(message: Record<string, unknown>): string {
  const name = String(message.toolName ?? "tool");
  const args = asRecord(message.args) ?? {};
  const detail = args.command ?? args.path ?? args.file_path ?? "";
  return (detail ? `${name}: ${String(detail)}` : name).slice(0, 200);
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asRecord(part))
    .filter((part) => part?.type === "text")
    .map((part) => String(part?.text ?? ""))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function defaultPiSessionDir(stateDir: string): string {
  return join(stateDir, "pi-sessions");
}
