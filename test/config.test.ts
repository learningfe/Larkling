import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveConfig } from "../src/config.js";
import { createDshRuntime } from "../src/runtimes/dsh/index.js";

const agents = {
  front: { runtime: "codex", instructions: "be brief" },
  back: { runtime: "codex", instructions: "be thorough" },
};

describe("config", () => {
  it("rejects a raw app secret and a missing env var", async () => {
    await expect(
      resolveConfig({ owner: "feishu:on_owner", channel: { feishu: { appId: "cli_x", appSecret: "plain" } }, agents }, {}),
    ).rejects.toThrow(/env:/);
    await expect(
      resolveConfig(
        { owner: "feishu:on_owner", channel: { feishu: { appId: "cli_x", appSecret: "env:LARKLING_APP_SECRET" } }, agents },
        {},
      ),
    ).rejects.toThrow(/LARKLING_APP_SECRET/);
  });

  it("requires exactly one channel and reads instruction files", async () => {
    await expect(resolveConfig({ owner: "feishu:on_owner", channel: {}, agents }, {})).rejects.toThrow(/exactly one/);
    const dir = await mkdtemp(join(tmpdir(), "larkling-cfg-"));
    await writeFile(join(dir, "front.md"), "from file\n");
    await writeFile(join(dir, "config.yaml"), "owner: feishu:on_owner\nchannel:\n  memory: {}\nagents:\n  front:\n    runtime: codex\n    instructions: ./front.md\n  back:\n    runtime: codex\n    instructions: literal\n");
    const loaded = await loadConfig(join(dir, "config.yaml"), { LARKLING_STATE_DIR: join(dir, "state") });
    expect(loaded.agents.front.instructions).toBe("from file\n");
    expect(loaded.agents.back.instructions).toBe("literal");
    expect(loaded.stateDir).toBe(join(dir, "state"));
    expect(loaded.channel).toEqual({ kind: "memory", readGroupMessages: true });
    expect(loaded.persona.text).toBe("a personal assistant");
    expect(loaded.persona.name).toBe("");
    expect(loaded.im.window.maxAgeMs).toBe(24 * 3_600_000);
    expect(loaded.agents.front.fast).toBe(false);
    expect(loaded.agents.back.fast).toBe(false);
    expect(loaded.agents.front.network).toBe(false);
    expect(loaded.agents.back.network).toBe(false);
  });

  it("reads fast on front and back without putting it in extra", async () => {
    const loaded = await resolveConfig(
      {
        owner: "feishu:on_owner",
        channel: { memory: {} },
        agents: {
          front: { runtime: "codex", fast: true, network: true, light: { model: "mini" } },
          back: { runtime: "codex", fast: false, network: false, custom: 1 },
        },
      },
      {},
    );
    expect(loaded.agents.front.fast).toBe(true);
    expect(loaded.agents.front.network).toBe(true);
    expect(loaded.agents.front.lightModel).toBe("mini");
    expect(loaded.agents.front.extra).toEqual({});
    expect(loaded.agents.back.fast).toBe(false);
    expect(loaded.agents.back.network).toBe(false);
    expect(loaded.agents.back.extra).toEqual({ custom: 1 });
  });

  it("reads a per-group allowlist and rejects the old trust keys", async () => {
    const loaded = await resolveConfig(
      {
        owner: "feishu:on_owner",
        channel: { memory: {} },
        agents,
        trust: { restricted: { oc_locked: ["feishu:ou_a", "ou_b"] } },
      },
      {},
    );
    expect(loaded.trust).toEqual({ restricted: { oc_locked: ["feishu:ou_a", "ou_b"] } });
    const defaults = await resolveConfig({ owner: "feishu:on_owner", channel: { memory: {} }, agents }, {});
    expect(defaults.trust).toEqual({ restricted: {} });
    expect(defaults.session.botChainLimit).toBe(10);
    const base = { owner: "feishu:on_owner", channel: { memory: {} }, agents };
    await expect(resolveConfig({ ...base, trust: { groups: ["oc_old"] } }, {})).rejects.toThrow(/trust\.groups/);
    await expect(resolveConfig({ ...base, trust: { trusted: [], allowed: [] } }, {})).rejects.toThrow(/trust\.trusted and trust\.allowed were removed/);
    await expect(resolveConfig({ ...base, trust: { allowed: ["feishu:ou_a"] } }, {})).rejects.toThrow(/trust\.trusted and trust\.allowed were removed/);
    await expect(resolveConfig({ ...base, trust: { restricted: ["oc_locked"] } }, {})).rejects.toThrow(/per-group allowlist/);
  });

  it("leaves dsh unimplemented", () => {
    expect(() => createDshRuntime()).toThrow(/not implemented/);
  });

  it("reads pi runtime, provider, and session dir", async () => {
    const loaded = await resolveConfig(
      {
        owner: "feishu:ou_owner",
        channel: { memory: {} },
        runtimes: { pi: { provider: "openai-codex" } },
        agents: {
          front: { runtime: "pi", model: "gpt-6-astra", effort: "low" },
          back: { runtime: "pi", provider: "anthropic", model: "claude" },
        },
      },
      {},
      "/home/tester",
    );
    expect(loaded.runtimes.pi?.provider).toBe("openai-codex");
    expect(loaded.runtimes.pi?.sessionDir).toBe("/home/tester/.larkling/state/pi-sessions");
    expect(loaded.agents.front.provider).toBeUndefined();
    expect(loaded.agents.back.provider).toBe("anthropic");
    expect(loaded.agents.back.extra).toEqual({});
  });
});
