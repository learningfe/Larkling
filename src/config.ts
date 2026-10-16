import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { parseDuration } from "./util/duration.js";

const duration = z.string();

const agentSchema = z
  .object({
    runtime: z.string().min(1),
    /** Provider id for runtimes that serve several providers (pi). */
    provider: z.string().optional(),
    model: z.string().optional(),
    light: z.object({ model: z.string().optional() }).optional(),
    instructions: z.string().optional(),
    sandbox: z.string().optional(),
    cwd: z.string().optional(),
    effort: z.string().optional(),
    approvalPolicy: z.string().optional(),
    /** Prefer a faster service tier for this agent's turns. Default false. */
    fast: z.boolean().default(false),
    /** Let the agent's sandboxed commands reach the network. Default false. */
    network: z.boolean().default(false),
  })
  .passthrough();

export const configFileSchema = z
  .object({
    stateDir: z.string().default("~/.larkling/state"),
    timezone: z.string().default("Asia/Shanghai"),
    limits: z
      .object({
        maxConcurrentTasks: z.number().int().positive().default(3),
        maxConcurrentChecks: z.number().int().positive().default(1),
        maxConcurrentJudges: z.number().int().positive().default(2),
      })
      .default({}),
    runtimes: z
      .object({
        codex: z
          .object({
            command: z.string().default("codex"),
            args: z.array(z.string()).default([]),
            idleRelease: duration.default("15m"),
            maxLiveSessions: z.number().int().positive().default(8),
          })
          .default({}),
        pi: z
          .object({
            command: z.string().default("pi"),
            args: z.array(z.string()).default([]),
            /** Default provider for agents on pi. pi itself defaults to google, so set one. */
            provider: z.string().optional(),
            /** Larkling-owned session directory. Default <stateDir>/pi-sessions. */
            sessionDir: z.string().optional(),
            idleRelease: duration.default("15m"),
            maxLiveSessions: z.number().int().positive().default(8),
          })
          .optional(),
        dsh: z
          .object({
            socket: z.string().default("~/.larkling/dsh.sock"),
            idleRelease: duration.default("15m"),
            maxLiveSessions: z.number().int().positive().default(8),
          })
          .optional(),
      })
      .default({}),
    sessions: z
      .object({
        seedMaxTokens: z.number().int().positive().default(16_000),
        compactAfterTokens: z.number().int().positive().default(64_000),
      })
      .default({}),
    channel: z
      .object({
        feishu: z
          .object({
            appId: z.string().min(1),
            appSecret: z.string().min(1),
            botOpenId: z.string().optional(),
            /** Declare that im:message.group_msg is granted. v1 does not probe the tenant. */
            readGroupMessages: z.boolean().default(false),
            rateLimit: z.object({ perSecond: z.number().positive().default(20) }).default({}),
            speechRatePerSecond: z.number().positive().default(20),
            domain: z.string().default("https://open.feishu.cn"),
          })
          .optional(),
        memory: z
          .object({
            readGroupMessages: z.boolean().default(true),
          })
          .optional(),
      })
      .default({}),
    owner: z.string().min(1),
    trust: z
      .object({
        trusted: z.array(z.string()).default([]),
        allowed: z.array(z.string()).default([]),
        /**
         * Chat ids locked to the personal allowlist (owner, trusted, allowed).
         * Empty means every group is open. Topics inherit the parent chat.
         * Listing an id closes that chat; this is not an open-group whitelist.
         */
        restricted: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    im: z
      .object({
        window: z
          .object({
            group: z.number().int().positive().default(20),
            topic: z.number().int().positive().default(20),
            maxTokens: z.number().int().positive().default(4000),
            /** Drop messages older than this from the recent window. */
            maxAge: duration.default("24h"),
          })
          .default({}),
        respondTo: z
          .object({
            default: z.enum(["mention", "relevant"]).default("mention"),
            scopes: z.record(z.enum(["mention", "relevant"])).default({}),
          })
          .default({}),
        gate: z
          .object({
            debounce: duration.default("5s"),
            judgeContext: z.number().int().positive().default(10),
          })
          .default({}),
      })
      .default({}),
    persona: z
      .object({
        /** Display name. Empty means the process fills it from the Feishu app name. */
        name: z.string().optional(),
        soul: z.string().optional(),
        local: z.string().optional(),
        duty: z.string().default(""),
      })
      .default({}),
    session: z
      .object({
        turnIdleTimeout: duration.default("15m"),
        botChainLimit: z.number().int().positive().default(10),
      })
      .default({}),
    agents: z.object({
      front: agentSchema,
      back: agentSchema,
    }),
    tasks: z
      .object({
        enabled: z.boolean().default(true),
        taskIdleTimeout: duration.default("60m"),
        heartbeat: z
          .object({
            enabled: z.boolean().default(true),
            scanInterval: duration.default("30s"),
            interval: duration.default("30m"),
          })
          .default({}),
      })
      .default({}),
  })
  .superRefine((value, ctx) => {
    const hasFeishu = Boolean(value.channel.feishu);
    const hasMemory = Boolean(value.channel.memory);
    if (hasFeishu === hasMemory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message: "configure exactly one of channel.feishu or channel.memory",
      });
    }
    if (value.channel.feishu && !value.channel.feishu.appSecret.startsWith("env:")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel", "feishu", "appSecret"],
        message: "appSecret must be an env: reference",
      });
    }
  });

