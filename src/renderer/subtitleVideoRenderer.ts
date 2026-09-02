import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GENERATED_SUBTITLE_FONT_FILES } from "./subtitle-font-catalog.generated.js";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import {
  dynamicSubtitleFrame,
  dynamicSubtitleTimelinePoints,
  layoutSubtitleCanvasRunLines,
  measureSubtitleCanvasTextWidth,
  renderSubtitleCanvas,
  type DynamicSubtitleOptions,
  type SubtitleCanvasRun,
  type SubtitleCanvasStyle,
  type SubtitleTimestampedWord,
} from "./subtitleCanvas.js";
import { logger } from "../logger.js";

export type VideoRenderCueStyle = SubtitleCanvasStyle;

export type VideoRenderSpec = {
  version: 1;
  /** Canonical design-space size. The normal subtitle editor still validates
   * 1280x720, while the short-video renderer uses the selected portrait or
   * square canvas directly. */
  width: number;
  height: number;
  bottomMargin: number;
  cues: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    /** Explicit editor layer. Translated cues keep the user's selected font
     * even when a foreign proper name contains more kana/hangul than Han. */
    track?: "source" | "translated";
    style: VideoRenderCueStyle;
    dynamic?: DynamicSubtitleOptions & { words?: SubtitleTimestampedWord[] };
  }>;
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function renderColor(value: unknown, fallback: string): string {
  const color = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
}

export function parseVideoRenderSpec(raw: unknown): VideoRenderSpec | null {
  try {
    // Express already parses application/json request bodies. Keep accepting
    // the former string payload as well so older clients remain compatible.
    const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (serialized.length > 4_000_000) return null;
    const input = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<VideoRenderSpec>;
    if (!input || typeof input !== "object") return null;
    if (input.version !== 1 || input.width !== 1280 || input.height !== 720 || !Array.isArray(input.cues)) return null;
    const cues = input.cues.slice(0, 5_000).flatMap((cue) => {
      if (!cue || typeof cue !== "object") return [];
      const start = boundedNumber(cue.start, -1, 0, 86_400);
      const end = boundedNumber(cue.end, -1, 0, 86_400);
      const text = typeof cue.text === "string" ? cue.text.slice(0, 10_000) : "";
      if (start < 0 || end <= start || !text.trim()) return [];
      const sourceStyle = cue.style && typeof cue.style === "object" ? cue.style : {} as Partial<VideoRenderCueStyle>;
      const sourceDynamic = cue.dynamic && typeof cue.dynamic === "object" ? cue.dynamic : undefined;
      const preset = sourceDynamic && ["none", "typewriter", "word-pop", "highlight", "karaoke", "bounce", "neon", "box"].includes(String(sourceDynamic.preset))
        ? sourceDynamic.preset
        : "none";
      const words = sourceDynamic && Array.isArray(sourceDynamic.words)
        ? sourceDynamic.words.slice(0, 10_000).flatMap((word) => {
            if (!word || typeof word !== "object") return [];
            const wordStart = boundedNumber(word.start, -1, start, end);
            const wordEnd = boundedNumber(word.end, -1, start, end);
            const value = typeof word.word === "string" ? word.word.slice(0, 200) : "";
            return wordStart >= start && wordEnd > wordStart && value ? [{ word: value, start: wordStart, end: wordEnd }] : [];
          })
        : undefined;
      return [{
        id: boundedNumber(cue.id, 0, 0, 1_000_000), start, end, text,
        track: cue.track === "source" || cue.track === "translated" ? cue.track : undefined,
        dynamic: {
          preset,
          highlightColor: renderColor(sourceDynamic?.highlightColor, "#FFE84A"),
          words,
        },
        style: {
          fontFamily: typeof sourceStyle.fontFamily === "string" ? sourceStyle.fontFamily.slice(0, 100) : "Noto Sans TC",
          fontWeight: boundedNumber(sourceStyle.fontWeight, 700, 100, 900),
          fontSize: boundedNumber(sourceStyle.fontSize, 48, 8, 160),
          lineHeight: boundedNumber(sourceStyle.lineHeight, 1.375, 0.8, 3),
          letterSpacing: boundedNumber(sourceStyle.letterSpacing, 0, -2, 12),
          color: renderColor(sourceStyle.color, "#FFFFFF"),
          opacity: boundedNumber(sourceStyle.opacity, 1, 0, 1),
          backgroundEnabled: sourceStyle.backgroundEnabled !== false,
          backgroundColor: renderColor(sourceStyle.backgroundColor, "#000000"),
          backgroundOpacity: boundedNumber(sourceStyle.backgroundOpacity, 0.85, 0, 1),
          backgroundRadius: boundedNumber(sourceStyle.backgroundRadius, 8, 0, 80),
          backgroundPaddingX: boundedNumber(sourceStyle.backgroundPaddingX, 16, 0, 80),
          backgroundPaddingY: boundedNumber(sourceStyle.backgroundPaddingY, 8, 0, 50),
          outline: boundedNumber(sourceStyle.outline, 0, 0, 12),
          shadow: sourceStyle.shadow !== false,
          italic: sourceStyle.italic === true,
          underline: sourceStyle.underline === true,
          positionX: boundedNumber(sourceStyle.positionX, 640, 0, 1280),
          positionY: boundedNumber(sourceStyle.positionY, 640, 0, 720),
          maxWidth: boundedNumber(sourceStyle.maxWidth, 1178, 100, 1280),
          prewrapped: sourceStyle.prewrapped === true,
        },
      }];
    });
    if (!cues.length) return null;
    return { version: 1, width: 1280, height: 720, bottomMargin: boundedNumber(input.bottomMargin, 48, 0, 200), cues };
  } catch {
    return null;
  }
}

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;

