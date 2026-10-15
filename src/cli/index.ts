#!/usr/bin/env node
import { homedir } from "node:os";
import { configJsonSchema, defaultConfigPath, loadConfig, type LarklingConfig } from "../config.js";
import { createHost } from "../core/host.js";
import { FeishuChannel, loadBotOpenId } from "../channels/feishu/adapter.js";
import { FetchFeishuHttp } from "../channels/feishu/http.js";
import { startFeishuSocket } from "../channels/feishu/ws.js";
import { MemoryChannel } from "../channels/memory.js";
import { CodexRuntime } from "../runtimes/codex/adapter.js";
import { createDshRuntime } from "../runtimes/dsh/index.js";
import { createPiRuntime } from "../runtimes/pi/index.js";
import { StateStore } from "../core/state.js";
import type { RuntimeAdapter } from "../protocol/types.js";

const args = process.argv.slice(2);
const command = args[0];

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  switch (command) {
    case "start":
      return start(flag("--config"));
    case "status":
      return status(flag("--config"));
    case "doctor":
      return doctor(flag("--config"));
    case "service":
      return service(args[1], flag("--config"));
    case "config":
      return configCommand(args[1], flag("--config"));
    case "task":
      return taskCommand(args[1]);
    case "im":
      return imCommand(args[1]);
    default:
      process.stdout.write(usage());
  }
}

function usage(): string {
  return `larkling <start|status|doctor|service|config|task|im>

  start [--config file]      启动一个 bot 进程
  status [--config file]     查看会话与任务
  doctor [--config file]     检查配置、文件和适配器健康
  service print systemd|launchd
  config validate|schema|print [--config file]
  task start|continue|update|get|list|cancel
  im history|file|who
`;
}

