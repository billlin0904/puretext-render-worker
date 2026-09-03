import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { usesCanvasRgba } from "../src/renderer/canvasRgbaRenderer.js";
import { dynamicSubtitleFrame, subtitleCanvasRunPositions, type SubtitleCanvasStyle } from "../src/renderer/subtitleCanvas.js";

test("routes only geometry-changing subtitle presets through Canvas RGBA", () => {
  for (const preset of ["word-pop", "bounce", "neon", "box"] as const) {
    assert.equal(usesCanvasRgba(preset), true, preset);
  }
  for (const preset of ["none", "typewriter", "highlight", "karaoke"] as const) {
    assert.equal(usesCanvasRgba(preset), false, preset);
  }
});

test("bounce changes only the active run paint transform, never base run positions", () => {
  const style: SubtitleCanvasStyle = {
    fontFamily: "Arial", fontWeight: 700, fontSize: 48, lineHeight: 1.3, letterSpacing: 0,
    color: "#FFFFFF", opacity: 1, backgroundEnabled: true, backgroundColor: "#000000",
    backgroundOpacity: 0.8, backgroundRadius: 8, backgroundPaddingX: 16, backgroundPaddingY: 8,
    outline: 0, shadow: false, italic: false, underline: false,
    positionX: 640, positionY: 600, maxWidth: 1100,
  };
  const words = [
    { word: "Stable", start: 0, end: 0.4 },
    { word: "bounce", start: 0.4, end: 0.8 },
    { word: "layout", start: 0.8, end: 1.2 },
  ];
  const before = dynamicSubtitleFrame("Stable bounce layout", words, style, 0.401, { preset: "bounce", start: 0, end: 1.2 });
  const peak = dynamicSubtitleFrame("Stable bounce layout", words, style, 0.56, { preset: "bounce", start: 0, end: 1.2 });
  const context = createCanvas(1280, 720).getContext("2d");
  const beforePositions = subtitleCanvasRunPositions(context, 1280, style, before.runs!);
  const peakPositions = subtitleCanvasRunPositions(context, 1280, style, peak.runs!);
  assert.deepEqual(peakPositions, beforePositions);
  assert.notEqual(peak.runs?.[1]?.scale, before.runs?.[1]?.scale);
});