export type SubtitleVideoEncoder = "libx264" | "h264_nvenc";
export type VideoRenderQuality = "standard" | "high";
export type VideoRenderOptions = {
  width: 1280 | 1920 | 2560;
  height: 720 | 1080 | 1440;
  frameRate: "source" | 24 | 25 | 30 | 60;
  quality: VideoRenderQuality;
  gpuAcceleration: boolean;
};
export const DEFAULT_VIDEO_RENDER_OPTIONS: VideoRenderOptions = {
  width: 1920,
  height: 1080,
  frameRate: "source",
  quality: "standard",
  gpuAcceleration: true,
};

export function parseVideoRenderOptions(raw: unknown): VideoRenderOptions {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VIDEO_RENDER_OPTIONS };
  const input = raw as Partial<VideoRenderOptions>;
  const dimensions = input.width === 1280 && input.height === 720
    ? { width: 1280 as const, height: 720 as const }
    : input.width === 2560 && input.height === 1440
      ? { width: 2560 as const, height: 1440 as const }
      : { width: 1920 as const, height: 1080 as const };
  const frameRate = input.frameRate === 24 || input.frameRate === 25 || input.frameRate === 30 || input.frameRate === 60
    ? input.frameRate
    : "source";
  return {
    ...dimensions,
    frameRate,
    quality: input.quality === "high" ? "high" : "standard",
    gpuAcceleration: input.gpuAcceleration !== false,
  };
}
export type VideoEncoderMode = "auto" | "nvenc" | "cpu";

export type VideoEncoderSelection = {
  encoder: SubtitleVideoEncoder;
  mode: VideoEncoderMode;
  /** Only auto mode may retry on CPU when the GPU disappears after probing. */
  allowCpuFallback: boolean;
};

function configuredVideoEncoderMode(): VideoEncoderMode {
  const value = process.env["PURETEXT_VIDEO_ENCODER"]?.trim().toLowerCase();
  return value === "nvenc" || value === "cpu" ? value : "auto";
}

export function chooseVideoEncoder(
  mode: VideoEncoderMode,
  gpuRequested: boolean,
  nvencAvailable: boolean,
): VideoEncoderSelection {
  if (mode === "cpu") {
    return { encoder: "libx264", mode, allowCpuFallback: false };
  }
  if (mode === "nvenc") {
    if (!nvencAvailable) {
      throw new Error("ffmpeg h264_nvenc is unavailable; verify the NVIDIA driver and container GPU access");
    }
    // A cloud deployment policy is authoritative. A client cannot silently
    // turn a GPU worker into a long-running CPU export by changing one option.
    return { encoder: "h264_nvenc", mode, allowCpuFallback: false };
  }
  if (gpuRequested && nvencAvailable) {
    return { encoder: "h264_nvenc", mode, allowCpuFallback: true };
  }
  return { encoder: "libx264", mode, allowCpuFallback: false };
}

function renderAbortError(): Error {
  const error = new Error("video render aborted");
  error.name = "AbortError";
  return error;
}

function throwIfRenderAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw renderAbortError();
}

function runFfmpeg(args: string[], onProgress?: (seconds: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(renderAbortError());
      return;
    }
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let progressBuffer = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^(?:out_time_ms|out_time_us)=(\d+)$/.exec(line);
        if (match) onProgress?.(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => signal?.aborted
      ? reject(renderAbortError())
      : code === 0
        ? resolve()
        : reject(new Error(stderr.slice(-4_000) || `ffmpeg exited with ${code}`))));
  });
}

let nvencAvailablePromise: Promise<boolean> | undefined;

/**
 * Listing encoders is not enough: FFmpeg may include h264_nvenc while the
 * container has no NVIDIA device/driver mounted. A tiny real encode verifies
 * the complete runtime path and is cached for the lifetime of this process.
 */
export function isNvencAvailable(): Promise<boolean> {
  nvencAvailablePromise ??= runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.05",
    "-frames:v", "1", "-an", "-c:v", "h264_nvenc", "-preset", "p4",
    "-f", "null", "-",
  ]).then(() => true, () => false);
  return nvencAvailablePromise;
}

