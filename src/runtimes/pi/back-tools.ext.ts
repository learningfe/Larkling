/**
 * Larkling back tools for pi. Loaded with `pi -e` (works with --no-extensions).
 * Reads LARKLING_API_URL and LARKLING_SESSION_TOKEN from the environment.
 * Routes match src/tasks/agent-tools.ts so Codex can reuse the same HTTP later.
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

const taskUpdate = defineTool({
  name: "task_update",
  label: "Update task body",
  description:
    "Write the task body back (goal / current progress / next step / recent notes). Pass the current version; the API bumps it. Use after each step so work can resume after an interruption.",
  promptSnippet: "Update the task body after each step",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
    version: Type.Number({ description: "Current task version from context" }),
    body: Type.String({ description: "Updated task body" }),
    followUp: Type.Optional(Type.Boolean({ description: "Whether follow-up checks stay on" })),
  }),
  async execute(_id, params) {
    const result = await post("/v1/task/update", {
      taskId: params.taskId,
      version: params.version,
      body: params.body,
      followUpEnabled: params.followUp ?? true,
    });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskComplete = defineTool({
  name: "task_complete",
  label: "Complete task step",
  description:
    "Finish this turn's work: write the final body for this step via the task update API and turn follow-up off unless followUp is true. Then end your turn.",
  promptSnippet: "Write the final body for this step and turn follow-up off",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
    version: Type.Number({ description: "Current task version from context" }),
    body: Type.String({ description: "Final task body for this step" }),
    followUp: Type.Optional(Type.Boolean({ description: "Keep follow-up on (default false)" })),
  }),
  async execute(_id, params) {
    const result = await post("/v1/task/update", {
      taskId: params.taskId,
      version: params.version,
      body: params.body,
      followUpEnabled: params.followUp ?? false,
    });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskGet = defineTool({
  name: "task_get",
  label: "Get task",
  description: "Read the current task record (body, version, status, follow-up).",
  promptSnippet: "Read the current task",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
  }),
  async execute(_id, params) {
    const result = await post("/v1/task/get", { taskId: params.taskId });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const imHistory = defineTool({
  name: "im_history",
  label: "Read IM history",
  description: "Read messages from a parent chat or topic container.",
  promptSnippet: "Read parent conversation history",
  parameters: Type.Object({
    container: Type.String({ description: "Container id (parent chat or topic)" }),
    start: Type.Optional(Type.String({ description: "Start message id" })),
    end: Type.Optional(Type.String({ description: "End message id" })),
    limit: Type.Optional(Type.Number({ description: "Max messages" })),
  }),
  async execute(_id, params) {
    const body: Record<string, unknown> = { container: params.container };
    if (params.start) body.start = params.start;
    if (params.end) body.end = params.end;
    if (params.limit !== undefined) body.limit = params.limit;
    const result = await post("/v1/im/history", body);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const imFile = defineTool({
  name: "im_file",
  label: "Fetch IM file",
  description: "Fetch a file attachment from a message.",
  promptSnippet: "Fetch a file from a message",
  parameters: Type.Object({
    messageId: Type.String({ description: "Message id" }),
    key: Type.String({ description: "File key" }),
  }),
  async execute(_id, params) {
    const result = await post("/v1/im/file", { messageId: params.messageId, key: params.key });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const imWho = defineTool({
  name: "im_who",
  label: "Look up a name",
  description: "Look up a person by display name.",
  promptSnippet: "Look up a person by name",
  parameters: Type.Object({
    name: Type.String({ description: "Display name to look up" }),
  }),
  async execute(_id, params) {
    const result = await post("/v1/im/who", { name: params.name });
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(taskUpdate);
  pi.registerTool(taskComplete);
  pi.registerTool(taskGet);
  pi.registerTool(imHistory);
  pi.registerTool(imFile);
  pi.registerTool(imWho);
}
