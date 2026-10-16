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

const taskStart = defineTool({
  name: "task_start",
  label: "Start background task",
  description:
    "Start background research or multi-step work. Pass the task body (goal / current progress / next step / recent notes). Returns the new taskId. After calling, still write the user-visible confirmation yourself.",
  promptSnippet: "Start background research or multi-step work",
  parameters: Type.Object({
    body: Type.String({ description: "Task body: goal / current progress / next step / recent notes" }),
    followUp: Type.Optional(Type.Boolean({ description: "Enable follow-up checks (default true)" })),
  }),
  async execute(_toolCallId, params) {
    const payload: Record<string, unknown> = { body: params.body };
    if (params.followUp !== undefined) payload.followUpEnabled = params.followUp;
    const result = await post("/v1/task/start", payload);
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
  pi.registerTool(taskCancel);
}
