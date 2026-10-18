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

const taskUpdate = defineTool({
  name: "task_update",
  label: "Update task",
  description:
    "Partial task update. Pass the current version; the API bumps it. Only fields you send change: body, followUp, and audience (own / drive / track). Omit a field to keep it. Omitted audience roles stay as they are.",
  promptSnippet: "Update the task body or audience after each step",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
    version: Type.Number({ description: "Current task version from context" }),
    body: Type.Optional(Type.String({ description: "Updated task body. Omit to keep the current body." })),
    followUp: Type.Optional(Type.Boolean({ description: "Whether follow-up checks stay on. Omit to leave unchanged." })),
    audience: audienceParam,
  }),
  async execute(_id, params) {
    const payload: Record<string, unknown> = { taskId: params.taskId, version: params.version };
    if (params.body !== undefined) payload.body = params.body;
    if (params.followUp !== undefined) payload.followUpEnabled = params.followUp;
    if (params.audience !== undefined) payload.audience = params.audience;
    const result = await post("/v1/task/update", payload);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskComplete = defineTool({
  name: "task_complete",
  label: "Complete task step",
  description:
    "Finish this turn's work: write the final body for this step via the task update API and turn follow-up off unless followUp is true. Pass audience when the roles changed. Then end your turn.",
  promptSnippet: "Write the final body for this step and turn follow-up off",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task id" }),
    version: Type.Number({ description: "Current task version from context" }),
    body: Type.String({ description: "Final task body for this step" }),
    followUp: Type.Optional(Type.Boolean({ description: "Keep follow-up on (default false)" })),
    audience: audienceParam,
  }),
  async execute(_id, params) {
    const payload: Record<string, unknown> = {
      taskId: params.taskId,
      version: params.version,
      body: params.body,
      followUpEnabled: params.followUp ?? false,
    };
    if (params.audience !== undefined) payload.audience = params.audience;
    const result = await post("/v1/task/update", payload);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const taskGet = defineTool({
  name: "task_get",
  label: "Get task",
  description: "Read the current task record (audience, body, version, status, follow-up).",
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

const personLookup = defineTool({
  name: "person_lookup",
  label: "Look up a person",
  description:
    "Find a person. Pass openId for an exact lookup, or query to match part of a display name. scope 'current' (default) searches the task's group; 'all' searches every known group. Returns {matches:[{openId,name,groups,match}], source}. Current-group matches come first.",
  promptSnippet: "Find a person by open_id or name",
  parameters: Type.Object({
    openId: Type.Optional(Type.String({ description: "Exact open_id (ou_...)" })),
    query: Type.Optional(Type.String({ description: "Part of a display name" })),
    scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("all")], { description: "Where to search by name; default current" })),
  }),
  async execute(_id, params) {
    const body: Record<string, unknown> = {};
    if (params.openId) body.openId = params.openId;
    if (params.query) body.query = params.query;
    if (params.scope) body.scope = params.scope;
    const result = await post("/v1/person/lookup", body);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

const groupLookup = defineTool({
  name: "group_lookup",
  label: "Look up a group",
  description:
    "Find a group chat. Pass chatId for an exact lookup, or query to match part of a group name. Set includeMembers to list each matched group's members. Returns {matches:[{chatId,name,match,members?}], source}.",
  promptSnippet: "Find a group by chat_id or name",
  parameters: Type.Object({
    chatId: Type.Optional(Type.String({ description: "Exact chat_id (oc_...)" })),
    query: Type.Optional(Type.String({ description: "Part of a group name" })),
    includeMembers: Type.Optional(Type.Boolean({ description: "Also list members" })),
  }),
  async execute(_id, params) {
    const body: Record<string, unknown> = {};
    if (params.chatId) body.chatId = params.chatId;
    if (params.query) body.query = params.query;
    if (params.includeMembers) body.includeMembers = true;
    const result = await post("/v1/group/lookup", body);
    return { content: [{ type: "text", text: result.text }], details: { ok: result.ok } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(taskUpdate);
  pi.registerTool(taskComplete);
  pi.registerTool(taskGet);
  pi.registerTool(imHistory);
  pi.registerTool(imFile);
  pi.registerTool(personLookup);
  pi.registerTool(groupLookup);
}
