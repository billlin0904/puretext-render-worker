import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "./apiClient.js";
import type { WorkerConfig } from "./config.js";
import { downloadFile, ensureFonts, hashFile, uploadFile } from "./files.js";
import { collectGpuTelemetry } from "./gpuTelemetry.js";
import { logger } from "./logger.js";
import { parseVideoRenderOptions, parseVideoRenderSpec, renderSubtitleVideo } from "./renderer/subtitleVideoRenderer.js";
import type { ClaimedRenderJob, GpuTelemetry, WorkerStatus } from "./types.js";

export class RenderWorker {
  private readonly api: ApiClient;
  private readonly active = new Map<string, ClaimedRenderJob>();
  private stopping = false;
  private lastClaimAttempt = Date.now();
  private telemetry: GpuTelemetry | undefined;
  private telemetryPending = false;

  constructor(private readonly config: WorkerConfig) {
    this.api = new ApiClient(config.apiBase, config.token);
  }

  status(): WorkerStatus {
    return {
      workerId: this.config.workerId,
      activeJobs: [...this.active.keys()],
      concurrency: this.config.concurrency,
      version: this.config.version,
      commit: this.config.commit,
      builtAt: this.config.builtAt,
      ...(this.telemetry ? { telemetry: this.telemetry } : {}),
    };
  }

  healthy(): boolean {
    return !this.stopping && Date.now() - this.lastClaimAttempt < 120_000;
  }

  stop(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    await fs.promises.mkdir(path.join(this.config.cacheRoot, "tmp"), { recursive: true });
    await this.refreshTelemetry();
    const heartbeat = setInterval(() => {
      void this.refreshTelemetry()
        .then(() => this.api.heartbeat(this.status()))
        .catch((error) => logger.warn({ err: error }, "worker heartbeat failed"));
    }, 20_000);
    heartbeat.unref();
    try {
      await Promise.all(Array.from({ length: this.config.concurrency }, (_, slot) => this.slot(slot + 1)));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.telemetryPending) return;
    this.telemetryPending = true;
    try {
      const telemetry = await collectGpuTelemetry();
      if (telemetry) this.telemetry = telemetry;
    } finally {
      this.telemetryPending = false;
    }
  }

  private async slot(slot: number): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        this.lastClaimAttempt = Date.now();
        const job = await this.api.claim(this.status());
        failures = 0;
        if (!job) continue;
        if (job.kind !== "subtitle") throw new Error(`Unsupported render kind: ${String(job.kind)}`);
        this.active.set(job.jobId, job);
        await this.process(job, slot);
      } catch (error) {
        failures += 1;
        logger.error({ err: error, slot }, "worker slot failed");
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
      }
    }
  }

  private async process(job: ClaimedRenderJob, slot: number): Promise<void> {
    const renderDir = await fs.promises.mkdtemp(path.join(this.config.cacheRoot, "tmp", `${job.jobId}-`));
    let lastReportAt = 0;
    const report = (stage: string, value: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastReportAt < 2_000) return;
      lastReportAt = now;
      void this.api.progress(job, stage, value).catch((error) => logger.warn({ err: error, jobId: job.jobId }, "progress report failed"));
    };
    try {
      logger.info({ jobId: job.jobId, slot }, "render job started");
      const spec = parseVideoRenderSpec(job.renderSpec);
      if (!spec) throw new Error("Invalid subtitle render specification");
      const fontsRoot = path.join(this.config.cacheRoot, "fonts");
      await ensureFonts(job.fonts ?? [], fontsRoot, this.config.maxInputBytes);
      process.env["PURETEXT_SUBTITLE_FONTS_DIR"] = fontsRoot;
      report("download", 3, true);
      const inputPath = path.join(renderDir, "input-video");
      await downloadFile(job.input, inputPath, this.config.maxInputBytes);
      report("preparing", 18, true);
      const outputPath = path.join(renderDir, `${job.jobId}.mp4`);
      const duration = Math.max(1, ...spec.cues.map((cue) => cue.end));
      await renderSubtitleVideo(
        inputPath,
        spec,
        renderDir,
        outputPath,
        parseVideoRenderOptions(job.renderOptions),
        (seconds) => report("encoding", 35 + seconds / duration * 58),
        (done, total) => report("preparing", 18 + done / Math.max(1, total) * 17),
      );
      report("uploading", 94, true);
      const output = await hashFile(outputPath);
      const target = await this.api.prepareUpload(job, output.size, output.sha256);
      if (target.objectKey !== job.output.objectKey) throw new Error("Upload target object key mismatch");
      await uploadFile(target, outputPath, output.size);
      await this.api.complete(job, target, output.size, output.sha256, duration);
      logger.info({ jobId: job.jobId, slot, bytes: output.size }, "render job completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown render error";
      logger.error({ err: error, jobId: job.jobId, slot }, "render job failed");
      await this.api.fail(job, message).catch((reportError) => logger.error({ err: reportError, jobId: job.jobId }, "failed to report job failure"));
    } finally {
      this.active.delete(job.jobId);
      await fs.promises.rm(renderDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