export async function selectVideoEncoder(gpuRequested = true): Promise<VideoEncoderSelection> {
  const mode = configuredVideoEncoderMode();
  const shouldProbeNvenc = mode === "nvenc" || (mode === "auto" && gpuRequested);
  const nvencAvailable = shouldProbeNvenc && await isNvencAvailable();
  return chooseVideoEncoder(mode, gpuRequested, nvencAvailable);
}

export function videoEncoderArguments(encoder: SubtitleVideoEncoder, quality: VideoRenderQuality = "standard"): string[] {
  const qualityValue = quality === "high" ? "18" : "21";
  return encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", qualityValue, "-b:v", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", qualityValue, "-pix_fmt", "yuv420p"];
}

/** Emit an explicit startup record so operators can verify GPU acceleration
 * before the first user export is created. */
export async function logSubtitleVideoEncoderStatus(): Promise<void> {
  const selection = await selectVideoEncoder(true);
  if (selection.encoder === "h264_nvenc") {
    logger.info(
      { encoder: selection.encoder, mode: selection.mode, gpuAcceleration: true },
      "[subtitleVideoRenderer] GPU encoder ready",
    );
    return;
  }
  logger.warn(
    { encoder: selection.encoder, mode: selection.mode, gpuAcceleration: false },
    selection.mode === "cpu"
      ? "[subtitleVideoRenderer] CPU encoder selected by configuration"
      : "[subtitleVideoRenderer] NVENC unavailable; exports will use CPU",
  );
}

let fontsInitialized = false;
const registeredBundledFonts = new Set<string>();
const BUNDLED_SUBTITLE_FONTS = GENERATED_SUBTITLE_FONT_FILES;
// Skia currently registers the default instance of some variable CJK fonts
// (Chiron reports that instance as ExtraLight) and does not apply the requested
// `font-weight` axis. Registering a static instance alongside the variable font
// gives export the same real 700 weight that browsers render in the preview.
const BUNDLED_SUBTITLE_FONT_INSTANCES: Record<string, string[]> = {
  "Chiron GoRound TC": ["chiron-goround-tc-700.ttf"],
};

function subtitleFontsDirectory(): string | undefined {
  const configured = process.env["PURETEXT_SUBTITLE_FONTS_DIR"]?.trim();
  const candidates = [
    configured,
    path.resolve(process.cwd(), "fonts/subtitles"),
    path.resolve(process.cwd(), "../../fonts/subtitles/render"),
    "/app/fonts/subtitles",
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
}

export function initializeSubtitleFonts(requestedFamilies: string[]) {
  const fontsDir = subtitleFontsDirectory();
  if (!fontsInitialized) {
    fontsInitialized = true;
    (GlobalFonts as typeof GlobalFonts & { loadSystemFonts: () => number }).loadSystemFonts();
    for (const fontPath of [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
      "C:/Windows/Fonts/msjh.ttc",
      "C:/Windows/Fonts/msjhbd.ttc",
    ]) {
      if (fs.existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, "Noto Sans TC");
    }
  }
  if (fontsDir) {
    const requested = new Set(requestedFamilies);
    for (const font of BUNDLED_SUBTITLE_FONTS.filter((item) => requested.has(item.family))) {
      if (registeredBundledFonts.has(font.family)) continue;
      const fontPath = path.join(fontsDir, font.file);
      if (fs.existsSync(fontPath)) {
        GlobalFonts.registerFromPath(fontPath, font.family);
        for (const instanceFile of BUNDLED_SUBTITLE_FONT_INSTANCES[font.family] ?? []) {
          const instancePath = path.join(fontsDir, instanceFile);
          if (fs.existsSync(instancePath)) GlobalFonts.registerFromPath(instancePath, font.family);
        }
        registeredBundledFonts.add(font.family);
      }
    }
    logger.info({ fontsDir, fontFamilies: [...requested] }, "[subtitleVideoRenderer] requested subtitle fonts loaded");
  } else {
    logger.warn("[subtitleVideoRenderer] bundled subtitle fonts directory was not found");
  }
}

export type SubtitleTimelineInterval = { start: number; end: number; activeCueIndexes: number[] };

export function subtitleTimelineIntervals(spec: VideoRenderSpec): SubtitleTimelineInterval[] {
  const boundaries = [...new Set(spec.cues.flatMap((cue) => {
    const wordBoundaries = cue.dynamic?.preset && cue.dynamic.preset !== "none"
      ? dynamicSubtitleTimelinePoints(cue.text, cue.dynamic.words, {
          ...cue.dynamic,
          start: cue.start,
          end: cue.end,
        })
      : [];
    return [cue.start, cue.end, 0, ...wordBoundaries];
  }))]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const intervals: SubtitleTimelineInterval[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    if (end - start < 0.001) continue;
    intervals.push({
      start,
      end,
      activeCueIndexes: spec.cues.flatMap((cue, cueIndex) => cue.start < end && cue.end > start ? [cueIndex] : []),
    });
  }
  return intervals;
}

function assColor(value: string, opacity = 1): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const red = match?.[1] ?? "FF";
  const green = match?.[2] ?? "FF";
  const blue = match?.[3] ?? "FF";
  const alpha = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `&H${alpha}${blue}${green}${red}&`;
}

