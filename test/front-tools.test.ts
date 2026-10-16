import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { taskCancelRequest, taskCompleteRequest, taskStartRequest, taskUpdateRequest } from "../src/tasks/agent-tools.js";

describe("agent task HTTP helpers", () => {
  it("posts start, cancel, update, and complete with the bearer token", async () => {
    const seen: { path?: string; auth?: string; body?: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => {
        seen.push({ path: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ taskId: "t1", status: "running", version: 2 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const url = `http://127.0.0.1:${address.port}`;
    const started = await taskStartRequest(url, "tok", { body: "goal", followUpEnabled: true });
    expect(started.status).toBe(200);
    const cancelled = await taskCancelRequest(url, "tok", "t1");
    expect(cancelled.status).toBe(200);
    const updated = await taskUpdateRequest(url, "tok", { taskId: "t1", version: 1, body: "next", followUpEnabled: true });
    expect(updated.status).toBe(200);
    const completed = await taskCompleteRequest(url, "tok", { taskId: "t1", version: 2, body: "done" });
    expect(completed.status).toBe(200);
    server.close();
    expect(seen[0]).toMatchObject({ path: "/v1/task/start", auth: "Bearer tok" });
    expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ body: "goal", followUpEnabled: true });
    expect(seen[1]).toMatchObject({ path: "/v1/task/cancel", auth: "Bearer tok" });
    expect(JSON.parse(seen[1].body ?? "{}")).toEqual({ taskId: "t1" });
    expect(JSON.parse(seen[2].body ?? "{}")).toMatchObject({ taskId: "t1", version: 1, followUpEnabled: true });
    expect(seen[3].path).toBe("/v1/task/update");
    expect(JSON.parse(seen[3].body ?? "{}")).toMatchObject({ followUpEnabled: false, body: "done" });
  });
});