export type ConfigFile = z.infer<typeof configFileSchema>;

export interface AgentConfig {
  runtime: string;
  provider?: string;
  model?: string;
  lightModel?: string;
  /** Literal instructions, or the contents of the configured file. */
  instructions: string;
  sandbox?: string;
  cwd?: string;
  effort?: string;
  approvalPolicy?: string;
  /** Prefer a faster service tier. Applies to the light profile as well. */
  fast: boolean;
  /** Allow network access inside the sandbox. Not applied to the light profile. */
  network: boolean;
  extra: Record<string, unknown>;
}

export interface LarklingConfig {
  stateDir: string;
  timezone: string;
  limits: { maxConcurrentTasks: number; maxConcurrentChecks: number; maxConcurrentJudges: number };
  runtimes: {
    codex: { command: string; args: string[]; idleReleaseMs: number; maxLiveSessions: number };
    pi?: { command: string; args: string[]; provider?: string; sessionDir: string; idleReleaseMs: number; maxLiveSessions: number };
    dsh?: { socket: string; idleReleaseMs: number; maxLiveSessions: number };
  };
  sessions: { seedMaxTokens: number; compactAfterTokens: number };
  channel:
    | {
        kind: "feishu";
        appId: string;
        appSecret: string;
        botOpenId?: string;
        readGroupMessages: boolean;
        ratePerSecond: number;
        speechRatePerSecond: number;
        domain: string;
      }
    | { kind: "memory"; readGroupMessages: boolean };
  owner: string;
  trust: { trusted: string[]; allowed: string[]; restricted: string[] };
  im: {
    window: { group: number; topic: number; maxTokens: number; maxAgeMs: number };
    respondTo: { default: "mention" | "relevant"; scopes: Record<string, "mention" | "relevant"> };
    gate: { debounceMs: number; judgeContext: number };
  };
  persona: { name: string; text: string; duty: string };
  session: { turnIdleTimeoutMs: number; botChainLimit: number };
  agents: { front: AgentConfig; back: AgentConfig };
  tasks: { enabled: boolean; taskIdleTimeoutMs: number; heartbeat: { enabled: boolean; scanIntervalMs: number; intervalMs: number } };
  /** Path the file was loaded from, when it came from disk. */
  sourcePath?: string;
}

export function configJsonSchema(): unknown {
  return zodToJsonSchema(configFileSchema, "LarklingConfig");
}

export function expandHome(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return value;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<LarklingConfig> {
  const raw = await readFile(path, "utf8");
  return resolveConfig(parseYaml(raw), env, home, path);
}

const removedTrustGroups =
  "trust.groups was removed. Groups are open unless listed in trust.restricted. Delete trust.groups; do not copy those chat ids into restricted (that inverts the old open-group whitelist).";

function parseConfigFile(input: unknown): ConfigFile {
  const result = configFileSchema.safeParse(input);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    if (issue.code !== "unrecognized_keys" || issue.path[0] !== "trust" || !issue.keys.includes("groups")) continue;
    // A generic unrecognized-key error would invite copying the old whitelist into restricted.
    throw new Error(removedTrustGroups);
  }
  throw result.error;
}

