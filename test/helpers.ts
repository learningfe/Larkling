import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { resolveConfig, type LarklingConfig } from "../src/config.js";
import { MemoryChannel } from "../src/channels/memory.js";
import { ManualClock } from "../src/core/clock.js";
import { createHost, type Host } from "../src/core/host.js";
import { Logger } from "../src/log.js";
import type { Actor, ChannelEvent, MessageEvent, Scope } from "../src/protocol/types.js";
import { ScriptedRuntime } from "../src/runtimes/scripted.js";

export const OWNER_ID = "feishu:on_owner";

const openHosts: Host[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(openHosts.splice(0).map((host) => host.stop().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "larkling-"));
  dirs.push(dir);
  return dir;
}

export async function testConfig(stateDir: string, patch?: (config: LarklingConfig) => void): Promise<LarklingConfig> {
  const config = await resolveConfig(
    {
      stateDir,
      owner: OWNER_ID,
      channel: { memory: {} },
      agents: {
        front: { runtime: "codex", instructions: "front instructions" },
        back: { runtime: "codex", instructions: "back instructions" },
      },
      trust: {},
    },
    {},
    "/home/tester",
  );
  patch?.(config);
  return config;
}

export interface Harness {
  dir: string;
  config: LarklingConfig;
  clock: ManualClock;
  channel: MemoryChannel;
  runtime: ScriptedRuntime;
  host: Host;
}

export async function startHarness(patch?: (config: LarklingConfig) => void): Promise<Harness> {
  const dir = await tempDir();
  const config = await testConfig(dir, patch);
  const clock = new ManualClock(Date.parse("2026-03-15T02:00:00.000Z"));
  const channel = new MemoryChannel(true);
  const runtime = new ScriptedRuntime("codex");
  const host = await createHost({
    config,
    channel,
    runtimes: new Map([["codex", runtime]]),
    clock,
    logger: new Logger(undefined, "error"),
    bot: { ref: "ou_bot", stableId: "memory:bot", name: "Larkling" },
    timers: false,
  });
  openHosts.push(host);
  await host.start();
  return { dir, config, clock, channel, runtime, host };
}

export function actor(partial: Partial<Actor> & Pick<Actor, "stableId" | "ref">): Actor {
  return {
    channel: "memory",
    name: partial.name ?? "用户",
    isBot: partial.isBot ?? false,
    ...partial,
  };
}

export function ownerActor(): Actor {
  return actor({ ref: "ou_owner", stableId: OWNER_ID, name: "Owner" });
}

export function message(partial: Partial<MessageEvent> & { text: string; scope?: Scope; actor?: Actor }): MessageEvent {
  const scope = partial.scope ?? { channel: "memory", kind: "dm", id: "ou_owner" };
  return {
    type: "message",
    eventId: partial.eventId ?? `evt_${partial.messageId ?? partial.text}`,
    messageId: partial.messageId ?? `om_${partial.text}`,
    scope,
    actor: partial.actor ?? ownerActor(),
    text: partial.text,
    attachments: partial.attachments ?? [],
    mentionsSelf: partial.mentionsSelf ?? scope.kind === "dm",
    mentionsOthers: partial.mentionsOthers,
    disposition: partial.disposition,
    replyTo: partial.replyTo,
    occurredAt: partial.occurredAt ?? "2026-03-15T02:00:00.000Z",
  };
}

export function groupScope(id = "oc_group"): Scope {
  return { channel: "memory", kind: "group", id };
}

export async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function pushAndSettle(h: Harness, event: ChannelEvent): Promise<void> {
  h.channel.push(event);
  // Let the channel loop pick the event up before settle looks for in-flight work.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.host.settle();
}

export async function post(url: string, token: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

export async function readOwnerToken(dir: string): Promise<string> {
  return (await readFile(join(dir, "owner.token"), "utf8")).trim();
}
