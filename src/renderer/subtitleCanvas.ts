export type SubtitleCanvasStyle = {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
  opacity: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundRadius: number;
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  outline: number;
  shadow: boolean;
  italic: boolean;
  underline: boolean;
  positionX: number;
  positionY: number;
  maxWidth: number;
  /** Preserve explicit line breaks. Explicit lines are still width constrained. */
  prewrapped?: boolean;
};

export type DynamicSubtitlePreset = "none" | "typewriter" | "word-pop" | "highlight" | "karaoke" | "bounce" | "neon" | "box";

export type SubtitleTimestampedWord = {
  word: string;
  start: number;
  end: number;
};

export type DynamicSubtitleOptions = {
  preset: DynamicSubtitlePreset;
  highlightColor?: string;
  /** Cue bounds used to synthesize character timing when translated text has
   * no word-level timestamps. */
  start?: number;
  end?: number;
};

export type SubtitleCanvasRun = {
  text: string;
  color?: string;
  opacity?: number;
  scale?: number;
  offsetY?: number;
  /** Optional per-word glow, used by active-word effects. */
  glowColor?: string;
  glowBlur?: number;
  /** Optional underline drawn only below this run. */
  underlineColor?: string;
  underlineWidth?: number;
  /** Draw the left portion of this run in highlightColor (0..1). */
  highlightProgress?: number;
  highlightColor?: string;
};

export type DynamicSubtitleFrame = {
  text: string;
  style: SubtitleCanvasStyle;
  runs?: SubtitleCanvasRun[];
};

function joinTimestampedWords(words: SubtitleTimestampedWord[]): string {
  return words.reduce((text, { word }) => {
    if (!text) return word;
    const previous = text.at(-1) ?? "";
    const next = word.at(0) ?? "";
    return /^[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]$/.test(next) ? `${text} ${word}` : `${text}${word}`;
  }, "");
}

function dynamicSubtitleTokens(value: string): string[] {
  return value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s]+/gu)
    ?? (value ? [value] : []);
}

function timestampedWordRuns(
  text: string,
  words: SubtitleTimestampedWord[],
): Array<SubtitleTimestampedWord & { display: string }> {
  let previous = "";
  const runs = words.map((word) => {
    const previousCharacter = previous.at(-1) ?? "";
    const nextCharacter = word.word.at(0) ?? "";
    const separator = previous && /^[A-Za-z0-9]$/.test(previousCharacter) && /^[A-Za-z0-9]$/.test(nextCharacter) ? " " : "";
    const display = `${separator}${word.word}`;
    previous += display;
    return { ...word, display };
  });

  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.length <= 1 || runs.length <= 1) return runs;

  const boundaries = lines.slice(0, -1).map((_, lineIndex) => (
    lines.slice(0, lineIndex + 1).reduce((count, line) => count + dynamicSubtitleTokens(line).length, 0)
  ));
  let consumedTokens = 0;
  let boundaryIndex = 0;
  return runs.map((run, runIndex) => {
    while (boundaryIndex < boundaries.length && consumedTokens >= (boundaries[boundaryIndex] ?? Number.POSITIVE_INFINITY)) {
      boundaryIndex += 1;
      if (runIndex > 0) {
        return { ...run, display: `\n${run.display.trimStart()}` };
      }
    }
    consumedTokens += Math.max(1, dynamicSubtitleTokens(run.word).length);
    return run;
  });
}

function joinTimestampedWordRuns(words: Array<SubtitleTimestampedWord & { display: string }>): string {
  return words.map((word) => word.display).join("");
}

type TimedDisplayRun = SubtitleTimestampedWord & { display: string };

