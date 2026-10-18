import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonlSplitter, StdioPiProcess, type PiCloseOptions, type PiProcess, type PiSpawnOptions } from "../src/runtimes/pi/transport.js";
import { PiRuntime, mapThinking, piArgs, toPiMessage, type PiRuntimeLog, type PiRuntimeOptions } from "../src/runtimes/pi/adapter.js";
import { SEED_PREFACE } from "../src/runtimes/codex/adapter.js";
import type { RuntimeEvent, SessionSpec, TurnInput } from "../src/protocol/types.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { tempDir } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

/** In-memory pi process. `onCommand` plays the pi side. */
class MemoryPi implements PiProcess {
  readonly sent: Record<string, unknown>[] = [];
  readonly queue = new AsyncQueue<unknown>();
  readonly closes: Array<PiCloseOptions | undefined> = [];
  stderr = "";
  closed = false;
  constructor(
    readonly options: PiSpawnOptions,
    private readonly onCommand: (pi: MemoryPi, command: Record<string, unknown>) => void,
  ) {}
  send(message: unknown): void {
    const command = message as Record<string, unknown>;
    this.sent.push(command);
    queueMicrotask(() => this.onCommand(this, command));
  }
  push(message: unknown): void {
    this.queue.push(message);
  }
  messages(): AsyncIterable<unknown> {
    return this.queue;
  }
  close(options?: PiCloseOptions): void {
    this.closed = true;
    this.closes.push(options);
    this.queue.close();
  }
}

function standard(pi: MemoryPi, command: Record<string, unknown>): void {
  const ok = (data?: unknown) => pi.push({ id: command.id, type: "response", command: command.type, success: true, data });
  if (command.type === "get_state") ok({ sessionFile: "/state/pi/s1.jsonl" });
  else if (command.type === "prompt") {
    ok();
    pi.push({ type: "agent_start" });
    pi.push({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
    pi.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
    pi.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hello" }], stopReason: "stop" };
    pi.push({ type: "message_end", message });
    pi.push({ type: "agent_end", messages: [{ role: "user", content: "q" }, message] });
  } else ok();
}

function spec(partial: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: "memory:dm:ou_owner",
    kind: "conversation",
    profile: { provider: "openai-codex", model: "gpt-6-astra", effort: "low", cwd: "/tmp", fast: true, network: true },
    instructions: "be useful",
    ...partial,
  };
}

function input(text = "hello", extra: Partial<TurnInput> = {}): TurnInput {
  return { turnId: "turn-1", context: "ctx", messages: [{ text }], ...extra };
}

async function collect(runtime: PiRuntime, until: (event: RuntimeEvent) => boolean): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.events()) {
    events.push(event);
    if (until(event)) break;
  }
  return events;
}

const silentLog: PiRuntimeLog = { warn() {}, error() {} };

function memoryRuntime(handler = standard, overrides: Omit<Partial<PiRuntimeOptions>, "spawn"> & { stderr?: string } = {}) {
  const { stderr, ...rest } = overrides;
  const spawned: MemoryPi[] = [];
  const runtime = new PiRuntime({
    sessionDir: "/state/pi",
    fileExists: async (path) => !path.includes("missing"),
    ...rest,
    spawn: (options) => {
      const pi = new MemoryPi(options, handler);
      if (stderr !== undefined) pi.stderr = stderr;
      spawned.push(pi);
      return pi;
    },
  });
  return { runtime, spawned };
}

function extensionArg(args: string[]): string {
  return args[args.indexOf("--extension") + 1] ?? "";
}

