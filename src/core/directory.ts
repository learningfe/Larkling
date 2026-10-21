import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../util/fs.js";

export interface CachedPerson {
  openId: string;
  name: string;
  /** Chat ids this person was seen in, most recent first. */
  groups: string[];
  updatedAt: string;
  /**
   * True when a Feishu mention said `mentioned_type: bot`.
   * Records written before this field existed omit it; readers treat that as false.
   */
  isBot?: boolean;
}

export interface CachedGroup {
  chatId: string;
  name: string;
  lastActiveAt: string;
  updatedAt: string;
}

export interface DirectorySource {
  /** Group info (`im/v1/chats/:chat_id`). Undefined when unavailable. */
  chatInfo(chatId: string): Promise<{ name?: string } | undefined>;
  /** All members of a group (`im/v1/chats/:chat_id/members`), paginated by the source. */
  chatMembers(chatId: string): Promise<{ openId: string; name: string }[]>;
}

export interface PersonMatch {
  openId: string;
  name: string;
  groups: string[];
  match: "exact" | "fuzzy";
  /** Bots stay findable. Callers that want a human skip `isBot`. */
  isBot: boolean;
}

export interface GroupMatch {
  chatId: string;
  name: string;
  match: "exact" | "fuzzy";
  members?: { openId: string; name: string }[];
}

interface DirectoryFile {
  persons: CachedPerson[];
  groups: CachedGroup[];
}

const DAY = 24 * 60 * 60 * 1000;
export const PERSON_TTL_MS = 30 * DAY;
export const MEMBER_BATCH = 20;

/**
 * Local cache of people (by open_id) and groups (by chat_id). Cached people are
 * trusted; past the TTL they are still returned and refreshed in background.
 * Group names stay fresh through `im.chat.updated_v1`; a group is fetched only
 * the first time it is seen.
 */
export class Directory {
  private persons = new Map<string, CachedPerson>();
  private groups = new Map<string, CachedGroup>();
  private chain: Promise<void> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private source?: DirectorySource;

  private constructor(
    private readonly path: string,
    private readonly now: () => number,
  ) {}

