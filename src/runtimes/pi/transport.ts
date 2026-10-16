import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncQueue } from "../../util/async-queue.js";

/** One `pi --mode rpc` process. Messages are JSON objects, one per LF-terminated line. */
export interface PiProcess {
  send(message: unknown): void;
  messages(): AsyncIterable<unknown>;
  close(): void;
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
  stderr = "";

  constructor(options: PiSpawnOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
    this.child.on("exit", () => this.queue.close());
    this.child.on("error", () => this.queue.close());
  }

  send(message: unknown): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  messages(): AsyncIterable<unknown> {
    return this.queue;
  }

  close(): void {
    this.child.kill();
    this.queue.close();
  }
}

export const spawnPi: PiProcessFactory = (options) => new StdioPiProcess(options);
