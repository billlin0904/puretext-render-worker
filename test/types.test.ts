import assert from "node:assert/strict";
import test from "node:test";
import { parseClaimedRenderJob } from "../src/types.js";

const validJob = {
  jobId: "render-123",
  leaseToken: "0123456789abcdef",
  leaseExpiresAt: "2026-09-03T12:00:00Z",
  kind: "subtitle",
  input: { downloadUrl: "https://storage.example/input.mp4" },
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
      jobId: "test-job",
      leaseToken: "1234567890123456",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: "subtitle",
      input: { downloadUrl: "http://object-store.local/source.mp4" },
      output: { objectKey: "video-renders/test-job/output.mp4" },
      renderSpec: { version: 1, width: 1280, height: 720, bottomMargin: 48, cues: [] },
      renderOptions: { width: 1280, height: 720, frameRate: 30, quality: "standard", gpuAcceleration: true },
    }));
  } finally {
    if (previous == null) delete process.env["RENDER_ALLOW_INSECURE_HTTP"];
    else process.env["RENDER_ALLOW_INSECURE_HTTP"] = previous;
  }
});