/** Unblock a fifo reader, then give up so a missing reader cannot hang the test. */
async function unblockFifo(path: string): Promise<void> {
  const writer = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'export default function () {}\\n')", path], { stdio: "ignore" });
  await Promise.race([
    new Promise((resolve) => writer.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (writer.exitCode === null) writer.kill("SIGKILL");
}

describe("pi args", () => {
  it("passes provider, model, thinking, system prompt, and isolation flags", () => {
    const args = piArgs({ profile: spec().profile, instructions: "sys", provider: "openai-codex", sessionDir: "/s", ephemeral: false });
    expect(args.slice(0, 6)).toEqual(["--mode", "rpc", "--provider", "openai-codex", "--model", "gpt-6-astra"]);
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-extensions");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("sys");
    expect(args[args.indexOf("--thinking") + 1]).toBe("low");
    expect(args[args.indexOf("--session-dir") + 1]).toBe("/s");
    expect(args).not.toContain("--session");
  });

  it("resumes by session path, and check sessions are not saved", () => {
    const resume = piArgs({ profile: spec().profile, instructions: "", provider: "p", sessionDir: "/s", resume: "/s/a.jsonl", ephemeral: false });
    expect(resume[resume.indexOf("--session") + 1]).toBe("/s/a.jsonl");
    const check = piArgs({ profile: spec().profile, instructions: "", provider: "p", sessionDir: "/s", ephemeral: true });
    expect(check).toContain("--no-session");
    expect(check).not.toContain("--session-dir");
  });

  it("loads a tools extension when asked", () => {
    const args = piArgs({
      profile: spec().profile,
      instructions: "sys",
      provider: "openai-codex",
      sessionDir: "/s",
      ephemeral: false,
      toolsExtension: "/ext/front-tools.ext.ts",
    });
    expect(args).toContain("--extension");
    expect(args[args.indexOf("--extension") + 1]).toBe("/ext/front-tools.ext.ts");
    expect(args).toContain("--no-extensions");
  });

  it("requires provider and model", () => {
    expect(() => piArgs({ profile: { model: "m" }, instructions: "", sessionDir: "/s", ephemeral: false })).toThrow(/provider/);
    expect(() => piArgs({ profile: {}, instructions: "", provider: "p", sessionDir: "/s", ephemeral: false })).toThrow(/model/);
  });

  it("maps effort to thinking levels", () => {
    expect(mapThinking("none")).toBe("off");
    expect(mapThinking("xhigh")).toBe("xhigh");
    expect(mapThinking("High")).toBe("high");
    expect(mapThinking("bogus")).toBeUndefined();
    expect(mapThinking(undefined)).toBeUndefined();
  });

  it("puts the seed first and skips messages already in context", () => {
    const text = toPiMessage({ turnId: "t", context: "window", messages: [{ text: "dup", inContext: true }, { text: "new" }] }, "old talk");
    expect(text).toBe(`${SEED_PREFACE}\nold talk\n\nwindow\n\nnew`);
  });
});

describe("jsonl splitter", () => {
  it("splits on LF only and keeps U+2028 inside strings", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":"x\u2028y"}\r\n{"b"')).toEqual([{ a: "x\u2028y" }]);
    expect(splitter.push(":1}\nnot json\n")).toEqual([{ b: 1 }]);
  });
});

describe("PiRuntime", () => {
  it("opens a session, seeds the first turn only, and reports text and tools", async () => {
    const { runtime, spawned } = memoryRuntime();
    const ref = await runtime.open(spec({ seed: { text: "earlier", throughSeq: 3, estimatedTokens: 1 } }));
    expect(ref).toBe("/state/pi/s1.jsonl");
    expect(spawned[0].options.cwd).toBe("/tmp");
    await runtime.start(ref, input("first"));
    const events = await collect(runtime, (event) => event.type === "turn.completed");
    expect(events.map((event) => event.type)).toEqual(["turn.started", "activity", "turn.completed"]);
    expect(events[1]).toMatchObject({ summary: "read: a.ts" });
    expect(events[2]).toMatchObject({ turnId: "turn-1", text: "hello" });
    await runtime.start(ref, input("second", { turnId: "turn-2" }));
    await collect(runtime, (event) => event.type === "turn.completed");
    const prompts = spawned[0].sent.filter((command) => command.type === "prompt").map((command) => String(command.message));
    expect(prompts[0]).toContain(SEED_PREFACE);
    expect(prompts[0]).toContain("earlier");
    expect(prompts[1]).not.toContain(SEED_PREFACE);
    runtime.close();
  });

  it("does not reseed a resumed session", async () => {
    const { runtime, spawned } = memoryRuntime();
    const ref = await runtime.open(spec({ runtimeRef: "/state/pi/s1.jsonl", seed: { text: "earlier", throughSeq: 3, estimatedTokens: 1 } }));
    expect(spawned[0].options.args).toContain("/state/pi/s1.jsonl");
    await runtime.start(ref, input("x"));
    await collect(runtime, (event) => event.type === "turn.completed");
    expect(String(spawned[0].sent.find((command) => command.type === "prompt")?.message)).not.toContain(SEED_PREFACE);
    runtime.close();
  });

  it("passes toolEnv into the pi process for conversation sessions", async () => {
    const { runtime, spawned } = memoryRuntime();
    await runtime.open(spec({ toolEnv: { LARKLING_API_URL: "http://127.0.0.1:1", LARKLING_SESSION_TOKEN: "tok" } }));
    expect(spawned[0].options.env?.LARKLING_API_URL).toBe("http://127.0.0.1:1");
    expect(spawned[0].options.env?.LARKLING_SESSION_TOKEN).toBe("tok");
    expect(spawned[0].options.args).toContain("--extension");
    runtime.close();
  });

  it("skips the front-tools extension for judge sessions", async () => {
    const { runtime, spawned } = memoryRuntime();
    await runtime.open(spec({ kind: "judge" }));
    expect(spawned[0].options.args).not.toContain("--extension");
    runtime.close();
  });

  it("loads the back-tools extension for task sessions", async () => {
    const { runtime, spawned } = memoryRuntime();
    await runtime.open(spec({ kind: "task", sessionId: "task:1", toolEnv: { LARKLING_API_URL: "http://127.0.0.1:1", LARKLING_SESSION_TOKEN: "tok" } }));
    const ext = spawned[0].options.args[spawned[0].options.args.indexOf("--extension") + 1];
    expect(ext).toContain("back-tools.ext.ts");
    expect(spawned[0].options.env?.LARKLING_SESSION_TOKEN).toBe("tok");
    runtime.close();
  });

  it("refuses to resume a missing session file so the core reseeds", async () => {
    const { runtime, spawned } = memoryRuntime();
    await expect(runtime.open(spec({ runtimeRef: "/state/pi/missing.jsonl" }))).rejects.toThrow(/session file missing/);
    expect(spawned).toHaveLength(0);
    runtime.close();
  });

  it("aborts a running turn and reports interrupted", async () => {
    const { runtime, spawned } = memoryRuntime((pi, command) => {
      const ok = () => pi.push({ id: command.id, type: "response", success: true });
      if (command.type === "get_state") pi.push({ id: command.id, type: "response", success: true, data: { sessionFile: "/s/a.jsonl" } });
      else if (command.type === "prompt") {
        ok();
        pi.push({ type: "agent_start" });
      } else if (command.type === "abort") {
        ok();
        pi.push({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
      } else ok();
    });
    const ref = await runtime.open(spec());
    await runtime.start(ref, input());
    await collect(runtime, (event) => event.type === "turn.started");
    await runtime.steer(ref, input("more"));
    expect(spawned[0].sent.some((command) => command.type === "steer" && command.message === "ctx\n\nmore")).toBe(true);
    await runtime.interrupt(ref);
    const events = await collect(runtime, (event) => event.type === "turn.interrupted");
    expect(events.at(-1)?.type).toBe("turn.interrupted");
    await expect(runtime.steer(ref, input())).rejects.toMatchObject({ steerRejected: true });
    runtime.close();
  });

  it("waits for agent_settled across a retry", async () => {
    const { runtime } = memoryRuntime((pi, command) => {
      if (command.type === "get_state") pi.push({ id: command.id, type: "response", success: true, data: { sessionFile: "/s/a.jsonl" } });
      else if (command.type === "prompt") {
        pi.push({ id: command.id, type: "response", success: true, data: { disposition: "started" } });
        pi.push({ type: "agent_start" });
        pi.push({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "529" }], willRetry: true });
        pi.push({ type: "agent_start" });
        pi.push({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "second try" }], stopReason: "stop" }], willRetry: false });
        pi.push({ type: "agent_settled", aborted: false });
      }
    });
    const ref = await runtime.open(spec());
    await runtime.start(ref, input());
    const events = await collect(runtime, (event) => event.type === "turn.completed" || event.type === "turn.failed");
    expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "second try" });
    runtime.close();
  });

  it("completes at once when the prompt is handled without a run", async () => {
    const { runtime } = memoryRuntime((pi, command) => {
      const data = command.type === "get_state" ? { sessionFile: "/s/a.jsonl" } : { disposition: "handled" };
      pi.push({ id: command.id, type: "response", success: true, data });
    });
    const ref = await runtime.open(spec());
    await runtime.start(ref, input());
    const events = await collect(runtime, (event) => event.type === "turn.completed");
    expect(events.at(-1)).toMatchObject({ text: "" });
    runtime.close();
  });

  it("reports provider errors as failed turns", async () => {
    const { runtime } = memoryRuntime((pi, command) => {
      if (command.type === "get_state") pi.push({ id: command.id, type: "response", success: true, data: { sessionFile: "/s/a.jsonl" } });
      else if (command.type === "prompt") {
        pi.push({ id: command.id, type: "response", success: true });
        pi.push({ type: "agent_start" });
        pi.push({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" }] });
      }
    });
    const ref = await runtime.open(spec());
    await runtime.start(ref, input());
    const events = await collect(runtime, (event) => event.type === "turn.failed");
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", error: "529 overloaded", retryable: true });
    runtime.close();
  });

  it("rejects start when pi refuses the prompt", async () => {
    const { runtime } = memoryRuntime((pi, command) => {
      if (command.type === "get_state") pi.push({ id: command.id, type: "response", success: true, data: { sessionFile: "/s/a.jsonl" } });
      else pi.push({ id: command.id, type: "response", success: false, error: "No API key" });
    });
    const ref = await runtime.open(spec());
    await expect(runtime.start(ref, input())).rejects.toThrow(/No API key/);
    runtime.close();
  });

  it("uses ephemeral refs for judge sessions and reports lost processes", async () => {
    const { runtime, spawned } = memoryRuntime();
    const ref = await runtime.open(spec({ kind: "judge" }));
    expect(ref).toMatch(/^ephemeral:/);
    expect(spawned[0].options.args).toContain("--no-session");
    const conv = await runtime.open(spec({ sessionId: "s2" }));
    spawned[1].queue.close();
    const events = await collect(runtime, (event) => event.type === "runtime.lost");
    expect(events.at(-1)).toEqual({ type: "runtime.lost", sessionIds: ["s2"] });
    await expect(runtime.start(conv, input())).rejects.toThrow(/unknown pi session/);
    await runtime.release(ref);
    expect(spawned[0].closed).toBe(true);
    expect(spawned[0].closes.some((options) => options?.force)).toBe(false);
    expect(await runtime.updateInstructions(ref, "x")).toBe("unsupported");
    runtime.close();
  });

  it("asks pi to compact", async () => {
    const { runtime, spawned } = memoryRuntime((pi, command) => {
      const data = command.type === "get_state" ? { sessionFile: "/s/a.jsonl" } : { summary: "short" };
      pi.push({ id: command.id, type: "response", success: true, data });
    });
    const ref = await runtime.open(spec());
    expect(await runtime.compact(ref, "keep decisions")).toBe("short");
    expect(spawned[0].sent.at(-1)).toMatchObject({ type: "compact", customInstructions: "keep decisions" });
    runtime.close();
  });
});

