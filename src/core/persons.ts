import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, Person } from "../protocol/types.js";
import { atomicWrite } from "../util/fs.js";

interface PersonFile {
  persons: Person[];
}

/**
 * Process-wide person directory. Identity is stableId. Display names are
 * ordered most-recent first. `merge` is explicit: v1 has no automatic signal
 * that two stable ids are one person.
 */
export class PersonDirectory {
  private persons: Person[] = [];
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(stateDir: string): Promise<PersonDirectory> {
    const path = join(stateDir, "persons.json");
    const directory = new PersonDirectory(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as PersonFile;
      directory.persons = (parsed.persons ?? []).map((person) => ({ ...person, refs: person.refs ?? [] }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return directory;
  }

  list(): Person[] {
    return this.persons.map((person) => ({ ...person, identities: [...person.identities], names: [...person.names], refs: [...person.refs] }));
  }

  byStableId(stableId: string): Person | undefined {
    return this.persons.find((person) => person.identities.includes(stableId));
  }

  byId(personId: string): Person | undefined {
    return this.persons.find((person) => person.personId === personId);
  }

  displayName(stableId: string, ref?: string): string {
    const person = this.byStableId(stableId);
    if (person?.names[0]) return person.names[0];
    const tail = (ref || stableId).slice(-4);
    return `用户${tail}`;
  }

  async observe(actor: Actor, at: string): Promise<Person> {
    return this.commit(() => {
      let person = this.persons.find((item) => item.identities.includes(actor.stableId));
      if (!person) {
        person = {
          personId: actor.stableId,
          identities: [actor.stableId],
          names: actor.name ? [actor.name] : [],
          refs: actor.ref ? [actor.ref] : [],
          lastSeenAt: at,
        };
        this.persons.push(person);
        return person;
      }
      this.note(person, actor.name, actor.ref, at);
      return person;
    });
  }

  async observeName(entry: { stableId: string; ref: string; name: string }, at: string): Promise<Person> {
    return this.commit(() => {
      let person = this.persons.find((item) => item.identities.includes(entry.stableId));
      if (!person) {
        person = {
          personId: entry.stableId,
          identities: [entry.stableId],
          names: entry.name ? [entry.name] : [],
          refs: entry.ref ? [entry.ref] : [],
          lastSeenAt: at,
        };
        this.persons.push(person);
        return person;
      }
      this.note(person, entry.name, entry.ref, at);
      return person;
    });
  }

  /** Fold `dropId` into `keepId`. Names already on the survivor stay ahead. */
  async merge(keepId: string, dropId: string, at: string): Promise<Person> {
    return this.commit(() => {
      const keep = this.persons.find((person) => person.personId === keepId);
      const drop = this.persons.find((person) => person.personId === dropId);
      if (!keep || !drop) throw new Error("person not found");
      if (keep === drop) return keep;
      for (const identity of drop.identities) {
        if (!keep.identities.includes(identity)) keep.identities.push(identity);
      }
      for (const ref of drop.refs) {
        if (!keep.refs.includes(ref)) keep.refs.push(ref);
      }
      for (const name of [...drop.names].reverse()) this.pushName(keep, name);
      keep.lastSeenAt = at > keep.lastSeenAt ? at : keep.lastSeenAt;
      this.persons = this.persons.filter((person) => person !== drop);
      return keep;
    });
  }

  findByName(query: string): Person[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.persons.filter((person) => person.names.some((name) => name.toLowerCase().includes(needle)));
  }

  private note(person: Person, name: string, ref: string, at: string): void {
    if (name) this.pushName(person, name);
    if (ref) {
      person.refs = [ref, ...person.refs.filter((item) => item !== ref)];
    }
    if (at > person.lastSeenAt) person.lastSeenAt = at;
  }

  private pushName(person: Person, name: string): void {
    person.names = [name, ...person.names.filter((item) => item !== name)];
  }

  private async commit<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(async () => {
      const result = fn();
      await atomicWrite(this.path, JSON.stringify({ persons: this.persons }, null, 2));
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
