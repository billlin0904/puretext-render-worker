const port = Number(process.env.HEALTH_PORT || 9090);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
