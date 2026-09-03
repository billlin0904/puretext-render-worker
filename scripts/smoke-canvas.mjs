import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderSubtitleVideo } from "../dist/src/renderer/subtitleVideoRenderer.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "puretext-canvas-smoke-"));
const input = path.join(directory, "input.mp4");
const output = path.join(directory, "output.mp4");
const generated = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=navy:s=640x360:r=30:d=1.2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
  "-c:v", "libx264", "-c:a", "aac", "-shortest", input,
]);
if (generated.status !== 0) throw new Error(generated.stderr?.toString() || "fixture generation failed");

await renderSubtitleVideo(input, {
  version: 1,
  width: 1280,
  height: 720,
  bottomMargin: 48,
  cues: [{
    id: 1,
    start: 0,
    end: 1.2,
    text: "Stable bounce layout",
    style: {
      fontFamily: "Arial",
      fontWeight: 700,
      fontSize: 54,
      lineHeight: 1.3,
      letterSpacing: 0,
      color: "#FFFFFF",
      opacity: 1,
      backgroundEnabled: true,
      backgroundColor: "#000000",
      backgroundOpacity: 0.8,
      backgroundRadius: 12,
      backgroundPaddingX: 24,
      backgroundPaddingY: 12,
      outline: 0,
      shadow: true,
      italic: false,
      underline: false,
      positionX: 640,
      positionY: 600,
      maxWidth: 1100,
    },
    dynamic: {
      preset: "bounce",
      highlightColor: "#FFE84A",
      words: [
        { word: "Stable", start: 0, end: 0.4 },
        { word: "bounce", start: 0.4, end: 0.8 },
        { word: "layout", start: 0.8, end: 1.2 },
      ],
    },
  }],
}, directory, output, {
  width: 1280,
  height: 720,
  frameRate: 30,
  quality: "standard",
  gpuAcceleration: false,
});

const stat = await fs.stat(output);
if (stat.size < 1_000) throw new Error(`smoke output is unexpectedly small: ${stat.size}`);
process.stdout.write(`${output}\n${stat.size} bytes\n`);