async function start(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath ?? defaultConfigPath());
  const channel = await buildChannel(config);
  const runtimes = buildRuntimes(config);
  const host = await createHost({ config, channel, runtimes, timers: true });
  await host.start();
  if (config.channel.kind === "feishu" && channel instanceof FeishuChannel) {
    await startFeishuSocket({ appId: config.channel.appId, appSecret: config.channel.appSecret, channel });
  }
  process.stdout.write(`larkling listening ${host.apiUrl}\n`);
  await new Promise<void>((resolvePromise) => {
    const shutdown = () => {
      void host.stop().finally(() => resolvePromise());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function status(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath ?? defaultConfigPath());
  const state = await StateStore.open(config.stateDir);
  const snapshot = state.get();
  const sessions = Object.values(snapshot.sessions).map((session) => ({
    sessionId: session.sessionId,
    kind: session.kind,
    phase: session.phase,
    runtime: session.runtimeName,
    queue: session.queue.length,
    live: session.live,
  }));
  const tasks = Object.values(snapshot.tasks).map((task) => ({
    taskId: task.taskId,
    status: task.status,
    followUpEnabled: task.followUpEnabled,
    version: task.version,
    pendingEvent: task.pendingEvent?.reason,
  }));
  const approvals = Object.values(snapshot.approvals).filter((approval) => approval.status === "pending").length;
  process.stdout.write(`${JSON.stringify({ sessions, tasks, pendingApprovals: approvals }, null, 2)}\n`);
}

async function doctor(configPath?: string): Promise<void> {
  const path = configPath ?? defaultConfigPath();
  const lines: string[] = [];
  let config: LarklingConfig;
  try {
    config = await loadConfig(path);
    lines.push(`config: ok (${path})`);
  } catch (error) {
    process.stdout.write(`config: fail ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
    return;
  }
  lines.push(`stateDir: ${config.stateDir}`);
  lines.push(`owner: ${config.owner}`);
  for (const [name, agent] of [
    ["front", config.agents.front],
    ["back", config.agents.back],
  ] as const) {
    lines.push(`${name}.runtime: ${agent.runtime}`);
    lines.push(`${name}.model: ${agent.model ?? "(unset)"}`);
    if (agent.cwd) lines.push(`${name}.cwd: ${agent.cwd}`);
  }
  if (!config.persona.text.trim()) lines.push("persona: empty");
  try {
    const channel = await buildChannel(config);
    const health = await channel.health();
    for (const item of health) lines.push(`${item.name}: ${item.ok ? "ok" : "fail"}${item.detail ? ` ${item.detail}` : ""}`);
  } catch (error) {
    lines.push(`channel: fail ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
  for (const runtime of buildRuntimes(config).values()) {
    const health = await runtime.health();
    for (const item of health) lines.push(`${item.name}: ${item.ok ? "ok" : "not started"}${item.detail ? ` (${item.detail})` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function service(action: string | undefined, configPath?: string): Promise<void> {
  if (action !== "print") throw new Error("usage: larkling service print systemd|launchd");
  const kind = args[2];
  const config = configPath ?? defaultConfigPath();
  const node = process.execPath;
  const bin = process.argv[1];
  if (kind === "systemd") {
    process.stdout.write(`[Unit]
Description=Larkling
After=network.target

[Service]
Type=simple
ExecStart=${node} ${bin} start --config ${config}
Restart=on-failure
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`);
    return;
  }
  if (kind === "launchd") {
    const label = "com.larkling.bot";
    process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${bin}</string>
    <string>start</string>
    <string>--config</string>
    <string>${config}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`);
    return;
  }
  throw new Error("usage: larkling service print systemd|launchd");
}

async function configCommand(action: string | undefined, configPath?: string): Promise<void> {
  if (action === "schema") {
    process.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
    return;
  }
  const path = configPath ?? defaultConfigPath();
  if (action === "validate") {
    await loadConfig(path);
    process.stdout.write(`ok ${path}\n`);
    return;
  }
  if (action === "print") {
    const config = await loadConfig(path);
    const printable = { ...config, channel: config.channel.kind === "feishu" ? { ...config.channel, appSecret: "***" } : config.channel };
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    return;
  }
  throw new Error("usage: larkling config validate|schema|print");
}

async function taskCommand(op: string | undefined): Promise<void> {
  const api = apiLocation();
  switch (op) {
    case "start":
      return print(await call(api, "/v1/task/start", { body: required("--body"), followUpEnabled: args.includes("--follow-up") }));
    case "continue":
      return print(await call(api, "/v1/task/continue", { taskId: required("--task"), message: required("--message") }));
    case "update":
      return print(await call(api, "/v1/task/update", { taskId: required("--task"), version: Number(required("--version")), body: required("--body"), followUpEnabled: args.includes("--follow-up") }));
    case "get":
      return print(await call(api, "/v1/task/get", { taskId: required("--task") }));
    case "list":
      return print(await call(api, "/v1/task/list", {}));
    case "cancel":
      return print(await call(api, "/v1/task/cancel", { taskId: required("--task") }));
    default:
      throw new Error("usage: larkling task start|continue|update|get|list|cancel");
  }
}

async function imCommand(op: string | undefined): Promise<void> {
  const api = apiLocation();
  switch (op) {
    case "history":
      return print(await call(api, "/v1/im/history", { container: required("--container"), start: flag("--start"), end: flag("--end"), limit: flag("--limit") ? Number(flag("--limit")) : undefined }));
    case "file":
      return print(await call(api, "/v1/im/file", { messageId: required("--message"), key: required("--key") }));
    case "who":
      return print(await call(api, "/v1/im/who", { name: required("--name") }));
    default:
      throw new Error("usage: larkling im history|file|who");
  }
}

async function buildChannel(config: LarklingConfig) {
  if (config.channel.kind === "memory") return new MemoryChannel(config.channel.readGroupMessages);
  const http = new FetchFeishuHttp({ appId: config.channel.appId, appSecret: config.channel.appSecret, domain: config.channel.domain });
  const botOpenId = config.channel.botOpenId ?? (await loadBotOpenId(http)) ?? "";
  return new FeishuChannel({
    http,
    botOpenId,
    readGroupMessages: config.channel.readGroupMessages,
    stateDir: config.stateDir,
    timeZone: config.timezone,
    ratePerSecond: config.channel.ratePerSecond,
    speechPerSecond: config.channel.speechRatePerSecond,
  });
}

function buildRuntimes(config: LarklingConfig): Map<string, RuntimeAdapter> {
  const names = new Set([config.agents.front.runtime, config.agents.back.runtime]);
  const runtimes = new Map<string, RuntimeAdapter>();
  for (const name of names) {
    if (name === "codex") {
      runtimes.set("codex", new CodexRuntime({ command: config.runtimes.codex.command, args: config.runtimes.codex.args }));
      continue;
    }
    if (name === "pi") createPiRuntime();
    if (name === "dsh") createDshRuntime();
    throw new Error(`runtime ${name} is not registered`);
  }
  return runtimes;
}

function apiLocation(): { url: string; token: string } {
  const url = process.env.LARKLING_API_URL ?? flag("--api");
  const token = process.env.LARKLING_SESSION_TOKEN ?? flag("--token");
  if (!url || !token) throw new Error("set LARKLING_API_URL and LARKLING_SESSION_TOKEN, or pass --api and --token");
  return { url, token };
}

async function call(api: { url: string; token: string }, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, api.url), {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: { message?: string; code?: string } };
  if (!response.ok) throw new Error(payload.error?.message || response.statusText);
  return payload;
}

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
