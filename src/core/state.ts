import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyState, type BotState } from "../protocol/types.js";
import { atomicWrite } from "../util/fs.js";

export class StateStore {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    readonly dir: string,
    private data: BotState,
  ) {}

  static async open(dir: string): Promise<StateStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "state.json");
    let data = emptyState();
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as BotState;
      data = { ...emptyState(), ...parsed };
      data.sessions ??= {};
      data.tasks ??= {};
      data.tokens ??= {};
      data.seenEventIds ??= [];
      data.seenMessageIds ??= [];
      data.botChains ??= {};
      data.participatedTopics ??= [];
      data.outbound ??= {};
      data.approvals ??= {};
      data.memberSyncAt ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new StateStore(dir, data);
  }

  get(): BotState {
    return this.data;
  }

  async update<T>(mutator: (draft: BotState) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const result = mutator(this.data);
      await this.flush();
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flush(): Promise<void> {
    await atomicWrite(join(this.dir, "state.json"), JSON.stringify(this.data, null, 2));
  }
}
