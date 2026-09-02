import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RemoteFile, RemoteFont, UploadTarget } from "./types.js";

export function safeRemoteFilename(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw new Error("Unsafe remote filename");
  }
  return value;
}

export async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function downloadFile(remote: RemoteFile, destination: string, maxBytes: number): Promise<void> {
  const response = await fetch(remote.downloadUrl, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  const advertised = Number(response.headers.get("content-length"));
  const expectedLimit = Math.min(maxBytes, remote.size ?? maxBytes);
  if (Number.isFinite(advertised) && advertised > expectedLimit) throw new Error("download exceeds size limit");
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > expectedLimit ? new Error("download exceeds size limit") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limiter, fs.createWriteStream(partial));
    const actual = await hashFile(partial);
    if (remote.size != null && actual.size !== remote.size) throw new Error("download size mismatch");
    if (remote.sha256 && actual.sha256.toLowerCase() !== remote.sha256.toLowerCase()) throw new Error("download checksum mismatch");
    await fs.promises.rename(partial, destination);
  } finally {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
  }
}

export async function ensureFonts(fonts: RemoteFont[], root: string, maxBytes: number): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true });
  for (const font of fonts) {
    const filename = safeRemoteFilename(font.file);
    const destination = path.join(root, filename);
    const existing = await hashFile(destination).catch(() => null);
    if (existing && (!font.sha256 || existing.sha256.toLowerCase() === font.sha256.toLowerCase())) continue;
    await downloadFile(font, destination, Math.min(maxBytes, 64 * 1024 ** 2));
  }
}

export async function uploadFile(target: UploadTarget, filePath: string, size: number): Promise<void> {
  const request = {
    method: "PUT",
    headers: { "content-length": String(size), "content-type": "video/mp4", ...target.headers },
    body: fs.createReadStream(filePath),
    duplex: "half",
    signal: AbortSignal.timeout(60 * 60_000),
  } as unknown as RequestInit;
  const response = await fetch(target.uploadUrl, request);
  if (!response.ok) throw new Error(`upload failed with HTTP ${response.status}`);
}
