import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncQueue } from "../../util/async-queue.js";

/** SIGTERM does not unblock a read stuck in the kernel; SIGKILL does. */
export const PI_KILL_GRACE_MS = 1_000;

export interface PiCloseOptions {
  /** After SIGTERM, send SIGKILL if the child is still alive when the grace period ends. */
  force?: boolean;
  graceMs?: number;
}

/** One `pi --mode rpc` process. Messages are JSON objects, one per LF-terminated line. */
export interface PiProcess {
  send(message: unknown): void;
  messages(): AsyncIterable<unknown>;
  /** Tail of child stderr, when the process records it. */
  stderr?: string;
  close(options?: PiCloseOptions): void;
}

export interface PiSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type PiProcessFactory = (options: PiSpawnOptions) => PiProcess;

/**
 * Splits stdout on LF only, as pi's RPC docs require.
 * Node readline is not used because it also splits on U+2028 and U+2029.
 */
export class JsonlSplitter {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return out;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as unknown);
      } catch {
        // Ignore non-JSON lines; pi may print warnings.
      }
    }
  }
}

export class StdioPiProcess implements PiProcess {
  private readonly queue = new AsyncQueue<unknown>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly splitter = new JsonlSplitter();
  private killTimer?: ReturnType<typeof setTimeout>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr = "";

  constructor(options: PiSpawnOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => resolve({ code, signal }));
      this.child.on("error", () => resolve({ code: null, signal: null }));
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      for (const message of this.splitter.push(chunk)) this.queue.push(message);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      // Keep only the tail for health and error messages.
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.stdin.on("error", () => undefined);
    this.child.on("exit", () => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = undefined;
      this.queue.close();
    });
    this.child.on("error", () => this.queue.close());
  }

  send(message: unknown): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  messages(): AsyncIterable<unknown> {
    return this.queue;
  }

  close(options?: PiCloseOptions): void {
    this.terminate(options);
    this.queue.close();
  }

  private terminate(options?: PiCloseOptions): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }
    if (!options?.force || this.killTimer) return;
    const graceMs = options.graceMs ?? PI_KILL_GRACE_MS;
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      try {
        this.child.kill("SIGKILL");
      } catch {
        // The child exited between the check and the signal.
      }
    }, graceMs);
    this.killTimer.unref?.();
  }
}

export const spawnPi: PiProcessFactory = (options) => new StdioPiProcess(options);