  static async open(stateDir: string, now: () => number = Date.now): Promise<Directory> {
    const directory = new Directory(join(stateDir, "directory.json"), now);
    try {
      const parsed = JSON.parse(await readFile(directory.path, "utf8")) as Partial<DirectoryFile>;
      for (const person of parsed.persons ?? []) {
        directory.persons.set(person.openId, { ...person, groups: person.groups ?? [], isBot: person.isBot === true });
      }
      for (const group of parsed.groups ?? []) directory.groups.set(group.chatId, group);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return directory;
  }

  attach(source: DirectorySource | undefined): void {
    this.source = source;
  }

  person(openId: string): CachedPerson | undefined {
    return this.persons.get(openId);
  }

  group(chatId: string): CachedGroup | undefined {
    return this.groups.get(chatId);
  }

  /** Passive upsert from messages, mentions, and member lists. `isBot` only turns on, never off. */
  async observePerson(openId: string, name: string, chatId?: string, isBot = false): Promise<void> {
    if (!openId.startsWith("ou_") || !name) return;
    const current = this.persons.get(openId);
    const groups = chatId ? [chatId, ...(current?.groups ?? []).filter((id) => id !== chatId)] : current?.groups ?? [];
    const nextBot = current?.isBot === true || isBot;
    if (current && current.name === name && current.groups[0] === groups[0] && current.isBot === nextBot && this.fresh(current.updatedAt)) return;
    this.persons.set(openId, { openId, name, groups, updatedAt: this.iso(), isBot: nextBot });
    await this.save();
  }

  /** Activity in a group. Fills the name once when the group is new. */
  async touchGroup(chatId: string): Promise<void> {
    if (!chatId.startsWith("oc_")) return;
    const current = this.groups.get(chatId);
    const at = this.iso();
    this.groups.set(chatId, { chatId, name: current?.name ?? "", lastActiveAt: at, updatedAt: current?.updatedAt ?? "" });
    await this.save();
    if (!current?.name) await this.fillGroup(chatId);
  }

  /** `im.chat.updated_v1` and first-seen fills. */
  async setGroupName(chatId: string, name: string): Promise<void> {
    if (!chatId || !name) return;
    const current = this.groups.get(chatId);
    this.groups.set(chatId, { chatId, name, lastActiveAt: current?.lastActiveAt ?? "", updatedAt: this.iso() });
    await this.save();
  }

  async lookupPerson(input: { openId?: string; query?: string; scope?: "current" | "all"; currentGroup?: string }): Promise<{ matches: PersonMatch[]; source: "cache" | "api" }> {
    if (input.openId) {
      const cached = this.persons.get(input.openId);
      if (cached) {
        if (!this.fresh(cached.updatedAt)) void this.refreshPerson(cached.openId).catch(() => undefined);
        return { matches: [this.personMatch(cached, "exact")], source: "cache" };
      }
      const found = await this.searchGroups(this.orderedGroups(input.currentGroup), (members) => members.some((m) => m.openId === input.openId));
      const hit = this.persons.get(input.openId);
      return { matches: found && hit ? [this.personMatch(hit, "exact")] : [], source: "api" };
    }
    const needle = (input.query ?? "").trim().toLowerCase();
    if (!needle) return { matches: [], source: "cache" };
    const scope = input.scope ?? "current";
    const current = input.currentGroup;
    const inScope = (person: CachedPerson) => scope === "all" || !current || person.groups.includes(current);
    const search = () =>
      [...this.persons.values()].filter((person) => inScope(person) && person.name.toLowerCase().includes(needle));
    let hits = search();
    let source: "cache" | "api" = "cache";
    if (!hits.length) {
      const groups = scope === "current" && current ? [current] : this.orderedGroups(current);
      await this.searchGroups(groups, (members) => members.some((m) => m.name.toLowerCase().includes(needle)));
      hits = search();
      source = "api";
    }
    hits.sort((a, b) => Number(Boolean(current && b.groups.includes(current))) - Number(Boolean(current && a.groups.includes(current))));
    return { matches: hits.map((person) => this.personMatch(person, "fuzzy")), source };
  }

  async lookupGroup(input: { chatId?: string; query?: string; includeMembers?: boolean }): Promise<{ matches: GroupMatch[]; source: "cache" | "api" }> {
    let source: "cache" | "api" = "cache";
    let hits: { group: CachedGroup; match: "exact" | "fuzzy" }[] = [];
    if (input.chatId) {
      if (!this.groups.get(input.chatId)?.name) {
        source = "api";
        await this.fillGroup(input.chatId);
      }
      const group = this.groups.get(input.chatId);
      if (group?.name) hits = [{ group, match: "exact" }];
    } else {
      const needle = (input.query ?? "").trim().toLowerCase();
      if (needle) {
        hits = [...this.groups.values()]
          .filter((group) => group.name.toLowerCase().includes(needle))
          .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
          .map((group) => ({ group, match: "fuzzy" as const }));
      }
    }
    const matches: GroupMatch[] = [];
    for (const { group, match } of hits) {
      const item: GroupMatch = { chatId: group.chatId, name: group.name, match };
      if (input.includeMembers) {
        const members = await this.members(group.chatId);
        if (members) source = "api";
        item.members = members ?? [...this.persons.values()].filter((p) => p.groups.includes(group.chatId)).map((p) => ({ openId: p.openId, name: p.name }));
      }
      matches.push(item);
    }
    return { matches, source };
  }

  private personMatch(person: CachedPerson, match: "exact" | "fuzzy"): PersonMatch {
    return {
      openId: person.openId,
      name: person.name,
      groups: person.groups.map((id) => this.groups.get(id)?.name || id),
      match,
      isBot: person.isBot === true,
    };
  }

  private orderedGroups(first?: string): string[] {
    const ids = [...this.groups.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).map((group) => group.chatId);
    return first ? [first, ...ids.filter((id) => id !== first)] : ids;
  }

  /** Fetch members batch by batch (concurrent within a batch) until `found` holds. */
  private async searchGroups(chatIds: string[], found: (members: { openId: string; name: string }[]) => boolean): Promise<boolean> {
    for (let i = 0; i < chatIds.length; i += MEMBER_BATCH) {
      const batch = await Promise.all(chatIds.slice(i, i + MEMBER_BATCH).map((id) => this.members(id)));
      if (batch.some((members) => members && found(members))) return true;
    }
    return false;
  }

  /** Fetch and cache every member of one group. Undefined when the source fails. */
  private async members(chatId: string): Promise<{ openId: string; name: string }[] | undefined> {
    if (!this.source) return undefined;
    return this.once(`members:${chatId}`, async () => {
      try {
        const members = await this.source!.chatMembers(chatId);
        const at = this.iso();
        for (const member of members) {
          if (!member.openId.startsWith("ou_") || !member.name) continue;
          const current = this.persons.get(member.openId);
          const groups = [chatId, ...(current?.groups ?? []).filter((id) => id !== chatId)];
          this.persons.set(member.openId, { openId: member.openId, name: member.name, groups, updatedAt: at, isBot: current?.isBot === true });
        }
        await this.save();
        return members;
      } catch {
        return undefined;
      }
    });
  }

  private async refreshPerson(openId: string): Promise<void> {
    const person = this.persons.get(openId);
    await this.searchGroups(person?.groups.length ? person.groups : this.orderedGroups(), (members) => members.some((m) => m.openId === openId));
  }

  private async fillGroup(chatId: string): Promise<void> {
    if (!this.source) return;
    await this.once(`group:${chatId}`, async () => {
      try {
        const info = await this.source!.chatInfo(chatId);
        if (info?.name) await this.setGroupName(chatId, info.name);
      } catch {
        // Next activity tries again.
      }
    });
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private fresh(updatedAt: string): boolean {
    const at = Date.parse(updatedAt);
    return Number.isFinite(at) && this.now() - at < PERSON_TTL_MS;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private save(): Promise<void> {
    const run = this.chain.then(() =>
      atomicWrite(this.path, JSON.stringify({ persons: [...this.persons.values()], groups: [...this.groups.values()] }, null, 2)),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }
}
