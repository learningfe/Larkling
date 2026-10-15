import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveConfig } from "../src/config.js";
import { createDshRuntime } from "../src/runtimes/dsh/index.js";
import { createPiRuntime } from "../src/runtimes/pi/index.js";

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
  });

  it("leaves pi and dsh unimplemented", () => {
    expect(() => createPiRuntime()).toThrow(/not implemented/);
    expect(() => createDshRuntime()).toThrow(/not implemented/);
  });
});
