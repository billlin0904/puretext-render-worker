import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { wrapSubtitleText } from "../src/renderer/subtitleCanvas.js";
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
