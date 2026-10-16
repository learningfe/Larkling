import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncQueue } from "../../util/async-queue.js";

export interface CodexTransport {
  send(message: unknown): void;
  messages(): AsyncIterable<unknown>;
  close(): void;
}

/** Newline-delimited JSON over stdin/stdout, as spoken by `codex app-server`. */
export class StdioCodexTransport implements CodexTransport {
  private readonly queue = new AsyncQueue<unknown>();
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("exit", () => this.queue.close());
    this.child.on("error", () => this.queue.close());
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  messages(): AsyncIterable<unknown> {
    return this.queue;
  }

  close(): void {
    this.child.kill();
    this.queue.close();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.queue.push(JSON.parse(line) as unknown);
      } catch {
        // Ignore non-JSON log lines a local binary might write.
      }
    }
  }
}

/** In-memory transport used by adapter tests. */
export class MemoryCodexTransport implements CodexTransport {
  readonly sent: unknown[] = [];
  private readonly queue = new AsyncQueue<unknown>();

  send(message: unknown): void {
    this.sent.push(message);
  }

  push(message: unknown): void {
    this.queue.push(message);
  }

  messages(): AsyncIterable<unknown> {
    return this.queue;
  }

  close(): void {
    this.queue.close();
  }
}
