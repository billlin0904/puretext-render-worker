import assert from "node:assert/strict";
import test from "node:test";
import { safeRemoteFilename } from "../src/files.js";

test("accepts a normal font filename", () => {
  assert.equal(safeRemoteFilename("noto-sans-tc.ttf"), "noto-sans-tc.ttf");
});

test("rejects traversal and path separators", () => {
  assert.throws(() => safeRemoteFilename("../secret"));
  assert.throws(() => safeRemoteFilename("folder/font.ttf"));
  assert.throws(() => safeRemoteFilename("folder\\font.ttf"));
});
