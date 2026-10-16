import { createHash, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function scopeFileKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