function assAlpha(opacity: number): string {
  return Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function assFontFamily(value: string): string {
  return (value.split(",")[0] ?? "Noto Sans TC").trim().replace(/^['"]|['"]$/g, "") || "Noto Sans TC";
}

export function subtitleFontFamilyForText(
  fontFamily: string,
  text: string,
  track?: "source" | "translated",
): string {
  const family = assFontFamily(fontFamily);
  // Translated text may intentionally retain Japanese/Korean names. The old
  // character-count heuristic could switch only that cue from TC to JP/KR,
  // changing libass metrics midway through a video and pushing glyphs outside
  // the Canvas-sized background. Source cues still use script-aware faces.
  if (track === "translated") return family;
  const notoVariant = /^(Noto\s+(?:Sans|Serif))\s+(?:TC|SC|HK|JP|KR)$/i.exec(family);
  if (!notoVariant) return family;

  const hangulCount = text.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const kanaCount = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;

  // Proper names frequently keep their original Japanese or Korean spelling in
  // otherwise Chinese translations. Switching the complete cue to JP/KR for a
  // single foreign-script run changes libass metrics and can make the text wider
  // than the Canvas-measured background. Only switch when that script dominates.
  if (hangulCount > Math.max(kanaCount, hanCount)) return `${notoVariant[1]} KR`;
  if (kanaCount > Math.max(hangulCount, hanCount)) return `${notoVariant[1]} JP`;
  return family;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function blendHexColor(base: string, highlight: string, progress: number): string {
  const parse = (value: string) => /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const left = parse(base);
  const right = parse(highlight);
  if (!left || !right) return progress >= 0.5 ? highlight : base;
  const amount = Math.max(0, Math.min(1, progress));
  const channel = (index: number) => Math.round(
    Number.parseInt(left[index]!, 16) * (1 - amount) + Number.parseInt(right[index]!, 16) * amount,
  ).toString(16).padStart(2, "0");
  return `#${channel(1)}${channel(2)}${channel(3)}`.toUpperCase();
}

function assFontMetricScale(fontFamily: string): { fontSize: number; horizontalPercent: number } {
  // Noto CJK faces expose different em/advance metrics in libass and Skia.
  // These values are measured from the same bundled fonts in the production
  // Debian/libass container. All Noto CJK variants need the lower em scale;
  // leaving TC on the generic 1.5 scale makes a 34px real-world cue 999px wide
  // while its Canvas-measured background is only 936px. JP uses the same
  // horizontal advance as Canvas after a small Linux/libass correction; the
  // former 108% expansion made long source captions escape their content-sized
  // background. KR needs a narrower one.
  const family = assFontFamily(fontFamily);
  if (/^Noto\s+(?:Sans|Serif)\s+JP$/i.test(family)) {
    return { fontSize: 1.34, horizontalPercent: process.platform === "linux" ? 97 : 108 };
  }
  if (/^Noto\s+(?:Sans|Serif)\s+KR$/i.test(family)) {
    return { fontSize: 1.34, horizontalPercent: 85 };
  }
  if (/^Noto\s+(?:Sans|Serif)\s+(?:TC|SC|HK)$/i.test(family)) {
    // Windows' libass/DirectWrite path already matches Skia at 1.5. The
    // production Linux/fontconfig path renders the same variable font about
    // 12% larger, so apply the container-specific correction at runtime.
    return { fontSize: process.platform === "linux" ? 1.34 : ASS_CANVAS_FONT_SCALE, horizontalPercent: 100 };
  }
  return { fontSize: ASS_CANVAS_FONT_SCALE, horizontalPercent: 100 };
}

function assRunText(
  run: SubtitleCanvasRun,
  style: SubtitleCanvasStyle,
  scale: number,
  horizontalPercent: number,
  renderMode: "crisp" | "glow" = "crisp",
): string {
  const crispColor = run.highlightProgress != null && run.highlightColor
    ? blendHexColor(run.color ?? style.color, run.highlightColor, run.highlightProgress)
    : run.color ?? style.color;
  const isGlowing = Boolean(run.glowColor);
  const color = renderMode === "glow" && run.glowColor ? run.glowColor : crispColor;
  const runScale = Math.max(0.01, run.scale ?? 1) * 100;
  // libass's \blur softens the glyph itself, whereas Canvas shadowBlur keeps a
  // crisp glyph above the halo. Render glow as a separate, subdued event and
  // always keep the foreground event perfectly sharp.
  const opacity = renderMode === "glow"
    ? (isGlowing ? style.opacity * (run.opacity ?? 1) * 0.8 : 0)
    : style.opacity * (run.opacity ?? 1);
  const blur = renderMode === "glow" && isGlowing
    ? Math.min(8, Math.max(2, (run.glowBlur ?? style.fontSize * 0.24) * scale / 2))
    : 0;
  const underline = renderMode === "crisp" && (style.underline || Boolean(run.underlineColor));
  const tags = [
    `\\c${assColor(color).replace(/^&H[0-9A-F]{2}/, "&H")}`,
    // Only fade the glyph fill. ASS's generic \\alpha also changes the box,
    // outline and shadow, which fragments a uniform caption background when
    // karaoke marks future words as translucent.
    `\\1a&H${assAlpha(opacity)}&`,
    `\\fscx${(runScale * horizontalPercent / 100).toFixed(2)}`,
    `\\fscy${runScale.toFixed(2)}`,
    `\\blur${blur.toFixed(2)}`,
    ...(renderMode === "glow" ? ["\\bord0", "\\shad0"] : []),
    `\\u${underline ? 1 : 0}`,
  ];
  return `{${tags.join("")}}${escapeAssText(run.text)}`;
}

function assDialogueText(
  text: string,
  style: SubtitleCanvasStyle,
  runs: SubtitleCanvasRun[] | undefined,
  scaleX: number,
  scaleY: number,
  positionY = style.positionY,
  horizontalPercent = assFontMetricScale(style.fontFamily).horizontalPercent,
  renderMode: "crisp" | "glow" = "crisp",
): string {
  const scale = Math.min(scaleX, scaleY);
  const fontMetric = assFontMetricScale(style.fontFamily);
  // libass sizes CJK glyphs from the font's em square, while Canvas `px`
  // sizing uses the CSS text box. With the bundled Noto Sans TC face that
  // makes an uncorrected ASS caption about one third smaller than the editor.
  // The per-family conversion keeps exported glyphs and multi-line leading
  // aligned with the canonical Canvas preview without bringing back PNG frame
  // generation.
  const prefix = [
    "\\an5",
    // Canvas already resolved the authoritative line break for this event.
    // Without \q2 libass may wrap that same line a second time near a font-
    // metric boundary, leaving the newly-created line outside the Canvas-
    // measured background rectangle.
    "\\q2",
    `\\pos(${(style.positionX * scaleX).toFixed(2)},${(positionY * scaleY).toFixed(2)})`,
    `\\fs${(style.fontSize * scale * fontMetric.fontSize).toFixed(2)}`,
    `\\fscx${horizontalPercent.toFixed(2)}`,
    `\\fsp${(style.letterSpacing * scaleX).toFixed(2)}`,
  ].join("");
  if (!runs?.length) return `{${prefix}}${escapeAssText(text)}`;
  return `{${prefix}}${runs.map((run) => assRunText(run, style, scale, horizontalPercent, renderMode)).join("")}`;
}

function assLineHorizontalPercent(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  canvasWidth: number,
  text: string,
  style: SubtitleCanvasStyle,
): number {
  const basePercent = assFontMetricScale(style.fontFamily).horizontalPercent;
  const measuredWidth = measureSubtitleCanvasTextWidth(ctx, text, style);
  if (measuredWidth <= 0) return basePercent;
  // `prewrapped` means that the editor chose the line break; it does not mean
  // that the line is allowed to escape the caption box. This is especially
  // important for ASS export because libass and Canvas can have slightly
  // different glyph advances. Keep the final line inside the same content
  // width used by the Canvas renderer, for every font and platform.
  const maximumWidth = Math.max(style.fontSize, Math.min(canvasWidth, style.maxWidth));
  const maximumTextWidth = Math.max(style.fontSize, maximumWidth - style.backgroundPaddingX * 2);
  const maxWidthCorrection = Math.min(1, maximumTextWidth / measuredWidth);
  if (process.platform !== "linux") return basePercent * maxWidthCorrection;
  const family = assFontFamily(style.fontFamily);
  if (/^Noto\s+(?:Sans|Serif)\s+JP$/i.test(family)) {
    // Noto JP's libass advances track Canvas closely through 36px, then grow
    // progressively wider at larger sizes. This curve comes from the Linux
    // production matrix at every editor stop (14..72px), including the real
    // long Japanese source cue that previously escaped its background.
    return Math.max(84, basePercent - Math.max(0, style.fontSize - 36) * 0.22) * maxWidthCorrection;
  }
  if (!/^Noto\s+(?:Sans|Serif)\s+(?:TC|SC|HK)$/i.test(family)) return basePercent * maxWidthCorrection;

  const foreignRuns: string[] = text.match(/[\p{Script=Latin}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}0-9]+/gu) ?? [];
  const foreignWidth = foreignRuns.reduce<number>(
    (width, run) => width + measureSubtitleCanvasTextWidth(ctx, run, { ...style, letterSpacing: 0 }),
    0,
  );
  const foreignFraction = Math.max(0, Math.min(1, foreignWidth / measuredWidth));
  // Linux libass makes Latin/kana/hangul runs in the bundled TC variable font
  // wider than Skia. The background is content-sized, not maxWidth-sized, so
  // this correction must apply to every mixed-script line. Applying it only
  // when a line approached maxWidth left shorter proper-name captions (for
  // example "Hearts to Hearts ... Carmen") visibly outside their box.
  const expectedExpansion = 1 + Math.min(0.18, foreignFraction * 0.3);
  const metricCorrection = 1 / expectedExpansion;
  return basePercent * metricCorrection * maxWidthCorrection;
}

/**
 * libass interprets Fontsize against the font em square. Canvas/CSS `px`
 * sizing is visibly larger for the bundled CJK fonts, so an uncorrected ASS
 * export is roughly one third smaller than the browser preview.
 */
const ASS_CANVAS_FONT_SCALE = 1.5;

function assStyleLine(
  cueIndex: number,
  style: SubtitleCanvasStyle,
  specWidth: number,
  specHeight: number,
  outputWidth: number,
  outputHeight: number,
): string {
  const scaleX = outputWidth / specWidth;
  const scaleY = outputHeight / specHeight;
  const scale = Math.min(scaleX, scaleY);
  const fontMetric = assFontMetricScale(style.fontFamily);
  const halfWidth = Math.min(specWidth, style.maxWidth) / 2;
  const marginLeft = Math.max(0, Math.round((style.positionX - halfWidth) * scaleX));
  const marginRight = Math.max(0, Math.round((specWidth - style.positionX - halfWidth) * scaleX));
  // Caption backgrounds are emitted as one vector box per Canvas text block.
  // BorderStyle 3 paints one opaque box per ASS line and can never match the
  // single rounded rectangle used by the editor preview.
  const borderStyle = 1;
  const outline = style.outline * scale;
  const shadow = style.shadow ? Math.max(1, 2 * scale) : 0;
  const outlineColor = assColor("#000000", style.opacity);
  const shadowColor = style.shadow
    ? assColor("#000000", 0.75 * style.opacity)
    : assColor("#000000", 0);
  return [
    `Style: Cue${cueIndex}`,
    assFontFamily(style.fontFamily),
    (style.fontSize * scale * fontMetric.fontSize).toFixed(2),
    assColor(style.color, style.opacity),
    assColor(style.color, style.opacity),
    outlineColor,
    shadowColor,
    style.fontWeight >= 600 ? -1 : 0,
    style.italic ? -1 : 0,
    style.underline ? -1 : 0,
    0,
    // Keep the style geometry at 100%. Per-font horizontal correction is
    // applied only to text events; scaling the ASS style also compresses the
    // vector background path around the origin and shifts the whole box.
    100,
    100,
    (style.letterSpacing * scaleX).toFixed(2),
    0,
    borderStyle,
    outline.toFixed(2),
    shadow.toFixed(2),
    5,
    marginLeft,
    marginRight,
    0,
    1,
  ].join(",");
}

function assRoundedRectDrawing(
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
  scaleX: number,
  scaleY: number,
): string {
  const x0 = left * scaleX;
  const y0 = top * scaleY;
  const x1 = right * scaleX;
  const y1 = bottom * scaleY;
  const rx = Math.max(0, Math.min(radius * scaleX, (x1 - x0) / 2));
  const ry = Math.max(0, Math.min(radius * scaleY, (y1 - y0) / 2));
  const k = 0.5522847498;
  const n = (value: number) => value.toFixed(2);
  if (rx < 0.01 || ry < 0.01) {
    return `m ${n(x0)} ${n(y0)} l ${n(x1)} ${n(y0)} ${n(x1)} ${n(y1)} ${n(x0)} ${n(y1)}`;
  }
  return [
    `m ${n(x0 + rx)} ${n(y0)}`,
    `l ${n(x1 - rx)} ${n(y0)}`,
    `b ${n(x1 - rx + rx * k)} ${n(y0)} ${n(x1)} ${n(y0 + ry - ry * k)} ${n(x1)} ${n(y0 + ry)}`,
    `l ${n(x1)} ${n(y1 - ry)}`,
    `b ${n(x1)} ${n(y1 - ry + ry * k)} ${n(x1 - rx + rx * k)} ${n(y1)} ${n(x1 - rx)} ${n(y1)}`,
    `l ${n(x0 + rx)} ${n(y1)}`,
    `b ${n(x0 + rx - rx * k)} ${n(y1)} ${n(x0)} ${n(y1 - ry + ry * k)} ${n(x0)} ${n(y1 - ry)}`,
    `l ${n(x0)} ${n(y0 + ry)}`,
    `b ${n(x0)} ${n(y0 + ry - ry * k)} ${n(x0 + rx - rx * k)} ${n(y0)} ${n(x0 + rx)} ${n(y0)}`,
  ].join(" ");
}

function assBackgroundText(
  style: SubtitleCanvasStyle,
  bounds: { left: number; top: number; right: number; bottom: number },
  scaleX: number,
  scaleY: number,
): string {
  const color = assColor(style.backgroundColor).replace(/^&H[0-9A-F]{2}/, "&H");
  const alpha = assAlpha(style.backgroundOpacity * style.opacity);
  const drawing = assRoundedRectDrawing(
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    style.backgroundRadius,
    scaleX,
    scaleY,
  );
  return `{\\an7\\pos(0,0)\\fscx100\\fscy100\\p1\\bord0\\shad0\\1c${color}\\1a&H${alpha}&}${drawing}{\\p0}`;
}

/**
 * Generate one compact ASS subtitle script. Dynamic word states reuse the
 * editor's deterministic frame resolver, but FFmpeg/libass rasterizes them
 * directly during encode instead of Node allocating and compressing thousands
 * of full-resolution transparent PNG files.
 */
export async function writeSubtitleAssFile(
  spec: VideoRenderSpec,
  outputPath: string,
  outputWidth = OUTPUT_WIDTH,
  outputHeight = OUTPUT_HEIGHT,
  onProgress?: (completedIntervals: number, totalIntervals: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  throwIfRenderAborted(signal);
  initializeSubtitleFonts([...new Set(spec.cues.flatMap((cue) => [
    assFontFamily(cue.style.fontFamily),
    subtitleFontFamilyForText(cue.style.fontFamily, cue.text, cue.track),
  ]))]);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const intervals = subtitleTimelineIntervals(spec);
  if (!intervals.length) throw new Error("subtitle timeline is empty");
  const scaleX = outputWidth / spec.width;
  const scaleY = outputHeight / spec.height;
  // One reusable surface is enough to obtain the exact Canvas wrapping and
  // background bounds. Unlike the removed PNG pipeline, this surface is never
  // encoded or retained per frame.
  const measurementCanvas = createCanvas(spec.width, spec.height);
  const measurementContext = measurementCanvas.getContext("2d");
  const styles = spec.cues.map((cue, cueIndex) => assStyleLine(
    cueIndex,
    {
      ...cue.style,
      fontFamily: subtitleFontFamilyForText(cue.style.fontFamily, cue.text, cue.track),
    },
    spec.width,
    spec.height,
    outputWidth,
    outputHeight,
  ));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${outputWidth}`,
    `PlayResY: ${outputHeight}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ].join("\n");
  const file = await fs.promises.open(outputPath, "w");
  let pendingDialogue: string[] = [];
  onProgress?.(0, intervals.length);
  try {
    await file.writeFile(`${header}\n`, "utf8");
    for (const [intervalIndex, interval] of intervals.entries()) {
      throwIfRenderAborted(signal);
      // ASS timestamps only have centisecond precision. Rounding every short
      // karaoke phase independently and forcing a 1 cs duration makes adjacent
      // phases overlap, so duplicate text states are composited in the same
      // frame. Quantize shared boundaries in one direction and drop phases
      // that cannot be represented at 10 ms instead.
      const startCentiseconds = Math.ceil(interval.start * 100 - 1e-7);
      const endCentiseconds = Math.ceil(interval.end * 100 - 1e-7);
      if (endCentiseconds <= startCentiseconds) {
        onProgress?.(intervalIndex + 1, intervals.length);
        continue;
      }
      const quantizedMidpoint = (startCentiseconds + endCentiseconds) / 200;
      const frameTime = Math.max(interval.start, Math.min(interval.end - 1e-7, quantizedMidpoint));
      for (const cueIndex of interval.activeCueIndexes) {
        const cue = spec.cues[cueIndex]!;
        const frame = dynamicSubtitleFrame(cue.text, cue.dynamic?.words, cue.style, frameTime, {
          preset: cue.dynamic?.preset ?? "none",
          highlightColor: cue.dynamic?.highlightColor,
          start: cue.start,
          end: cue.end,
        });
        if (!frame.text) continue;
        let renderedStyle = {
          ...frame.style,
          fontFamily: subtitleFontFamilyForText(frame.style.fontFamily, frame.text, cue.track),
        };
        let bounds = renderSubtitleCanvas(
          measurementContext,
          spec.width,
          spec.height,
          frame.text,
          renderedStyle,
          true,
          frame.runs,
        );
        const positionX = Math.max(bounds.width / 2, Math.min(spec.width - bounds.width / 2, renderedStyle.positionX));
        const positionY = Math.max(bounds.height / 2, Math.min(spec.height - bounds.height / 2, renderedStyle.positionY));
        if (positionX !== renderedStyle.positionX || positionY !== renderedStyle.positionY) {
          renderedStyle = { ...renderedStyle, positionX, positionY };
          bounds = renderSubtitleCanvas(
            measurementContext,
            spec.width,
            spec.height,
            frame.text,
            renderedStyle,
            true,
            frame.runs,
          );
        }
        const eventPrefix = [
          assTime(startCentiseconds / 100),
          assTime(endCentiseconds / 100),
          `Cue${cueIndex}`,
          "",
          0,
          0,
          0,
          "",
        ];
        const layerBase = cueIndex * 3;
        if (renderedStyle.backgroundEnabled) {
          pendingDialogue.push([
            `Dialogue: ${layerBase}`,
            ...eventPrefix,
            assBackgroundText(renderedStyle, bounds, scaleX, scaleY),
          ].join(","));
        }
        if (frame.runs?.length) {
          // Dynamic runs carry per-word ASS tags, but still need the exact
          // Canvas line breaks. Keeping every run in one ASS event lets long
          // source transcripts escape the measured background box.
          const runLines = layoutSubtitleCanvasRunLines(
            measurementContext,
            spec.width,
            renderedStyle,
            frame.runs,
          );
          const lineHeight = renderedStyle.fontSize * renderedStyle.lineHeight;
          for (const [lineIndex, lineRuns] of runLines.entries()) {
            const lineText = lineRuns.map((run) => run.text).join("");
            const lineY = (bounds.contentTop ?? bounds.top + renderedStyle.backgroundPaddingY)
              + lineHeight * (lineIndex + 0.5);
            const horizontalPercent = assLineHorizontalPercent(
              measurementContext,
              spec.width,
              lineText,
              renderedStyle,
            );
            if (lineRuns.some((run) => Boolean(run.glowColor))) {
              pendingDialogue.push([
                `Dialogue: ${layerBase + 1}`,
                ...eventPrefix,
                assDialogueText(
                  lineText,
                  renderedStyle,
                  lineRuns,
                  scaleX,
                  scaleY,
                  lineY,
                  horizontalPercent,
                  "glow",
                ),
              ].join(","));
            }
            pendingDialogue.push([
              `Dialogue: ${layerBase + 2}`,
              ...eventPrefix,
              assDialogueText(
                lineText,
                renderedStyle,
                lineRuns,
                scaleX,
                scaleY,
                lineY,
                horizontalPercent,
              ),
            ].join(","));
          }
        } else {
          const lineHeight = renderedStyle.fontSize * renderedStyle.lineHeight;
          for (const [lineIndex, line] of bounds.lines.entries()) {
            const lineY = (bounds.contentTop ?? bounds.top + renderedStyle.backgroundPaddingY)
              + lineHeight * (lineIndex + 0.5);
            pendingDialogue.push([
              `Dialogue: ${layerBase + 2}`,
              ...eventPrefix,
              assDialogueText(
                line,
                renderedStyle,
                undefined,
                scaleX,
                scaleY,
                lineY,
                assLineHorizontalPercent(measurementContext, spec.width, line, renderedStyle),
              ),
            ].join(","));
          }
        }
      }
      if (pendingDialogue.length >= 256) {
        await file.writeFile(`${pendingDialogue.join("\n")}\n`, "utf8");
        pendingDialogue = [];
      }
      onProgress?.(intervalIndex + 1, intervals.length);
    }
    if (pendingDialogue.length) await file.writeFile(`${pendingDialogue.join("\n")}\n`, "utf8");
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await fs.promises.rm(outputPath, { force: true });
    throw error;
  }
  throwIfRenderAborted(signal);
  return outputPath;
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]");
}

export function subtitleAssFilter(assPath: string): string {
  const fontsDir = subtitleFontsDirectory();
  const filename = escapeFfmpegFilterPath(assPath);
  const fonts = fontsDir ? `:fontsdir='${escapeFfmpegFilterPath(fontsDir)}'` : "";
  return `ass=filename='${filename}'${fonts}`;
}

export async function renderSubtitleVideo(
  inputPath: string,
  spec: VideoRenderSpec,
  renderDir: string,
  outputPath: string,
  options: VideoRenderOptions = DEFAULT_VIDEO_RENDER_OPTIONS,
  onProgress?: (seconds: number) => void,
  onPreparingProgress?: (completedIntervals: number, totalIntervals: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfRenderAborted(signal);
  const assPath = await writeSubtitleAssFile(
    spec,
    path.join(renderDir, "subtitles.ass"),
    options.width,
    options.height,
    onPreparingProgress,
    signal,
  );
  throwIfRenderAborted(signal);
  const selection = await selectVideoEncoder(options.gpuAcceleration);

  const baseArguments = [
      "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
      "-filter_complex",
      `[0:v]scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2[base];[base]${subtitleAssFilter(assPath)}[outv]`,
      "-map", "[outv]", "-map", "0:a?",
  ];
  const encode = (encoder: SubtitleVideoEncoder) => runFfmpeg([
    ...baseArguments,
    ...videoEncoderArguments(encoder, options.quality),
    ...(options.frameRate === "source" ? [] : ["-r", String(options.frameRate)]),
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", outputPath,
  ], onProgress, signal);

  if (selection.encoder === "libx264") {
    logger.info({ encoder: selection.encoder, mode: selection.mode, options }, "[subtitleVideoRenderer] export encoder selected");
    await encode("libx264");
    return;
  }

  try {
    logger.info({ encoder: selection.encoder, mode: selection.mode, options }, "[subtitleVideoRenderer] export encoder selected");
    await encode("h264_nvenc");
  } catch (error) {
    throwIfRenderAborted(signal);
    if (!selection.allowCpuFallback) throw error;
    // Auto mode must remain usable when the GPU becomes unavailable after the
    // capability probe (driver reset, exhausted NVENC sessions, etc.).
    logger.warn({ err: error }, "[subtitleVideoRenderer] NVENC failed; retrying with libx264");
    await fs.promises.rm(outputPath, { force: true });
    await encode("libx264");
  }
}

