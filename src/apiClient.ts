import { logger } from "./logger.js";
import { parseClaimedRenderJob, type ClaimedRenderJob, type UploadTarget, type WorkerStatus } from "./types.js";

export class ApiClient {
  constructor(private readonly base: string, private readonly token: string) {}

  private async request(path: string, init: RequestInit, timeoutMs = 35_000): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "puretext-render-worker/0.1",
        ...init.headers,
      },
    });
    return response;
  }

  async claim(status: WorkerStatus): Promise<ClaimedRenderJob | null> {
    const response = await this.request("/api/internal/render-workers/claim", {
      method: "POST",
      body: JSON.stringify({ ...status, longPollSeconds: 25, capabilities: { encoders: ["h264_nvenc", "libx264"] } }),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`claim failed with HTTP ${response.status}`);
    return parseClaimedRenderJob(await response.json());
  }

  async heartbeat(status: WorkerStatus): Promise<void> {
    const response = await this.request("/api/internal/render-workers/heartbeat", {
      method: "POST",
      body: JSON.stringify(status),
    }, 10_000);
    if (!response.ok) throw new Error(`heartbeat failed with HTTP ${response.status}`);
  }

  async progress(job: ClaimedRenderJob, stage: string, progress: number): Promise<void> {
    await this.jobPost(job, "progress", { stage, progress: Math.max(0, Math.min(99, Math.round(progress))) });
  }

  async prepareUpload(job: ClaimedRenderJob, size: number, sha256: string): Promise<UploadTarget> {
    const response = await this.jobPost(job, "prepare-upload", { size, sha256 });
    return await response.json() as UploadTarget;
  }

  async complete(job: ClaimedRenderJob, target: UploadTarget, size: number, sha256: string, durationSeconds: number): Promise<void> {
    await this.jobPost(job, "complete", {
      outputObjectKey: target.objectKey,
      size,
      sha256,
      durationSeconds,
    });
  }

  async fail(job: ClaimedRenderJob, message: string): Promise<void> {
    await this.jobPost(job, "fail", { error: message.slice(0, 2_000) });
  }

  private async jobPost(job: ClaimedRenderJob, action: string, body: object): Promise<Response> {
    const response = await this.request(`/api/internal/render-jobs/${encodeURIComponent(job.jobId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, ...body }),
    }, 15_000);
    if (!response.ok) {
      logger.warn({ jobId: job.jobId, action, status: response.status }, "PureText job API request failed");
      throw new Error(`${action} failed with HTTP ${response.status}`);
    }
    return response;
  }
}