function syntheticCharacterRuns(text: string, start: number, end: number): TimedDisplayRun[] {
  const characters = Array.from(text.replace(/\r/g, ""));
  const animatedCount = characters.filter((character) => character.trim().length > 0).length;
  if (animatedCount === 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const duration = end - start;
  let animatedIndex = 0;
  return characters.map((character) => {
    if (!character.trim()) {
      const boundary = start + (animatedIndex / animatedCount) * duration;
      return { word: character, display: character, start: boundary, end: boundary };
    }
    const runStart = start + (animatedIndex / animatedCount) * duration;
    animatedIndex += 1;
    return {
      word: character,
      display: character,
      start: runStart,
      end: start + (animatedIndex / animatedCount) * duration,
    };
  });
}

function resolvedTimedRuns(
  text: string,
  words: SubtitleTimestampedWord[] | undefined,
  options: DynamicSubtitleOptions | undefined,
): TimedDisplayRun[] {
  if (words?.length) return timestampedWordRuns(text, words);
  return syntheticCharacterRuns(text, options?.start ?? Number.NaN, options?.end ?? Number.NaN);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(value: number): number {
  const progress = clampProgress(value);
  return 1 - (1 - progress) ** 3;
}

// U+2502 can fall back to a CJK font in libass and use different side
// bearings than Canvas measured for it.
const TYPEWRITER_CURSOR = "|";
const TYPEWRITER_CURSOR_SAFETY_EM = 0.7;

/** Match the landing-page pop: 0.72 -> 1.22 -> 1 over 320 ms. */
function popScale(elapsed: number): number {
  const progress = clampProgress(elapsed / 0.32);
  if (progress < 0.5) return 0.72 + easeOutCubic(progress / 0.5) * 0.5;
  return 1.22 - easeOutCubic((progress - 0.5) / 0.5) * 0.22;
}

/** Timeline samples used by video export so the Canvas motion is preserved. */
export function dynamicSubtitleTimelinePoints(
  text: string,
  words: SubtitleTimestampedWord[] | undefined,
  options: DynamicSubtitleOptions,
): number[] {
  if (options.preset === "none") return [];
  return resolvedTimedRuns(text, words, options).flatMap((run) => {
    if (!run.word.trim()) return [];
    if (options.preset === "typewriter") {
      return [run.start, Math.min(run.end, run.start + 0.05), Math.min(run.end, run.start + 0.1), run.end];
    }
    if (options.preset === "karaoke") {
      const duration = run.end - run.start;
      return [run.start, run.start + duration * 0.25, run.start + duration * 0.5, run.start + duration * 0.75, run.end];
    }
    if (options.preset === "word-pop" || options.preset === "neon" || options.preset === "bounce") {
      return [
        run.start,
        Math.min(run.end, run.start + 0.08),
        Math.min(run.end, run.start + 0.16),
        Math.min(run.end, run.start + 0.24),
        Math.min(run.end, run.start + 0.32),
        run.end,
      ];
    }
    return [run.start, run.end];
  });
}

/** Resolve a deterministic subtitle frame shared by browser preview and export. */
export function dynamicSubtitleFrame(
  text: string,
  words: SubtitleTimestampedWord[] | undefined,
  style: SubtitleCanvasStyle,
  time: number,
  options?: DynamicSubtitleOptions,
): DynamicSubtitleFrame {
  const preset = options?.preset ?? "none";
  if (preset === "none") return { text, style };
  const wordRuns = resolvedTimedRuns(text, words, options);
  if (!wordRuns.length) return { text, style };
  const animatedRuns = wordRuns.filter((word) => word.word.trim().length > 0);
  const spoken = animatedRuns.filter((word) => word.start <= time);
  const current = animatedRuns.find((word) => time >= word.start && time < word.end)
    ?? spoken.at(-1)
    ?? animatedRuns[0];
  if (preset === "typewriter") {
    const visible = wordRuns.filter((word) => word.start <= time);
    const cursorOpacity = 0.45 + 0.55 * ((Math.sin(time * Math.PI * 4) + 1) / 2);
    const typewriterStyle = {
      ...style,
      // Reserve the cursor plus Canvas/libass advance differences and make a
      // long line wrap before it can touch the background edge.
      backgroundPaddingX: Math.max(
        style.backgroundPaddingX,
        style.fontSize * TYPEWRITER_CURSOR_SAFETY_EM,
      ),
    };
    return {
      text: `${joinTimestampedWordRuns(visible)}${TYPEWRITER_CURSOR}`,
      style: typewriterStyle,
      runs: [
        ...visible.map((word) => ({
          text: word.display,
          opacity: clampProgress((time - word.start) / 0.1),
        })),
        { text: TYPEWRITER_CURSOR, opacity: cursorOpacity },
      ],
    };
  }
  if (!current) return { text, style };

  const highlightColor = options?.highlightColor ?? "#FFE84A";
  if (preset === "highlight") {
    return {
      text,
      style,
      runs: wordRuns.map((word) => ({
        text: word.display,
        color: word.start <= time && word.word.trim() ? highlightColor : style.color,
        opacity: word.start > time && word.word.trim() ? 0.45 : 1,
      })),
    };
  }
  if (preset === "karaoke") {
    const duration = Math.max(0.04, current.end - current.start);
    const progress = Math.max(0, Math.min(1, (time - current.start) / duration));
    return {
      text,
      style,
      runs: wordRuns.map((word) => ({
        text: word.display,
        color: word.end <= time ? highlightColor : style.color,
        opacity: word.start > time && word.word.trim() ? 0.45 : 1,
        highlightProgress: word === current ? progress : undefined,
        highlightColor,
      })),
    };
  }
  if (preset === "bounce") {
    const activeProgress = clampProgress((time - current.start) / 0.32);
    const lift = Math.sin(activeProgress * Math.PI);
    return {
      text,
      style,
      runs: wordRuns.map((word) => ({
        text: word.display,
        color: word === current ? highlightColor : style.color,
        scale: word === current ? 1 + lift * 0.2 : 1,
        offsetY: word === current ? -7 * lift : 0,
      })),
    };
  }
  if (preset === "neon") {
    const activeText = current.word.trim() || current.display.trim();
    return {
      text: activeText,
      style,
      // Neon pop is deliberately a single active word/character. Showing the
      // complete cue with past text yellow and future text dimmed turns it into
      // karaoke, which is already a separate preset and contradicts the compact
      // "HEY" preview card in the editor.
      runs: [{
        text: activeText,
        color: highlightColor,
        scale: popScale(time - current.start),
        glowColor: highlightColor,
        glowBlur: Math.max(8, style.fontSize * 0.24),
      }],
    };
  }
  if (preset === "box") {
    return {
      text,
      style,
      runs: wordRuns.map((word) => ({
        text: word.display,
        color: word === current ? highlightColor : style.color,
        scale: word === current ? 1.06 : 1,
        offsetY: word === current ? -1 : 0,
        glowColor: word === current ? highlightColor : undefined,
        glowBlur: word === current ? Math.max(6, style.fontSize * 0.18) : undefined,
        underlineColor: word === current ? highlightColor : undefined,
        underlineWidth: word === current ? Math.max(2, style.fontSize * 0.09) : undefined,
      })),
    };
  }

  return {
    text,
    style,
    runs: wordRuns.map((word) => ({
      text: word.display,
      color: word === current ? highlightColor : style.color,
      scale: word === current ? popScale(time - current.start) : 1,
    })),
  };
}

export type SubtitleCanvasBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  lines: string[];
  /** Top edge of the line box after background/effect insets. */
  contentTop?: number;
};

type CanvasContext = SKRSContext2D;

type PositionedRun = SubtitleCanvasRun & { width: number };

const MAX_DYNAMIC_RUN_SCALE = 1.22;
const MAX_DYNAMIC_RUN_LIFT = 7;

function rgba(hex: string, opacity: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16) || 0;
  const green = Number.parseInt(value.slice(2, 4), 16) || 0;
  const blue = Number.parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, opacity))})`;
}

function canvasFontFamily(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .map((family) => /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family)
      ? family
      : `"${family.replace(/"/g, "\\\"")}"`)
    .join(", ");
}

