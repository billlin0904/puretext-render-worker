import assert from "node:assert/strict";
import test from "node:test";
import { parseClaimedRenderJob } from "../src/types.js";

const validJob = {
  jobId: "render-123",
  leaseToken: "0123456789abcdef",
  leaseExpiresAt: "2026-09-03T12:00:00Z",
  kind: "subtitle",
  input: { downloadUrl: "https://storage.example/input.mp4" },
  fontBundle: { version: "font-bundle-test", metricsSha256: "a".repeat(64) },
  fonts: [{
    family: "Noto Sans TC",
    file: "noto-sans-tc.ttf",
    downloadUrl: "https://storage.example/noto-sans-tc.ttf",
    size: 123,
    sha256: "b".repeat(64),
  }],
  output: { objectKey: "video-renders/42/render-123.mp4" },
  renderSpec: { version: 1, width: 1280, height: 720, bottomMargin: 48, cues: [] },
  renderOptions: { width: 1920, height: 1080, frameRate: "source", quality: "standard", gpuAcceleration: true },
};

test("accepts a structurally valid claimed job", () => {
  assert.equal(parseClaimedRenderJob(validJob).jobId, "render-123");
});

test("rejects insecure downloads and unsafe object keys", () => {
  assert.throws(() => parseClaimedRenderJob({ ...validJob, input: { downloadUrl: "http://storage.example/input.mp4" } }), /HTTPS/);
  assert.throws(() => parseClaimedRenderJob({ ...validJob, output: { objectKey: "video-renders/../secret" } }), /object key/);
});

test("allows an HTTP object store only with the explicit local-test switch", () => {
  const previous = process.env["RENDER_ALLOW_INSECURE_HTTP"];
  process.env["RENDER_ALLOW_INSECURE_HTTP"] = "true";
  try {
    assert.doesNotThrow(() => parseClaimedRenderJob({
      ...validJob,
      jobId: "test-job",
      leaseToken: "1234567890123456",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      input: { downloadUrl: "http://object-store.local/source.mp4" },
      output: { objectKey: "video-renders/test-job/output.mp4" },
    }));
  } finally {
    if (previous == null) delete process.env["RENDER_ALLOW_INSECURE_HTTP"];
    else process.env["RENDER_ALLOW_INSECURE_HTTP"] = previous;
  }
});
