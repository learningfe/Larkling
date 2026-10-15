export interface FeishuResponse {
  status: number;
  json?: {
    code?: number;
    msg?: string;
    bot?: { open_id?: string; app_name?: string };
    data?: Record<string, unknown> & { recognition_text?: string; open_id?: string; app_name?: string };
  };
  body?: Buffer;
}

export interface FeishuHttp {
  request(input: {
    method: string;
    path: string;
    query?: Record<string, string | undefined>;
    json?: unknown;
  }): Promise<FeishuResponse>;
}

interface TokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

/** Tenant-token REST client. Long-connection events do not go through here. */
export class FetchFeishuHttp implements FeishuHttp {
  private token = "";
  private tokenUntil = 0;

  constructor(
    private readonly options: { appId: string; appSecret: string; domain?: string; fetchImpl?: typeof fetch; now?: () => number },
  ) {}

  async request(input: { method: string; path: string; query?: Record<string, string | undefined>; json?: unknown }): Promise<FeishuResponse> {
    const token = await this.tenantToken();
    const domain = this.options.domain ?? "https://open.feishu.cn";
    const url = new URL(input.path, domain);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(input.json ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      body: input.json ? JSON.stringify(input.json) : undefined,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || (buffer.length && buffer[0] === 0x7b)) {
      try {
        return { status: response.status, json: JSON.parse(buffer.toString("utf8")) as FeishuResponse["json"], body: buffer };
      } catch {
        return { status: response.status, body: buffer };
      }
    }
    return { status: response.status, body: buffer };
  }

  private async tenantToken(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.token && now < this.tokenUntil) return this.token;
    const domain = this.options.domain ?? "https://open.feishu.cn";
    const response = await (this.options.fetchImpl ?? fetch)(new URL("/open-apis/auth/v3/tenant_access_token/internal", domain), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
    });
    const payload = (await response.json()) as TokenResponse;
    if (!payload.tenant_access_token) throw new Error(payload.msg || "tenant_access_token was not returned");
    this.token = payload.tenant_access_token;
    this.tokenUntil = now + Math.max(30, (payload.expire ?? 7200) - 60) * 1000;
    return this.token;
  }
}
