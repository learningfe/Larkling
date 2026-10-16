/**
 * Shared HTTP helpers for agent tools (front and back).
 * Pi extensions call the same routes via env-injected URL/token.
 * Codex dynamicTools and pi extensions both call these helpers.
 */

export type AgentToolHttpResult = { status: number; text: string };

export async function taskStartRequest(
  apiUrl: string,
  token: string,
  body: { body: string; followUpEnabled?: boolean },
): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/task/start", body);
}

export async function taskCancelRequest(apiUrl: string, token: string, taskId: string): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/task/cancel", { taskId });
}

export async function taskUpdateRequest(
  apiUrl: string,
  token: string,
  body: { taskId: string; version: number; body: string; followUpEnabled: boolean },
): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/task/update", body);
}

/** Complete a step: write body via task/update and turn follow-up off unless followUpEnabled is true. */
export async function taskCompleteRequest(
  apiUrl: string,
  token: string,
  body: { taskId: string; version: number; body: string; followUpEnabled?: boolean },
): Promise<AgentToolHttpResult> {
  return taskUpdateRequest(apiUrl, token, {
    taskId: body.taskId,
    version: body.version,
    body: body.body,
    followUpEnabled: body.followUpEnabled ?? false,
  });
}

export async function taskGetRequest(apiUrl: string, token: string, taskId: string): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/task/get", { taskId });
}

export async function imHistoryRequest(
  apiUrl: string,
  token: string,
  body: { container: string; start?: string; end?: string; limit?: number },
): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/im/history", body);
}

export async function imFileRequest(apiUrl: string, token: string, body: { messageId: string; key: string }): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/im/file", body);
}

export async function personLookupRequest(
  apiUrl: string,
  token: string,
  body: { openId?: string; query?: string; scope?: "current" | "all" },
): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/person/lookup", body);
}

export async function groupLookupRequest(
  apiUrl: string,
  token: string,
  body: { chatId?: string; query?: string; includeMembers?: boolean },
): Promise<AgentToolHttpResult> {
  return post(apiUrl, token, "/v1/group/lookup", body);
}

async function post(apiUrl: string, token: string, path: string, body: Record<string, unknown>): Promise<AgentToolHttpResult> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}
