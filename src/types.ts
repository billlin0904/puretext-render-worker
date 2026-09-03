import type { VideoRenderOptions, VideoRenderSpec } from "./renderer/subtitleVideoRenderer.js";

export type RemoteFile = {
  downloadUrl: string;
  size?: number;
  sha256?: string;
};

export type RemoteFont = RemoteFile & {
  family: string;
  file: string;
};

export type ClaimedRenderJob = {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  kind: "subtitle";
  input: RemoteFile;
  fonts?: RemoteFont[];
  output: {
    objectKey: string;
  };
  renderSpec: VideoRenderSpec;
  renderOptions: VideoRenderOptions;
};

export type UploadTarget = {
  uploadUrl: string;
  objectKey: string;
  headers?: Record<string, string>;
};

export type GpuTelemetry = {
  gpuCount: number;
  gpuName: string;
  gpuUtilizationPercent: number | null;
  gpuMemoryUsedMb: number | null;
  gpuMemoryTotalMb: number | null;
  gpuMemoryPercent: number | null;
  gpuTemperatureC: number | null;
  gpuPowerWatts: number | null;
  gpuEncoderUtilizationPercent: number | null;
  sampledAt: string;
};

export type WorkerStatus = {
  workerId: string;
  activeJobs: string[];
  concurrency: number;
  version: string;
  commit: string | null;
  builtAt: string | null;
  telemetry?: GpuTelemetry;
};

function remoteHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 8_192) throw new Error(`Invalid ${field}`);
  const parsed = new URL(value);
  const allowInsecureHttp = process.env["RENDER_ALLOW_INSECURE_HTTP"] === "true";
  if (parsed.protocol !== "https:"
    && parsed.hostname !== "127.0.0.1"
    && parsed.hostname !== "localhost"
    && !allowInsecureHttp) {
    throw new Error(`${field} must use HTTPS`);
  }
  return value;
}

export function parseClaimedRenderJob(value: unknown): ClaimedRenderJob {
  if (!value || typeof value !== "object") throw new Error("Invalid render job");
  const input = value as Partial<ClaimedRenderJob>;
  if (typeof input.jobId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(input.jobId)) throw new Error("Invalid jobId");
  if (typeof input.leaseToken !== "string" || input.leaseToken.length < 16 || input.leaseToken.length > 4_096) throw new Error("Invalid leaseToken");
  if (typeof input.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(input.leaseExpiresAt))) throw new Error("Invalid lease expiry");
  if (input.kind !== "subtitle") throw new Error("Unsupported render kind");
  if (!input.input || typeof input.input !== "object") throw new Error("Invalid input");
  remoteHttpsUrl(input.input.downloadUrl, "input.downloadUrl");
  if (!input.output || typeof input.output.objectKey !== "string"
    || !input.output.objectKey.startsWith("video-renders/") || input.output.objectKey.includes("..")) {
    throw new Error("Invalid output object key");
  }
  if (!input.renderSpec || !input.renderOptions) throw new Error("Missing render specification");
  if (input.fonts && (!Array.isArray(input.fonts) || input.fonts.length > 64)) throw new Error("Invalid fonts");
  for (const font of input.fonts ?? []) remoteHttpsUrl(font.downloadUrl, "font.downloadUrl");
  return input as ClaimedRenderJob;
}