describe("pi extension staging and timeout kill", () => {
  it("copies the extension into stateDir and passes that path to pi", async () => {
    const dir = await tempDir();
    const source = join(dir, "install", "front-tools.ext.ts");
    await mkdir(join(dir, "install"), { recursive: true });
    const body = "export default function fresh() {}\n";
    await writeFile(source, body);
    const { runtime, spawned } = memoryRuntime(standard, { stateDir: dir, sessionDir: join(dir, "sessions"), frontToolsExtension: source });
    await runtime.open(spec());
    const ext = extensionArg(spawned[0].options.args);
    expect(ext).toBe(join(dir, "pi-extensions", "front-tools.ext.ts"));
    expect(await readFile(ext, "utf8")).toBe(body);
    runtime.close();
  });

  it("fails the open without spawning when the install tree read does not finish", async () => {
    const dir = await tempDir();
    const fifo = join(dir, "front-tools.ext.ts");
    execFileSync("mkfifo", [fifo]);
    const logs: string[] = [];
    const { runtime, spawned } = memoryRuntime(standard, {
      stateDir: dir,
      sessionDir: join(dir, "sessions"),
      requestTimeoutMs: 200,
      frontToolsExtension: fifo,
      log: { warn() {}, error: (event) => logs.push(event) },
    });
    try {
      await expect(runtime.open(spec())).rejects.toThrow(`timed out staging pi extension from ${fifo}`);
      expect(spawned).toHaveLength(0);
      expect(logs).toContain("pi.extension_stage_failed");
      const started = Date.now();
      await expect(runtime.open(spec({ sessionId: "s2" }))).rejects.toThrow(/timed out staging/);
      expect(Date.now() - started).toBeLessThan(150);
      expect(spawned).toHaveLength(0);
    } finally {
      await unblockFifo(fifo);
      runtime.close();
    }
  });

  it("reuses the previous staged copy when a later read of the install tree blocks", async () => {
    const dir = await tempDir();
    const fifo = join(dir, "front-tools.ext.ts");
    execFileSync("mkfifo", [fifo]);
    const dest = join(dir, "pi-extensions", "front-tools.ext.ts");
    await mkdir(join(dir, "pi-extensions"), { recursive: true });
    const body = "export default function staged() {}\n";
    await writeFile(dest, body);
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { runtime, spawned } = memoryRuntime(standard, {
      stateDir: dir,
      sessionDir: join(dir, "sessions"),
      requestTimeoutMs: 200,
      frontToolsExtension: fifo,
      log: { warn: (event, fields) => warnings.push({ event, fields }), error() {} },
    });
    try {
      const ref = await runtime.open(spec());
      expect(ref).toBe("/state/pi/s1.jsonl");
      expect(extensionArg(spawned[0].options.args)).toBe(dest);
      expect(await readFile(dest, "utf8")).toBe(body);
      expect(warnings.map((entry) => entry.event)).toContain("pi.extension_stale");
    } finally {
      await unblockFifo(fifo);
      runtime.close();
    }
  });

  it("logs stderr and the staged extension, then SIGKILLs, when get_state times out", async () => {
    const dir = await tempDir();
    const source = join(dir, "install", "front-tools.ext.ts");
    await mkdir(join(dir, "install"), { recursive: true });
    await writeFile(source, "export default function () {}\n");
    const token = "session-token-value";
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { runtime, spawned } = memoryRuntime(() => undefined, {
      stateDir: dir,
      sessionDir: join(dir, "sessions"),
      requestTimeoutMs: 40,
      killGraceMs: 15,
      frontToolsExtension: source,
      stderr: `blocked while reading ${token}`,
      log: { warn() {}, error: (event, fields) => logs.push({ event, fields }) },
    });
    await expect(runtime.open(spec({ toolEnv: { LARKLING_SESSION_TOKEN: token } }))).rejects.toThrow(/pi get_state timed out \(extension .+\/pi-extensions\/front-tools\.ext\.ts\)/);
    expect(spawned[0].closes.some((options) => options?.force === true && options.graceMs === 15)).toBe(true);
    const ext = extensionArg(spawned[0].options.args);
    expect(ext).toBe(join(dir, "pi-extensions", "front-tools.ext.ts"));
    expect(logs).toEqual([
      {
        event: "pi.rpc_timeout",
        fields: {
          command: "get_state",
          extensions: [ext],
          sources: [source],
          stderr: "blocked while reading [redacted]",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(token);
    runtime.close();
  });

  it("force-kills when a later RPC times out", async () => {
    const { runtime, spawned } = memoryRuntime(
      (pi, command) => {
        if (command.type === "get_state") pi.push({ id: command.id, type: "response", success: true, data: { sessionFile: "/s/a.jsonl" } });
      },
      { requestTimeoutMs: 40, killGraceMs: 10, log: silentLog },
    );
    const ref = await runtime.open(spec({ kind: "judge" }));
    await expect(runtime.start(ref, input())).rejects.toThrow(/pi prompt timed out/);
    expect(spawned[0].closes.some((options) => options?.force === true && options.graceMs === 10)).toBe(true);
    runtime.close();
  });
});

describe("StdioPiProcess signals", () => {
  it("stops at SIGTERM when the child exits", async () => {
    const proc = new StdioPiProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    try {
      proc.close();
      await expect(proc.exited).resolves.toMatchObject({ signal: "SIGTERM" });
    } finally {
      proc.close({ force: true, graceMs: 0 });
    }
  });

  it("sends SIGKILL after the grace period when the child ignores SIGTERM", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "signals");
    const proc = new StdioPiProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => require('fs').appendFileSync(process.env.SIGNAL_LOG, 'TERM\\n')); process.stdout.write('{\"ready\":true}\\n'); setInterval(() => {}, 1000)",
      ],
      env: { ...process.env, SIGNAL_LOG: logPath },
    });
    try {
      await expect(proc.messages()[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: { ready: true } });
      proc.close({ force: true, graceMs: 200 });
      await expect(proc.exited).resolves.toMatchObject({ signal: "SIGKILL" });
      expect(await readFile(logPath, "utf8")).toBe("TERM\n");
    } finally {
      proc.close({ force: true, graceMs: 0 });
    }
  });
});