function fontValue(style: SubtitleCanvasStyle): string {
  const family = canvasFontFamily(style.fontFamily) || '"Noto Sans TC", sans-serif';
  return `${style.italic ? "italic " : ""}${style.fontWeight} ${style.fontSize}px ${family}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function textWidth(ctx: CanvasContext, text: string, letterSpacing: number): number {
  return ctx.measureText(text).width + Math.max(0, graphemes(text).length - 1) * letterSpacing;
}

function textInkOverhang(ctx: CanvasContext, text: string, advanceWidth: number): number {
  const previousAlign = ctx.textAlign;
  ctx.textAlign = "left";
  const metrics = ctx.measureText(text);
  ctx.textAlign = previousAlign;
  const left = Math.max(0, -(metrics.actualBoundingBoxLeft ?? 0));
  const right = Math.max(0, (metrics.actualBoundingBoxRight ?? advanceWidth) - advanceWidth);
  return Math.max(left, right);
}

/** Measure one already-wrapped subtitle line with the exact Canvas font rules. */
export function measureSubtitleCanvasTextWidth(
  ctx: CanvasContext,
  text: string,
  style: SubtitleCanvasStyle,
): number {
  ctx.save();
  ctx.font = fontValue(style);
  const width = textWidth(ctx, text, style.letterSpacing);
  ctx.restore();
  return width;
}

function tokensFor(line: string): string[] {
  // Keep Latin words together but allow CJK text to wrap at each character.
  return line.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]|\s+|[^\s\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu) ?? [line];
}

function splitOversizedToken(
  ctx: CanvasContext,
  token: string,
  maxTextWidth: number,
  letterSpacing: number,
): string[] {
  if (textWidth(ctx, token, letterSpacing) <= maxTextWidth) return [token];
  const chunks: string[] = [];
  let chunk = "";
  for (const grapheme of graphemes(token)) {
    const candidate = chunk + grapheme;
    if (chunk && textWidth(ctx, candidate, letterSpacing) > maxTextWidth) {
      chunks.push(chunk);
      chunk = grapheme;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [token];
}

function wrapSubtitleParagraph(
  ctx: CanvasContext,
  paragraph: string,
  maxTextWidth: number,
  letterSpacing: number,
): string[] {
  if (!paragraph) return [""];
  const output: string[] = [];
  let line = "";
  for (const originalToken of tokensFor(paragraph)) {
    const tokenParts = splitOversizedToken(ctx, originalToken, maxTextWidth, letterSpacing);
    for (const tokenPart of tokenParts) {
      const candidate = line + tokenPart;
      if (line && textWidth(ctx, candidate, letterSpacing) > maxTextWidth) {
        output.push(line.trimEnd());
        line = tokenPart.trimStart();
      } else {
        line = candidate;
      }
    }
  }
  output.push(line.trimEnd());
  return output;
}

export function wrapSubtitleText(
  ctx: CanvasContext,
  text: string,
  maxTextWidth: number,
  letterSpacing: number,
  prewrapped = false,
): string[] {
  // `prewrapped` preserves each explicit newline as a hard boundary, but it
  // never permits an explicit line to escape the caption box. Both modes use
  // the same width-constrained paragraph wrapper.
  void prewrapped;
  const output = text.replace(/\r/g, "").split("\n").flatMap((paragraph) => (
    wrapSubtitleParagraph(ctx, paragraph, maxTextWidth, letterSpacing)
  ));
  return output.length ? output : [""];
}

function roundedRect(ctx: CanvasContext, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSpacedText(ctx: CanvasContext, text: string, centerX: number, y: number, spacing: number, stroke: boolean) {
  if (!spacing) {
    if (stroke) ctx.strokeText(text, centerX, y);
    else ctx.fillText(text, centerX, y);
    return;
  }
  const width = textWidth(ctx, text, spacing);
  let x = centerX - width / 2;
  for (const character of graphemes(text)) {
    const characterWidth = ctx.measureText(character).width;
    const characterCenter = x + characterWidth / 2;
    if (stroke) ctx.strokeText(character, characterCenter, y);
    else ctx.fillText(character, characterCenter, y);
    x += characterWidth + spacing;
  }
}

function splitCanvasRuns(runs: SubtitleCanvasRun[]): SubtitleCanvasRun[] {
  return runs.flatMap((run) => {
    const paragraphs = run.text.replace(/\r/g, "").split("\n");
    return paragraphs.flatMap((paragraph, index) => [
      ...(tokensFor(paragraph).map((text) => ({ ...run, text }))),
      ...(index < paragraphs.length - 1 ? [{ ...run, text: "\n" }] : []),
    ]);
  });
}

function layoutCanvasRuns(
  ctx: CanvasContext,
  runs: SubtitleCanvasRun[],
  maxWidth: number,
  letterSpacing: number,
  prewrapped = false,
): PositionedRun[][] {
  const lines: PositionedRun[][] = [[]];
  let lineWidth = 0;
  for (const run of splitCanvasRuns(runs)) {
    if (run.text === "\n") {
      lines.push([]);
      lineWidth = 0;
      continue;
    }
    void prewrapped;
    const parts = splitOversizedToken(ctx, run.text, maxWidth, letterSpacing);
    for (let text of parts) {
      if (!lines.at(-1)?.length) text = text.trimStart();
      if (!text) continue;
      let width = textWidth(ctx, text, letterSpacing);
      if (lineWidth > 0 && lineWidth + width > maxWidth) {
        lines.push([]);
        lineWidth = 0;
        text = text.trimStart();
        if (!text) continue;
        width = textWidth(ctx, text, letterSpacing);
      }
      lines[lines.length - 1]!.push({ ...run, text, width });
      lineWidth += width;
    }
  }
  return lines.length ? lines : [[]];
}

/**
 * Return the exact run-level line breaks used by the Canvas preview. Export
 * backends need the styled runs, not only the concatenated `bounds.lines`, so
 * karaoke/highlight captions can preserve wrapping without flattening the
 * whole cue into one oversized ASS line.
 */
export function layoutSubtitleCanvasRunLines(
  ctx: CanvasContext,
  canvasWidth: number,
  style: SubtitleCanvasStyle,
  runs: SubtitleCanvasRun[],
): SubtitleCanvasRun[][] {
  ctx.save();
  ctx.font = fontValue(style);
  const maximumWidth = Math.max(style.fontSize, Math.min(canvasWidth, style.maxWidth));
  const maximumTextWidth = Math.max(style.fontSize, maximumWidth - style.backgroundPaddingX * 2);
  const lines = layoutCanvasRuns(
    ctx,
    runs,
    maximumTextWidth,
    style.letterSpacing,
    style.prewrapped ?? false,
  );
  ctx.restore();
  return lines.map((line) => line.map(({ width: _width, ...run }) => run));
}

function drawRunFill(ctx: CanvasContext, run: PositionedRun, centerX: number, y: number, style: SubtitleCanvasStyle) {
  const draw = (color: string) => {
    ctx.fillStyle = color;
    drawSpacedText(ctx, run.text, centerX, y, style.letterSpacing, false);
  };
  draw(run.color ?? style.color);
  if (run.highlightProgress != null && run.highlightColor && run.highlightProgress > 0) {
    ctx.save();
    const left = centerX - run.width / 2;
    ctx.beginPath();
    ctx.rect(left, y - style.fontSize, run.width * Math.min(1, run.highlightProgress), style.fontSize * 2);
    ctx.clip();
    draw(run.highlightColor);
    ctx.restore();
  }
}

function renderSubtitleRuns(
  ctx: CanvasContext,
  canvasWidth: number,
  canvasHeight: number,
  style: SubtitleCanvasStyle,
  runs: SubtitleCanvasRun[],
  clear: boolean,
): SubtitleCanvasBounds {
  if (clear) ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.save();
  ctx.font = fontValue(style);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const maximumWidth = Math.max(style.fontSize, Math.min(canvasWidth, style.maxWidth));
  const maximumTextWidth = Math.max(style.fontSize, maximumWidth - style.backgroundPaddingX * 2);
  const lines = layoutCanvasRuns(
    ctx,
    runs,
    maximumTextWidth,
    style.letterSpacing,
    style.prewrapped ?? false,
  );
  const lineWidths = lines.map((line) => line.reduce((sum, run) => sum + run.width, 0));
  const lineHeight = style.fontSize * style.lineHeight;
  const measuredWidth = Math.max(...lineWidths, 0);
  const hasDynamicScale = lines.some((line) => line.some((run) => run.scale != null));
  const inkOverhang = Math.max(0, ...lines.flatMap((line) => line.map((run) => (
    textInkOverhang(ctx, run.text, run.width) * (hasDynamicScale ? MAX_DYNAMIC_RUN_SCALE : 1)
  ))));
  // Dynamic presets scale only the active run. Reserve the largest run's
  // peak expansion instead of scaling the whole line, so the box remains
  // compact while the animated glyph can never escape it.
  const dynamicScaleExtra = hasDynamicScale
    ? Math.max(0, ...lines.flatMap((line) => line.map((run) => run.width))) * (MAX_DYNAMIC_RUN_SCALE - 1)
    : 0;
  const horizontalEffects = Math.max(0, style.outline) + inkOverhang;
  const width = Math.min(
    canvasWidth,
    measuredWidth + dynamicScaleExtra + (style.backgroundPaddingX + horizontalEffects) * 2,
  );
  const dynamicLift = lines.some((line) => line.some((run) => run.offsetY != null)) ? MAX_DYNAMIC_RUN_LIFT : 0;
  const verticalEffects = Math.max(0, style.outline) + dynamicLift;
  const height = lines.length * lineHeight
    + (style.backgroundPaddingY + verticalEffects) * 2;
  const left = style.positionX - width / 2;
  const top = style.positionY - height / 2;

  ctx.globalAlpha = style.opacity;
  if (style.backgroundEnabled) {
    ctx.fillStyle = rgba(style.backgroundColor, style.backgroundOpacity);
    roundedRect(ctx, left, top, width, height, style.backgroundRadius);
    ctx.fill();
  }

  lines.forEach((line, lineIndex) => {
    const y = top + style.backgroundPaddingY + verticalEffects + lineHeight * (lineIndex + 0.5);
    let x = style.positionX - lineWidths[lineIndex]! / 2;
    for (const run of line) {
      const centerX = x + run.width / 2;
      ctx.save();
      ctx.globalAlpha = style.opacity * (run.opacity ?? 1);
      ctx.translate(centerX, y + (run.offsetY ?? 0));
      const scale = run.scale ?? 1;
      ctx.scale(scale, scale);
      if (run.glowColor) {
        ctx.shadowColor = run.glowColor;
        // Keep the halo visible after the export pipeline scales the caption
        // down. A blur that is only a few source pixels becomes imperceptible
        // on the final video, especially around bright text.
        ctx.shadowBlur = Math.max(10, run.glowBlur ?? style.fontSize * 0.24);
        ctx.shadowOffsetY = 0;
      } else if (style.shadow) {
        ctx.shadowColor = "rgba(0,0,0,.75)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
      }
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = style.outline * 2;
      if (style.outline > 0) drawSpacedText(ctx, run.text, 0, 0, style.letterSpacing, true);
      drawRunFill(ctx, run, 0, 0, style);
      if (style.underline) {
        ctx.fillStyle = run.color ?? style.color;
        ctx.fillRect(-run.width / 2, style.fontSize * 0.42, run.width, Math.max(1, style.fontSize / 18));
      }
      if (run.underlineColor) {
        ctx.fillStyle = run.underlineColor;
        ctx.fillRect(
          -run.width / 2,
          style.fontSize * 0.46,
          run.width,
          run.underlineWidth ?? Math.max(2, style.fontSize * 0.09),
        );
      }
      ctx.restore();
      x += run.width;
    }
  });
  ctx.restore();
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    lines: lines.map((line) => line.map((run) => run.text).join("")),
    contentTop: top + style.backgroundPaddingY + verticalEffects,
  };
}

/**
 * Shared OpenReel-style renderer. Preview and export call this exact function;
 * the encoder only receives the already-composited pixels.
 */
export function renderSubtitleCanvas(
  ctx: CanvasContext,
  canvasWidth: number,
  canvasHeight: number,
  text: string,
  style: SubtitleCanvasStyle,
  clear = true,
  runs?: SubtitleCanvasRun[],
): SubtitleCanvasBounds {
  if (runs?.length) return renderSubtitleRuns(ctx, canvasWidth, canvasHeight, style, runs, clear);
  if (clear) ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.save();
  ctx.font = fontValue(style);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const maximumWidth = Math.max(style.fontSize, Math.min(canvasWidth, style.maxWidth));
  const maximumTextWidth = Math.max(style.fontSize, maximumWidth - style.backgroundPaddingX * 2);
  const lines = wrapSubtitleText(
    ctx,
    text,
    maximumTextWidth,
    style.letterSpacing,
    style.prewrapped ?? false,
  );
  const lineHeight = style.fontSize * style.lineHeight;
  const measuredWidth = Math.max(...lines.map((line) => textWidth(ctx, line, style.letterSpacing)), 0);
  const inkOverhang = Math.max(0, ...lines.map((line) => (
    textInkOverhang(ctx, line, textWidth(ctx, line, style.letterSpacing))
  )));
  const horizontalEffects = Math.max(0, style.outline) + inkOverhang;
  const width = Math.min(canvasWidth, measuredWidth + (style.backgroundPaddingX + horizontalEffects) * 2);
  const verticalEffects = Math.max(0, style.outline);
  const height = lines.length * lineHeight + (style.backgroundPaddingY + verticalEffects) * 2;
  const left = style.positionX - width / 2;
  const top = style.positionY - height / 2;

  ctx.globalAlpha = style.opacity;
  if (style.backgroundEnabled) {
    ctx.fillStyle = rgba(style.backgroundColor, style.backgroundOpacity);
    roundedRect(ctx, left, top, width, height, style.backgroundRadius);
    ctx.fill();
  }

  if (style.shadow) {
    ctx.shadowColor = "rgba(0,0,0,.75)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
  }
  ctx.fillStyle = style.color;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = style.outline * 2;

  lines.forEach((line, index) => {
    const y = top + style.backgroundPaddingY + verticalEffects + lineHeight * (index + 0.5);
    if (style.outline > 0) drawSpacedText(ctx, line, style.positionX, y, style.letterSpacing, true);
    drawSpacedText(ctx, line, style.positionX, y, style.letterSpacing, false);
    if (style.underline) {
      const lineWidth = textWidth(ctx, line, style.letterSpacing);
      ctx.fillRect(style.positionX - lineWidth / 2, y + style.fontSize * 0.42, lineWidth, Math.max(1, style.fontSize / 18));
    }
  });
  ctx.restore();

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    lines,
    contentTop: top + style.backgroundPaddingY + verticalEffects,
  };
}

import type { SKRSContext2D } from "@napi-rs/canvas";

