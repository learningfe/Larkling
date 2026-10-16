import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Directory, PERSON_TTL_MS } from "../src/core/directory.js";

function source(groups: Record<string, { name: string; members: { openId: string; name: string }[] }>) {
  const calls: string[] = [];
  return {
    calls,
    chatInfo: async (id: string) => {
      calls.push(`info:${id}`);
      return { name: groups[id]?.name };
    },
    chatMembers: async (id: string) => {
      calls.push(`members:${id}`);
      return groups[id]?.members ?? [];
    },
  };
}

describe("directory", () => {
  it("fills a new group once and keeps names from chat updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkling-dir-"));
    const directory = await Directory.open(dir);
    const src = source({ oc_a: { name: "发布群", members: [] } });
    directory.attach(src);
    await directory.touchGroup("oc_a");
    await directory.touchGroup("oc_a");
    expect(src.calls.filter((call) => call === "info:oc_a")).toHaveLength(1);
    expect(directory.group("oc_a")?.name).toBe("发布群");
    await directory.setGroupName("oc_a", "新发布群");
    expect((await directory.lookupGroup({ query: "新发布" })).matches[0]).toMatchObject({ chatId: "oc_a", match: "fuzzy" });
    const saved = JSON.parse(await readFile(join(dir, "directory.json"), "utf8"));
    expect(saved.groups[0].name).toBe("新发布群");
  });

  it("answers from cache, falls back to member lists, and ranks the current group first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkling-dir-"));
    const directory = await Directory.open(dir);
    const src = source({
      oc_a: { name: "A", members: [{ openId: "ou_1", name: "赵小明" }] },
      oc_b: { name: "B", members: [{ openId: "ou_2", name: "赵小刚" }] },
    });
    directory.attach(src);
    await directory.touchGroup("oc_a");
    await directory.touchGroup("oc_b");
    const miss = await directory.lookupPerson({ openId: "ou_2" });
    expect(miss).toMatchObject({ source: "api", matches: [{ openId: "ou_2", name: "赵小刚", groups: ["B"], match: "exact" }] });
    const hit = await directory.lookupPerson({ openId: "ou_2" });
    expect(hit.source).toBe("cache");
    const all = await directory.lookupPerson({ query: "赵", scope: "all", currentGroup: "oc_a" });
    expect(all.matches.map((match) => match.openId)).toEqual(["ou_1", "ou_2"]);
    const current = await directory.lookupPerson({ query: "小刚", currentGroup: "oc_a" });
    expect(current.matches).toHaveLength(0);
  });

  it("returns a stale person immediately and refreshes in background", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkling-dir-"));
    let now = Date.parse("2026-01-01T00:00:00Z");
    const directory = await Directory.open(dir, () => now);
    const src = source({ oc_a: { name: "A", members: [{ openId: "ou_1", name: "新名字" }] } });
    directory.attach(src);
    await directory.observePerson("ou_1", "旧名字", "oc_a");
    now += PERSON_TTL_MS + 1;
    const stale = await directory.lookupPerson({ openId: "ou_1" });
    expect(stale.matches[0].name).toBe("旧名字");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(directory.person("ou_1")?.name).toBe("新名字");
  });

  it("lists members of a group on request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkling-dir-"));
    const directory = await Directory.open(dir);
    directory.attach(source({ oc_a: { name: "A", members: [{ openId: "ou_1", name: "张三" }] } }));
    const result = await directory.lookupGroup({ chatId: "oc_a", includeMembers: true });
    expect(result.matches[0].members).toEqual([{ openId: "ou_1", name: "张三" }]);
  });
});
