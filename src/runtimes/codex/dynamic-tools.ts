/**
 * Codex app-server dynamicTools for Larkling agent HTTP helpers.
 * Specs are registered on thread/start; calls arrive as item/tool/call.
 */
import {
  groupLookupRequest,
  imFileRequest,
  imHistoryRequest,
  personLookupRequest,
  taskCancelRequest,
  taskCompleteRequest,
  taskGetRequest,
  taskStartRequest,
  taskUpdateRequest,
} from "../../tasks/agent-tools.js";

export type DynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

export const FRONT_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: "function",
    name: "task_start",
    description: "Start a background task. Returns the new task id. Still write the user-facing confirmation yourself.",
    inputSchema: {
      type: "object",
      properties: {
        body: str("Task body: goal / current progress / next step / recent notes"),
        followUp: bool("Enable follow-up checks (default true)"),
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_cancel",
    description: "Cancel a running background task by taskId.",
    inputSchema: {
      type: "object",
      properties: { taskId: str("Id of the task to cancel") },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

export const BACK_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: "function",
    name: "task_update",
    description: "Update the task body and follow-up flag. Pass the current version.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: str("Task id"),
        version: num("Current task version from context"),
        body: str("Updated task body"),
        followUp: bool("Whether follow-up checks stay on"),
      },
      required: ["taskId", "version", "body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_complete",
    description: "Finish this step: write the final body and turn follow-up off unless followUp is true.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: str("Task id"),
        version: num("Current task version from context"),
        body: str("Final task body for this step"),
        followUp: bool("Keep follow-up on (default false)"),
      },
      required: ["taskId", "version", "body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_get",
    description: "Read the current task record (body, version, status, follow-up).",
    inputSchema: {
      type: "object",
      properties: { taskId: str("Task id") },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "im_history",
    description: "Read messages from a parent chat or topic container.",
    inputSchema: {
      type: "object",
      properties: {
        container: str("Container id (parent chat or topic)"),
        start: str("Start message id"),
        end: str("End message id"),
        limit: num("Max messages"),
      },
      required: ["container"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "im_file",
    description: "Fetch a file attachment from a message.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: str("Message id"),
        key: str("File key"),
      },
      required: ["messageId", "key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "person_lookup",
    description: "Look up a person by open_id or part of a display name.",
    inputSchema: {
      type: "object",
      properties: {
        openId: str("Exact open_id (ou_...)"),
        query: str("Part of a display name"),
        scope: { type: "string", enum: ["current", "all"], description: "Where to search by name; default current" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "group_lookup",
    description: "Look up a group by chat_id or part of a group name.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: str("Exact chat_id (oc_...)"),
        query: str("Part of a group name"),
        includeMembers: bool("Also list members"),
      },
      additionalProperties: false,
    },
  },
];

export function dynamicToolsForKind(kind: string): DynamicToolSpec[] | undefined {
  if (kind === "conversation") return FRONT_DYNAMIC_TOOLS;
  if (kind === "task") return BACK_DYNAMIC_TOOLS;
  return undefined;
}

type ToolEnv = { apiUrl: string; token: string };

export async function runDynamicTool(
  tool: string,
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }> {
  const result = await dispatch(tool, args, env);
  const success = result.status >= 200 && result.status < 300;
  return {
    contentItems: [{ type: "inputText", text: result.text || (success ? "ok" : `HTTP ${result.status}`) }],
    success,
  };
}

async function dispatch(tool: string, args: Record<string, unknown>, env: ToolEnv) {
  const { apiUrl, token } = env;
  switch (tool) {
    case "task_start":
      return taskStartRequest(apiUrl, token, {
        body: String(args.body ?? ""),
        followUpEnabled: args.followUp === undefined ? undefined : Boolean(args.followUp),
      });
    case "task_cancel":
      return taskCancelRequest(apiUrl, token, String(args.taskId ?? ""));
    case "task_update":
      return taskUpdateRequest(apiUrl, token, {
        taskId: String(args.taskId ?? ""),
        version: Number(args.version),
        body: String(args.body ?? ""),
        followUpEnabled: args.followUp === undefined ? true : Boolean(args.followUp),
      });
    case "task_complete":
      return taskCompleteRequest(apiUrl, token, {
        taskId: String(args.taskId ?? ""),
        version: Number(args.version),
        body: String(args.body ?? ""),
        followUpEnabled: args.followUp === undefined ? undefined : Boolean(args.followUp),
      });
    case "task_get":
      return taskGetRequest(apiUrl, token, String(args.taskId ?? ""));
    case "im_history":
      return imHistoryRequest(apiUrl, token, {
        container: String(args.container ?? ""),
        start: args.start === undefined ? undefined : String(args.start),
        end: args.end === undefined ? undefined : String(args.end),
        limit: args.limit === undefined ? undefined : Number(args.limit),
      });
    case "im_file":
      return imFileRequest(apiUrl, token, {
        messageId: String(args.messageId ?? ""),
        key: String(args.key ?? ""),
      });
    case "person_lookup":
      return personLookupRequest(apiUrl, token, {
        openId: args.openId === undefined ? undefined : String(args.openId),
        query: args.query === undefined ? undefined : String(args.query),
        scope: args.scope === "all" || args.scope === "current" ? args.scope : undefined,
      });
    case "group_lookup":
      return groupLookupRequest(apiUrl, token, {
        chatId: args.chatId === undefined ? undefined : String(args.chatId),
        query: args.query === undefined ? undefined : String(args.query),
        includeMembers: args.includeMembers === undefined ? undefined : Boolean(args.includeMembers),
      });
    default:
      return { status: 404, text: `unknown dynamic tool: ${tool}` };
  }
}
