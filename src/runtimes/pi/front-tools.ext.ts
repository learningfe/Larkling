/**
 * Larkling front tools for pi. Loaded with `pi -e` (still works with --no-extensions).
 * Reads LARKLING_API_URL and LARKLING_SESSION_TOKEN from the environment;
 * the harness sets both when it starts the process.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const api = process.env.LARKLING_API_URL;
  const token = process.env.LARKLING_SESSION_TOKEN;
  if (!api || !token) {
    return { ok: false, text: "Larkling task API is not configured for this session." };
  }
  try {
    const response = await fetch(`${api.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { ok: response.ok, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

const personRef = Type.Object({
  openId: Type.String({ description: "Feishu open_id (ou_...)" }),
  name: Type.String({ description: "Display name" }),
});

const audienceParam = Type.Optional(
  Type.Object({
    own: Type.Optional(Type.Array(personRef)),
    drive: Type.Optional(Type.Array(personRef)),
    track: Type.Optional(Type.Array(personRef)),
  }),
);

const taskStart = defineTool({
  name: "task_start",
  label: "Start background task",
  description:
    "Start background research or multi-step work. Pass the task body (goal / current progress / next step / recent notes) and, when you already know them, the audience (own / drive / track). Omit audience to leave it empty. Returns the new taskId. After calling, still write the user-visible confirmation yourself.",
  promptSnippet: "Start background research or multi-step work",
  parameters: Type.Object({
    body: Type.String({ description: "Task body: goal / current progress / next step / recent notes" }),
    followUp: Type.Optional(Type.Boolean({ description: "Enable follow-up checks (default true)" })),
    audience: audienceParam,
  }),
  async execute(_toolCallId, params) {
    const payload: Record<string, unknown> = { body: params.body };
    if (params.followUp !== undefined) payload.followUpEnabled = params.followUp;
    if (params.audience !== undefined) payload.audience = params.audience;
    const result = await post("/v1/task/start", payload);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskUpdate = defineTool({
  name: "task_update",
  label: "Update task audience",
  description:
    "Partial task update. Pass version. Send audience to change Own / Drive / Track; omit body and followUp to keep them. Omitted audience roles stay as they are.",
  promptSnippet: "Revise a task audience without rewriting the body",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
    version: Type.Number({ description: "Current task version" }),
    body: Type.Optional(Type.String({ description: "Updated task body. Omit to keep the current body." })),
    followUp: Type.Optional(Type.Boolean({ description: "Whether follow-up checks stay on. Omit to leave unchanged." })),
    audience: audienceParam,
  }),
  async execute(_toolCallId, params) {
    const payload: Record<string, unknown> = { taskId: params.taskId, version: params.version };
    if (params.body !== undefined) payload.body = params.body;
    if (params.followUp !== undefined) payload.followUpEnabled = params.followUp;
    if (params.audience !== undefined) payload.audience = params.audience;
    const result = await post("/v1/task/update", payload);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskGet = defineTool({
  name: "task_get",
  label: "Get task",
  description: "Read a task record, including audience (own, drive, track), body, version, status, and follow-up.",
  promptSnippet: "Read the current task, including audience",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
  }),
  async execute(_toolCallId, params) {
    const result = await post("/v1/task/get", { taskId: params.taskId });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskCancel = defineTool({
  name: "task_cancel",
  label: "Cancel background task",
  description: "Cancel a running background task by taskId.",
  promptSnippet: "Cancel a running background task",
  parameters: Type.Object({
    taskId: Type.String({ description: "Id of the task to cancel" }),
  }),
  async execute(_toolCallId, params) {
    const result = await post("/v1/task/cancel", { taskId: params.taskId });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(taskStart);
  pi.registerTool(taskUpdate);
  pi.registerTool(taskGet);
  pi.registerTool(taskCancel);
}
