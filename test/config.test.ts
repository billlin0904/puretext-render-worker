import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads a bounded production configuration", () => {
  const config = loadConfig({
    PURETEXT_API_BASE: "https://puretext.audio-io.com/",
    RENDER_WORKER_TOKEN: "secret",
    RENDER_WORKER_ID: "gpu-01",
    VIDEO_RENDER_CONCURRENCY: "20",
    RENDER_CACHE_ROOT: "./cache",
  });
  assert.equal(config.apiBase, "https://puretext.audio-io.com");
  assert.equal(config.concurrency, 8);
  assert.equal(config.version, "0.1.12");
  assert.equal(config.commit, null);
});

test("rejects an insecure remote API", () => {
  assert.throws(() => loadConfig({
    PURETEXT_API_BASE: "http://example.com",
    RENDER_WORKER_TOKEN: "secret",
    RENDER_WORKER_ID: "gpu-01",
  }), /HTTPS/);
});
