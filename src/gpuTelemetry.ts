import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GpuTelemetry } from "./types.js";

const execFileAsync = promisify(execFile);
const QUERY_FIELDS = [
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "utilization.encoder",
].join(",");

function numeric(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseNvidiaSmiCsv(stdout: string): GpuTelemetry | null {
  const rows = stdout.trim().split(/\r?\n/).map((line) => line.split(",").map((value) => value.trim()));
  const valid = rows.filter((row) => row.length >= 7 && row[0]);
  if (valid.length === 0) return null;

  const values = valid.map((row) => ({
    name: row[0]!,
    utilizationPercent: numeric(row[1]!),
    memoryUsedMb: numeric(row[2]!),
    memoryTotalMb: numeric(row[3]!),
    temperatureC: numeric(row[4]!),
    powerWatts: numeric(row[5]!),
    encoderUtilizationPercent: numeric(row[6]!),
  }));
  const present = (items: Array<number | null>, combine: (numbers: number[]) => number) => {
    const numbers = items.filter((value): value is number => value != null);
    return numbers.length > 0 ? combine(numbers) : null;
  };
  const memoryUsedMb = present(values.map((gpu) => gpu.memoryUsedMb), (numbers) => numbers.reduce((a, b) => a + b, 0));
  const memoryTotalMb = present(values.map((gpu) => gpu.memoryTotalMb), (numbers) => numbers.reduce((a, b) => a + b, 0));

  return {
    gpuCount: values.length,
    gpuName: [...new Set(values.map((gpu) => gpu.name))].join(" + ").slice(0, 200),
    gpuUtilizationPercent: present(values.map((gpu) => gpu.utilizationPercent), (numbers) => Math.max(...numbers)),
    gpuMemoryUsedMb: memoryUsedMb,
    gpuMemoryTotalMb: memoryTotalMb,
    gpuMemoryPercent: memoryUsedMb != null && memoryTotalMb ? Math.round(memoryUsedMb / memoryTotalMb * 1_000) / 10 : null,
    gpuTemperatureC: present(values.map((gpu) => gpu.temperatureC), (numbers) => Math.max(...numbers)),
    gpuPowerWatts: present(values.map((gpu) => gpu.powerWatts), (numbers) => Math.round(numbers.reduce((a, b) => a + b, 0) * 10) / 10),
    gpuEncoderUtilizationPercent: present(values.map((gpu) => gpu.encoderUtilizationPercent), (numbers) => Math.max(...numbers)),
    sampledAt: new Date().toISOString(),
  };
}

export async function collectGpuTelemetry(): Promise<GpuTelemetry | null> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      `--query-gpu=${QUERY_FIELDS}`,
      "--format=csv,noheader,nounits",
    ], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
    return parseNvidiaSmiCsv(stdout);
  } catch {
    return null;
  }
}
