export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined as T, done: true });
    this.waiters = [];
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length) return { value: this.items.shift() as T, done: false };
    if (this.closed) return { value: undefined as T, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = await this.next();
      if (item.done) return;
      yield item.value;
    }
  }
}
