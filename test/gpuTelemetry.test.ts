import assert from "node:assert/strict";
import test from "node:test";
import { parseNvidiaSmiCsv } from "../src/gpuTelemetry.js";

test("parses one NVIDIA GPU sample", () => {
  const sample = parseNvidiaSmiCsv("NVIDIA GeForce RTX 5090, 87, 16384, 32607, 71, 421.5, 64\n");
  assert.equal(sample?.gpuName, "NVIDIA GeForce RTX 5090");
  assert.equal(sample?.gpuUtilizationPercent, 87);
  assert.equal(sample?.gpuMemoryPercent, 50.2);
  assert.equal(sample?.gpuEncoderUtilizationPercent, 64);
});

test("aggregates multiple GPUs and tolerates unavailable fields", () => {
  const sample = parseNvidiaSmiCsv([
    "NVIDIA RTX 5090, 80, 10000, 32000, 70, 400, 60",
    "NVIDIA RTX 5090, 90, 12000, 32000, 75, N/A, N/A",
  ].join("\n"));
  assert.equal(sample?.gpuCount, 2);
  assert.equal(sample?.gpuUtilizationPercent, 90);
  assert.equal(sample?.gpuMemoryUsedMb, 22000);
  assert.equal(sample?.gpuMemoryTotalMb, 64000);
  assert.equal(sample?.gpuTemperatureC, 75);
  assert.equal(sample?.gpuPowerWatts, 400);
});

test("returns null for empty output", () => {
  assert.equal(parseNvidiaSmiCsv(""), null);
});