export async function resolveConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  sourcePath?: string,
): Promise<LarklingConfig> {
  const parsed = parseConfigFile(input);
  const baseDir = sourcePath ? resolve(sourcePath, "..") : process.cwd();
  const agent = async (value: z.infer<typeof agentSchema>): Promise<AgentConfig> => {
    const { runtime, provider, model, light, instructions, sandbox, cwd, effort, approvalPolicy, fast, network, ...extra } = value;
    return {
      runtime,
      provider,
      model,
      lightModel: light?.model,
      instructions: instructions ? await readMaybePath(instructions, baseDir, home) : "",
      sandbox,
      cwd: cwd ? expandHome(cwd, home) : undefined,
      effort,
      approvalPolicy,
      fast,
      network,
      extra,
    };
  };
  const secret = parsed.channel.feishu ? resolveSecret(parsed.channel.feishu.appSecret, env) : "";
  const soul = parsed.persona.soul ? await readOptional(parsed.persona.soul, baseDir, home) : "";
  const local = parsed.persona.local ? await readOptional(parsed.persona.local, baseDir, home) : "";
  const persona = [soul, local].filter(Boolean).join("\n\n");
  return {
    stateDir: expandHome(env.LARKLING_STATE_DIR || parsed.stateDir, home),
    timezone: parsed.timezone,
    limits: parsed.limits,
    runtimes: {
      codex: {
        command: parsed.runtimes.codex.command,
        args: parsed.runtimes.codex.args,
        idleReleaseMs: parseDuration(parsed.runtimes.codex.idleRelease, "runtimes.codex.idleRelease"),
        maxLiveSessions: parsed.runtimes.codex.maxLiveSessions,
      },
      pi: parsed.runtimes.pi
        ? {
            command: parsed.runtimes.pi.command,
            args: parsed.runtimes.pi.args,
            provider: parsed.runtimes.pi.provider,
            sessionDir: expandHome(parsed.runtimes.pi.sessionDir ?? `${expandHome(env.LARKLING_STATE_DIR || parsed.stateDir, home)}/pi-sessions`, home),
            idleReleaseMs: parseDuration(parsed.runtimes.pi.idleRelease, "runtimes.pi.idleRelease"),
            maxLiveSessions: parsed.runtimes.pi.maxLiveSessions,
          }
        : undefined,
      dsh: parsed.runtimes.dsh
        ? {
            socket: expandHome(parsed.runtimes.dsh.socket, home),
            idleReleaseMs: parseDuration(parsed.runtimes.dsh.idleRelease, "runtimes.dsh.idleRelease"),
            maxLiveSessions: parsed.runtimes.dsh.maxLiveSessions,
          }
        : undefined,
    },
    sessions: parsed.sessions,
    channel: parsed.channel.feishu
      ? {
          kind: "feishu",
          appId: parsed.channel.feishu.appId,
          appSecret: secret,
          botOpenId: parsed.channel.feishu.botOpenId,
          readGroupMessages: parsed.channel.feishu.readGroupMessages,
          ratePerSecond: parsed.channel.feishu.rateLimit.perSecond,
          speechRatePerSecond: parsed.channel.feishu.speechRatePerSecond,
          domain: parsed.channel.feishu.domain,
        }
      : { kind: "memory", readGroupMessages: parsed.channel.memory?.readGroupMessages ?? true },
    owner: parsed.owner,
    trust: parsed.trust,
    im: {
      window: {
        group: parsed.im.window.group,
        topic: parsed.im.window.topic,
        maxTokens: parsed.im.window.maxTokens,
        maxAgeMs: parseDuration(parsed.im.window.maxAge, "im.window.maxAge"),
      },
      respondTo: parsed.im.respondTo,
      gate: {
        debounceMs: parseDuration(parsed.im.gate.debounce, "im.gate.debounce"),
        judgeContext: parsed.im.gate.judgeContext,
      },
    },
    persona: { name: parsed.persona.name?.trim() ?? "", text: persona || "a personal assistant", duty: parsed.persona.duty },
    session: {
      turnIdleTimeoutMs: parseDuration(parsed.session.turnIdleTimeout, "session.turnIdleTimeout"),
      botChainLimit: parsed.session.botChainLimit,
    },
    agents: {
      front: await agent(parsed.agents.front),
      back: await agent(parsed.agents.back),
    },
    tasks: {
      enabled: parsed.tasks.enabled,
      taskIdleTimeoutMs: parseDuration(parsed.tasks.taskIdleTimeout, "tasks.taskIdleTimeout"),
      heartbeat: {
        enabled: parsed.tasks.heartbeat.enabled,
        scanIntervalMs: parseDuration(parsed.tasks.heartbeat.scanInterval, "tasks.heartbeat.scanInterval"),
        intervalMs: parseDuration(parsed.tasks.heartbeat.interval, "tasks.heartbeat.interval"),
      },
    },
    sourcePath,
  };
}

export function defaultConfigPath(home = homedir()): string {
  return expandHome(process.env.LARKLING_CONFIG || "~/.larkling/config.yaml", home);
}

function resolveSecret(value: string, env: NodeJS.ProcessEnv): string {
  const name = value.slice("env:".length);
  const found = env[name];
  if (!found) throw new Error(`missing environment variable ${name} referenced by appSecret`);
  return found;
}

async function readMaybePath(value: string, baseDir: string, home: string): Promise<string> {
  if (!looksLikePath(value)) return value;
  const path = resolvePath(value, baseDir, home);
  return readFile(path, "utf8");
}

async function readOptional(value: string, baseDir: string, home: string): Promise<string> {
  try {
    return await readFile(resolvePath(value, baseDir, home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function looksLikePath(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("~");
}

function resolvePath(value: string, baseDir: string, home: string): string {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function runtimeLimits(config: LarklingConfig, runtimeName: string): { idleReleaseMs: number; maxLiveSessions: number } {
  if (runtimeName === "codex") return config.runtimes.codex;
  if (runtimeName === "pi" && config.runtimes.pi) return config.runtimes.pi;
  if (runtimeName === "dsh" && config.runtimes.dsh) return config.runtimes.dsh;
  return { idleReleaseMs: 15 * 60_000, maxLiveSessions: 8 };
}
