import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { dynamicSubtitleFrame, renderSubtitleCanvas, wrapSubtitleText } from "../src/renderer/subtitleCanvas.js";
import {
  chooseVideoEncoder,
  parseVideoRenderOptions,
  parseVideoRenderSpec,
  videoEncoderArguments,
} from "../src/renderer/subtitleVideoRenderer.js";

test("keeps NVENC mandatory in nvenc mode", () => {
  assert.deepEqual(chooseVideoEncoder("nvenc", true, true), {
    encoder: "h264_nvenc",
    mode: "nvenc",
    allowCpuFallback: false,
  });
  assert.throws(() => chooseVideoEncoder("nvenc", true, false), /NVENC|nvenc/i);
  assert.ok(videoEncoderArguments("h264_nvenc").includes("h264_nvenc"));
});

test("normalizes render options and validates subtitle cues", () => {
  assert.deepEqual(parseVideoRenderOptions({ width: 1920, height: 1080, frameRate: 30, quality: "high" }), {
    width: 1920,
    height: 1080,
    frameRate: 30,
    quality: "high",
    gpuAcceleration: true,
  });
  const spec = parseVideoRenderSpec({
    version: 1,
    width: 1280,
    height: 720,
    bottomMargin: 48,
    cues: [{ id: 1, start: 0, end: 2, text: "測試字幕", style: {} }],
  });
  assert.equal(spec?.cues[0]?.text, "測試字幕");
});

test("width-constrains explicit lines and preserves grapheme clusters", () => {
  const context = createCanvas(1280, 720).getContext("2d");
  context.font = '700 48px "Noto Sans TC"';
  const sentence = "Some instability in the US bond market Well, let me, let me say a couple things.";
  const lines = wrapSubtitleText(context, sentence, 420, 0, true);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => context.measureText(line).width <= 420.5));

  const family = "👨‍👩‍👧‍👦";
  const emojiLines = wrapSubtitleText(
    context,
    `${family}${family}${family}`,
    context.measureText(family).width * 1.1,
    0,
    true,
  );
  assert.deepEqual(emojiLines, [family, family, family]);
});

test("keeps the typewriter cursor inside a safe background inset", () => {
  const style = {
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
    shadow: true,
    italic: false,
    underline: false,
    positionX: 640,
    positionY: 180,
    maxWidth: 1178,
  };
  const text = "It's,it's putting Canada in a better position for Canadians,";
  const frame = dynamicSubtitleFrame(text, undefined, style, 1.999, {
    preset: "typewriter",
    start: 0,
    end: 2,
  });
  const context = createCanvas(1280, 720).getContext("2d");
  const bounds = renderSubtitleCanvas(context, 1280, 720, frame.text, frame.style, true, frame.runs);

  assert.ok(frame.text.endsWith("|"));
  assert.ok(!frame.text.includes("│"));
  assert.ok(frame.style.backgroundPaddingX >= style.fontSize * 0.7);
  assert.ok(bounds.right <= 1280);
});
