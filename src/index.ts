import http from "node:http";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { RenderWorker } from "./worker.js";

const config = loadConfig();
const worker = new RenderWorker(config);

const healthServer = http.createServer((req, res) => {
  if (req.url !== "/healthz") {
    res.writeHead(404).end();
    return;
  }
  const healthy = worker.healthy();
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: healthy, ...worker.status() }));
});

healthServer.listen(config.healthPort, "127.0.0.1", () => {
  logger.info({ workerId: config.workerId, concurrency: config.concurrency, healthPort: config.healthPort }, "PureText render worker ready");
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "render worker shutting down");
  worker.stop();
  healthServer.close();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

await worker.run();
