import path from "node:path";

export type WorkerConfig = {
  apiBase: string;
  token: string;
  workerId: string;
  concurrency: number;
  cacheRoot: string;
  healthPort: number;
  maxInputBytes: number;
  version: string;
  commit: string | null;
  builtAt: string | null;
};

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const apiBase = required("PURETEXT_API_BASE", env).replace(/\/$/, "");
  const parsedUrl = new URL(apiBase);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    throw new Error("PURETEXT_API_BASE must use HTTPS outside localhost");
  }
  const encoder = (env["VIDEO_ENCODER_MODE"] ?? env["PURETEXT_VIDEO_ENCODER"] ?? "nvenc").trim().toLowerCase();
  if (!new Set(["nvenc", "auto", "cpu"]).has(encoder)) throw new Error("VIDEO_ENCODER_MODE must be nvenc, auto, or cpu");
  process.env["PURETEXT_VIDEO_ENCODER"] = encoder;
  return {
    apiBase,
    token: required("RENDER_WORKER_TOKEN", env),
    workerId: required("RENDER_WORKER_ID", env),
    concurrency: boundedInteger(env["VIDEO_RENDER_CONCURRENCY"], 2, 1, 8),
    cacheRoot: path.resolve(env["RENDER_CACHE_ROOT"]?.trim() || "/var/lib/puretext-render-worker"),
    healthPort: boundedInteger(env["HEALTH_PORT"], 9090, 1024, 65535),
    maxInputBytes: boundedInteger(env["VIDEO_RENDER_MAX_INPUT_BYTES"], 10 * 1024 ** 3, 1, 50 * 1024 ** 3),
    version: env["RENDER_WORKER_VERSION"]?.trim() || "0.1.12",
    commit: env["SERVICE_COMMIT"]?.trim() || null,
    builtAt: env["SERVICE_BUILT_AT"]?.trim() || null,
  };
}
