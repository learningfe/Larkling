import { appendLine } from "./util/fs.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(
    private readonly file: string | undefined,
    private readonly level: LogLevel = "info",
  ) {}

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", event, fields);
  }
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }
  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }
  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (RANK[level] < RANK[this.level]) return;
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
    if (this.file) {
      void appendLine(this.file, line).catch(() => {
        // Logging must not break the process.
      });
    }
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }
}
