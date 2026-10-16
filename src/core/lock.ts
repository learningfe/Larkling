import { AsyncLocalStorage } from "node:async_hooks";

const heldKeys = new AsyncLocalStorage<Set<string>>();

/**
 * Per-key async mutex. Reenters when the same async context already holds the key
 * so a session can call back into itself without deadlocking. A section that
 * waits on another key must not be required by that other key.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const held = heldKeys.getStore();
    if (held?.has(key)) return fn();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      previous.then(
        () => gate,
        () => gate,
      ),
    );
    await previous.catch(() => undefined);
    const next = new Set(held);
    next.add(key);
    try {
      return await heldKeys.run(next, fn);
    } finally {
      release();
    }
  }
}
