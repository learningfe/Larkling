import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TaskRecord } from "../protocol/types.js";
import { ApiError } from "../core/errors.js";

export interface ApiHandlers {
  taskStart(token: string, body: { body: string; followUpEnabled?: boolean }): Promise<TaskRecord>;
  taskContinue(token: string, body: { taskId: string; message: string }): Promise<TaskRecord>;
  taskUpdate(token: string, body: { taskId: string; version: number; body: string; followUpEnabled: boolean }): Promise<TaskRecord>;
  taskGet(token: string, taskId: string): Promise<unknown>;
  taskList(token: string): Promise<unknown>;
  taskCancel(token: string, taskId: string): Promise<TaskRecord>;
  imHistory(token: string, body: { container: string; start?: string; end?: string; limit?: number }): Promise<unknown>;
  imFile(token: string, body: { messageId: string; key: string }): Promise<unknown>;
  imWho(token: string, body: { name: string }): Promise<unknown>;
}

export async function listenApi(handlers: ApiHandlers): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res, handlers);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("api failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, handlers: ApiHandlers): Promise<void> {
  try {
    const token = bearer(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    let payload: unknown;
    switch (route) {
      case "POST /v1/task/start":
        payload = await handlers.taskStart(token, body as { body: string; followUpEnabled?: boolean });
        break;
      case "POST /v1/task/continue":
        payload = await handlers.taskContinue(token, body as { taskId: string; message: string });
        break;
      case "POST /v1/task/update":
        payload = await handlers.taskUpdate(token, body as { taskId: string; version: number; body: string; followUpEnabled: boolean });
        break;
      case "POST /v1/task/get":
        payload = await handlers.taskGet(token, String((body as { taskId?: string }).taskId ?? ""));
        break;
      case "POST /v1/task/list":
        payload = await handlers.taskList(token);
        break;
      case "POST /v1/task/cancel":
        payload = await handlers.taskCancel(token, String((body as { taskId?: string }).taskId ?? ""));
        break;
      case "POST /v1/im/history":
        payload = await handlers.imHistory(token, body as { container: string; start?: string; end?: string; limit?: number });
        break;
      case "POST /v1/im/file":
        payload = await handlers.imFile(token, body as { messageId: string; key: string });
        break;
      case "POST /v1/im/who":
        payload = await handlers.imWho(token, body as { name: string });
        break;
      default:
        throw new ApiError("NOT_FOUND", "unknown route", 404);
    }
    send(res, 200, payload);
  } catch (error) {
    if (error instanceof ApiError) send(res, error.status, { error: { code: error.code, message: error.message } });
    else send(res, 500, { error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
  }
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new ApiError("UNAUTHORIZED", "missing bearer token", 401);
  return match[1];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("BAD_REQUEST", "body must be JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}
