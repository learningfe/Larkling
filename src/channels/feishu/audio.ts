import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuHttp } from "./http.js";
import type { RateLimiter } from "../../core/ratelimit.js";

const CHUNK_BYTES = 16_000 * 2 * 55;

export type TranscribeStatus = "ok" | "too_long" | "failed";

export async function transcribeAudio(options: {
  http: FeishuHttp;
  pcm: Buffer;
  limiter: RateLimiter;
  durationMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<{ status: TranscribeStatus; transcript?: string }> {
  if (options.durationMs > 5 * 60_000) return { status: "too_long" };
  const chunks: Buffer[] = [];
  if (options.durationMs <= 60_000) chunks.push(options.pcm);
  else {
    for (let offset = 0; offset < options.pcm.length; offset += CHUNK_BYTES) chunks.push(options.pcm.subarray(offset, offset + CHUNK_BYTES));
  }
  const parts: string[] = [];
  for (const chunk of chunks) {
    const text = await recognize(options.http, options.limiter, chunk, options.log);
    if (text == null) return { status: "failed" };
    parts.push(text);
  }
  return { status: "ok", transcript: parts.join("") };
}

/** file_recognize requires a 16-character [a-z0-9] file id. */
export function speechFileId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(16);
  let id = "";
  for (let index = 0; index < 16; index++) id += alphabet[bytes[index] % alphabet.length];
  return id;
}

async function recognize(http: FeishuHttp, limiter: RateLimiter, pcm: Buffer, log?: (fields: Record<string, unknown>) => void): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await limiter.take();
    try {
      const response = await http.request({
        method: "POST",
        path: "/open-apis/speech_to_text/v1/speech/file_recognize",
        json: {
          speech: { speech: pcm.toString("base64") },
          config: { file_id: speechFileId(), format: "pcm", engine_type: "16k_auto" },
        },
      });
      const code = response.json?.code;
      const text = response.json?.data?.recognition_text;
      if ((code === 0 || code == null) && typeof text === "string") return text;
      log?.({ code: code ?? null, msg: response.json?.msg ?? "", attempt });
    } catch (error) {
      log?.({ error: error instanceof Error ? error.message : String(error), attempt });
    }
  }
  return null;
}

/** `ffmpeg -i input -ar 16000 -ac 1 -f s16le output`. Injected in tests. */
export async function ffmpegToPcm(input: string, output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-i", input, "-ar", "16000", "-ac", "1", "-f", "s16le", output], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

export async function withTempPcm(source: Buffer, ffmpeg: (input: string, output: string) => Promise<void>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "larkling-audio-"));
  try {
    const input = join(dir, "audio.bin");
    const output = join(dir, "audio.pcm");
    await writeFile(input, source);
    await ffmpeg(input, output);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
