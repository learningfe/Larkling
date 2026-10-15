import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.write(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
