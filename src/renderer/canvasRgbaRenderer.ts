import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import {
  dynamicSubtitleFrame,
  renderSubtitleCanvas,
  type DynamicSubtitlePreset,
} from "./subtitleCanvas.js";
import type {
  SubtitleVideoEncoder,
  VideoRenderOptions,
  VideoRenderSpec,
} from "./subtitleVideoRenderer.js";

const CANVAS_PRESETS = new Set<DynamicSubtitlePreset>(["word-pop", "bounce", "neon", "box"]);

export function usesCanvasRgba(preset: DynamicSubtitlePreset | undefined): boolean {
  return CANVAS_PRESETS.has(preset ?? "none");
}

function encoderArguments(encoder: SubtitleVideoEncoder, quality: VideoRenderOptions["quality"]): string[] {
  const qualityValue = quality === "high" ? "18" : "21";
  return encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", qualityValue, "-b:v", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", qualityValue, "-pix_fmt", "yuv420p"];
}

type VideoTiming = { duration: number; fps: number };

function abortError(): Error {
  const error = new Error("video render aborted");
  error.name = "AbortError";
  return error;
}

function parseRate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parts = value.split("/");
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? 1);
  return Number.isFinite(numerator) && denominator ? numerator / denominator : 0;
}

async function probeVideoTiming(inputPath: string, requestedRate: VideoRenderOptions["frameRate"]): Promise<VideoTiming> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate,r_frame_rate,duration:format=duration",
      "-of", "json", inputPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `ffprobe exited with ${code}`)));
  });
  const data = JSON.parse(output) as {
    streams?: Array<{ avg_frame_rate?: string; r_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = data.streams?.[0];
  const sourceRate = parseRate(stream?.avg_frame_rate) || parseRate(stream?.r_frame_rate) || 30;
  const fps = requestedRate === "source" ? Math.max(1, Math.min(120, sourceRate)) : requestedRate;
  const duration = Number(stream?.duration) || Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("could not determine source video duration");
  return { duration, fps };
}

function overlayBand(spec: VideoRenderSpec): { top: number; height: number } {
  const canvas = createCanvas(spec.width, spec.height);
  const context = canvas.getContext("2d");
  let top = spec.height;
  let bottom = 0;
  for (const cue of spec.cues.filter((item) => usesCanvasRgba(item.dynamic?.preset))) {
    const sampleTime = Math.min(cue.end - 0.001, cue.start + 0.16);
    const frame = dynamicSubtitleFrame(cue.text, cue.dynamic?.words, cue.style, sampleTime, {
      preset: cue.dynamic?.preset ?? "none",
      highlightColor: cue.dynamic?.highlightColor,
      start: cue.start,
      end: cue.end,
    });
    const bounds = renderSubtitleCanvas(context, spec.width, spec.height, frame.text, frame.style, true, frame.runs);
    const effectMargin = Math.ceil(cue.style.fontSize * 0.5 + cue.style.outline + (cue.style.shadow ? 10 : 0));
    top = Math.min(top, bounds.top - effectMargin);
    bottom = Math.max(bottom, bounds.bottom + effectMargin);
  }
  const safeTop = Math.max(0, Math.floor(top));
  const safeBottom = Math.min(spec.height, Math.ceil(bottom));
  return { top: safeTop, height: Math.max(2, safeBottom - safeTop) };
}

export async function renderCanvasRgbaVideo(args: {
  inputPath: string;
  outputPath: string;
  spec: VideoRenderSpec;
  options: VideoRenderOptions;
  encoder: SubtitleVideoEncoder;
  assFilter?: string;
  onProgress?: (seconds: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { inputPath, outputPath, spec, options, encoder, assFilter, onProgress, signal } = args;
  if (signal?.aborted) throw abortError();
  const timing = await probeVideoTiming(inputPath, options.frameRate);
  const band = overlayBand(spec);
  const outputBandTop = Math.round(band.top * options.height / spec.height);
  const outputBandHeight = Math.max(2, Math.round(band.height * options.height / spec.height));
  const base = `[0:v]scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2[scaled]`;
  const ass = assFilter ? `;[scaled]${assFilter}[base]` : ";[scaled]null[base]";
  const overlay = `;[1:v]format=rgba,scale=${options.width}:${outputBandHeight}:flags=bicubic[caption];[base][caption]overlay=0:${outputBandTop}:eof_action=pass[outv]`;
  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${spec.width}x${band.height}`,
    "-framerate", String(timing.fps), "-i", "pipe:0",
    "-filter_complex", `${base}${ass}${overlay}`,
    "-map", "[outv]", "-map", "0:a?",
    ...encoderArguments(encoder, options.quality),
    "-r", String(timing.fps), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", outputPath,
  ];
  const child = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let progressBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    progressBuffer += chunk.toString();
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^(?:out_time_ms|out_time_us)=(\d+)$/.exec(line);
      if (match) onProgress?.(Number(match[1]) / 1_000_000);
    }
  });
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  const canvas = createCanvas(spec.width, band.height);
  const context = canvas.getContext("2d");
  const canvasCues = spec.cues.filter((cue) => usesCanvasRgba(cue.dynamic?.preset));
  const frameCount = Math.ceil(timing.duration * timing.fps) + 1;
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (signal?.aborted) throw abortError();
      const time = frameIndex / timing.fps;
      context.clearRect(0, 0, spec.width, band.height);
      for (const cue of canvasCues) {
        if (time < cue.start || time >= cue.end) continue;
        const style = { ...cue.style, positionY: cue.style.positionY - band.top };
        const frame = dynamicSubtitleFrame(cue.text, cue.dynamic?.words, style, time, {
          preset: cue.dynamic?.preset ?? "none",
          highlightColor: cue.dynamic?.highlightColor,
          start: cue.start,
          end: cue.end,
        });
        renderSubtitleCanvas(context, spec.width, band.height, frame.text, frame.style, false, frame.runs);
      }
      const pixels = Buffer.from(context.getImageData(0, 0, spec.width, band.height).data);
      if (!child.stdin.write(pixels)) await once(child.stdin, "drain");
    }
    child.stdin.end();
    const [code] = await once(child, "close") as [number | null];
    if (signal?.aborted) throw abortError();
    if (code !== 0) throw new Error(stderr.slice(-4_000) || `ffmpeg exited with ${code}`);
  } catch (error) {
    child.kill("SIGKILL");
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
