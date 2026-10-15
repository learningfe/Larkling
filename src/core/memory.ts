/**
 * Person-scoped memory is reserved. v1 exposes the interface and does not
 * read or write memories. Owner, trust, and (later) memory hang off personId.
 */
export interface MemoryStore {
  recall(personId: string, query: string): Promise<string[]>;
  remember(personId: string, note: string): Promise<void>;
}

export class UnimplementedMemory implements MemoryStore {
  async recall(_personId: string, _query: string): Promise<string[]> {
    throw new Error("memory is not implemented");
  }

  async remember(_personId: string, _note: string): Promise<void> {
    throw new Error("memory is not implemented");
  }
}