describe("PiRuntime over a fake pi process", () => {
  it("runs a turn end to end over stdio", async () => {
    const dir = await tempDir();
    const logPath = join(dir, "pi.log");
    const runtime = new PiRuntime({
      command: process.execPath,
      args: [],
      sessionDir: join(dir, "sessions"),
      stateDir: dir,
      provider: "openai-codex",
      env: { ...process.env, FAKE_PI_LOG: logPath },
      spawn: (options) => new StdioPiProcess({ ...options, args: [FAKE, ...options.args] }),
    });
    const ref = await runtime.open(spec({ profile: { ...spec().profile, provider: undefined, cwd: dir } }));
    expect(ref.startsWith(join(dir, "sessions"))).toBe(true);
    await runtime.start(ref, input("say 12345"));
    const events = await collect(runtime, (event) => event.type === "turn.completed" || event.type === "turn.failed");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", text: "echo\u202812345" });
    expect(events.some((event) => event.type === "activity" && event.summary === "bash: echo hi")).toBe(true);
    await runtime.start(ref, input("please fail", { turnId: "turn-2" }));
    const failed = await collect(runtime, (event) => event.type === "turn.failed");
    expect(failed.at(-1)).toMatchObject({ retryable: true });
    await runtime.release(ref);
    const first = JSON.parse((await readFile(logPath, "utf8")).split("\n")[0]) as { argv: string[]; cwd: string };
    expect(first.argv).toContain("--provider");
    expect(first.argv[first.argv.indexOf("--provider") + 1]).toBe("openai-codex");
    const ext = extensionArg(first.argv);
    expect(ext).toBe(join(dir, "pi-extensions", "front-tools.ext.ts"));
    const source = fileURLToPath(new URL("../src/runtimes/pi/front-tools.ext.ts", import.meta.url));
    expect(await readFile(ext, "utf8")).toBe(await readFile(source, "utf8"));
    expect(await realpath(first.cwd!)).toBe(await realpath(dir));
    runtime.close();
  });
});
