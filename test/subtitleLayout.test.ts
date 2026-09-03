import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  dynamicSubtitleFrame,
  measureSubtitleCanvasTextWidth,
  renderSubtitleCanvas,
  wrapSubtitleText,
  type SubtitleCanvasStyle,
} from "../src/renderer/subtitleCanvas.js";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const baseStyle: SubtitleCanvasStyle = {
  fontFamily: "Noto Sans TC",
  fontWeight: 700,
  fontSize: 48,
  lineHeight: 1.375,
  letterSpacing: 0,
  color: "#FFFFFF",
  opacity: 1,
  backgroundEnabled: true,
  backgroundColor: "#000000",
  backgroundOpacity: 0.85,
  backgroundRadius: 8,
  backgroundPaddingX: 16,
  backgroundPaddingY: 8,
  outline: 0,
  shadow: false,
  italic: false,
  underline: false,
  positionX: 640,
  positionY: 360,
  maxWidth: 1178,
};

/**
 * Scan the rendered alpha channel for the real ink box. Deriving the expected
 * extents from the same arithmetic the layout uses would only restate it, so
 * containment is asserted against actual pixels instead.
 */
function inkBounds(data: Uint8ClampedArray, width: number, height: number, threshold = 128) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) < threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, right: right + 1, top, bottom: bottom + 1 };
}

test("never starts a wrapped line with closing punctuation", () => {
  const context = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).getContext("2d");
  context.font = '700 48px "Noto Sans TC"';

  // Break exactly where the full stop would otherwise lead the next line.
  const head = "測試字幕內容";
  const lines = wrapSubtitleText(context, `${head}。`, context.measureText(head).width, 0, false);
  assert.equal(lines.length, 2);
  assert.ok(!lines[1]!.startsWith("。"), `punctuation led a line: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(""), `${head}。`);

  // The mirror rule: an opening bracket may not be left dangling at line end.
  const opening = "他說（";
  const bracketLines = wrapSubtitleText(
    context,
    "他說（重點）",
    context.measureText(opening).width,
    0,
    false,
  );
  assert.ok(!bracketLines[0]!.endsWith("（"), `bracket dangled: ${JSON.stringify(bracketLines)}`);
  assert.equal(bracketLines.join(""), "他說（重點）");
});

test("grows the background past the canvas instead of capping it", () => {
  const context = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).getContext("2d");
  const text = "字".repeat(20);
  const textWidth = measureSubtitleCanvasTextWidth(context, text, baseStyle);
  assert.ok(textWidth < CANVAS_WIDTH - 10, "fixture must fit on one line");

  // Size the content box so the text fills it exactly with no wrap slack, then
  // let padding and outline carry the plate past the frame edge.
  const paddingX = (CANVAS_WIDTH - 10 - textWidth) / 2;
  const style: SubtitleCanvasStyle = {
    ...baseStyle,
    maxWidth: CANVAS_WIDTH - 10,
    backgroundPaddingX: paddingX,
    outline: 12,
  };
  const bounds = renderSubtitleCanvas(context, CANVAS_WIDTH, CANVAS_HEIGHT, text, style, true);

  assert.equal(bounds.lines.length, 1, "fixture must not wrap");
  // Clamping the plate here — while leaving the glyphs unclamped — is exactly
  // what used to push text outside its background.
  assert.ok(
    bounds.width > CANVAS_WIDTH,
    `expected an uncapped box, got ${bounds.width}`,
  );
  assert.equal(bounds.contentOverflow, 0);
});

test("keeps every dynamic preset's ink inside its background box", () => {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const context = canvas.getContext("2d");
  const text = "彈跳字幕測試";
  const words = [...text].map((word, index) => ({
    word,
    start: index * 0.3,
    end: (index + 1) * 0.3,
  }));

  // Zero padding leaves the animation envelope nowhere to hide: any overshoot
  // that is not reserved shows up immediately as ink outside the plate. The
  // first and last words matter most, because only an edge run's expansion can
  // escape the line box.
  // Tight leading removes the vertical slack too, so a bounce lift that is not
  // reserved lands above the plate instead of inside the line box.
  const probeStyle: SubtitleCanvasStyle = {
    ...baseStyle,
    backgroundPaddingX: 0,
    backgroundPaddingY: 0,
    lineHeight: 1.1,
  };
  // 0.16s past a word's start is the peak of the 320 ms pop curve.
  const samples = [0.16, 0.46, 0.76, 1.2, 1.66];
  for (const preset of ["word-pop", "bounce", "neon", "box"] as const) {
    for (const time of samples) {
      const frame = dynamicSubtitleFrame(text, words, probeStyle, time, {
        preset,
        start: 0,
        end: words.length * 0.3,
      });
      const bounds = renderSubtitleCanvas(
        context,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        frame.text,
        { ...frame.style, backgroundEnabled: false },
        true,
        frame.runs,
      );
      const pixels = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
      // Solid glyph body must sit inside the plate; the soft glow halo is held
      // to the same edge at a haze threshold, which is what makes the reserved
      // glow extent observable.
      const glowing = Boolean(frame.runs?.some((run) => run.glowColor));
      for (const threshold of glowing ? [128, 8] : [128]) {
        const ink = inkBounds(pixels, CANVAS_WIDTH, CANVAS_HEIGHT, threshold);
        assert.ok(ink, `${preset}@${time}s rendered nothing`);

        const where = `${preset}@${time}s α>=${threshold} ink=${JSON.stringify(ink)} box=${JSON.stringify({
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          top: Math.round(bounds.top),
          bottom: Math.round(bounds.bottom),
        })}`;
        assert.ok(ink.left >= Math.floor(bounds.left), `left escaped: ${where}`);
        assert.ok(ink.right <= Math.ceil(bounds.right), `right escaped: ${where}`);
        assert.ok(ink.top >= Math.floor(bounds.top), `top escaped: ${where}`);
        assert.ok(ink.bottom <= Math.ceil(bounds.bottom), `bottom escaped: ${where}`);
      }
    }
  }
});

test("reserves room for an underline under tight leading", () => {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const context = canvas.getContext("2d");
  // Tight leading plus zero vertical padding: the underline has to be reserved
  // explicitly or it lands below the plate.
  const style: SubtitleCanvasStyle = {
    ...baseStyle,
    lineHeight: 0.8,
    underline: true,
    backgroundPaddingY: 0,
  };
  const bounds = renderSubtitleCanvas(
    context,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    "底線測試",
    { ...style, backgroundEnabled: false },
    true,
  );
  const ink = inkBounds(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data, CANVAS_WIDTH, CANVAS_HEIGHT);
  assert.ok(ink, "underlined text rendered nothing");
  assert.ok(
    ink.bottom <= Math.ceil(bounds.bottom),
    `underline escaped the box: ink=${ink.bottom} box=${bounds.bottom}`,
  );
});
