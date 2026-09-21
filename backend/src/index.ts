import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { startScheduler } from './modules/platform/scheduler.js';

const app = createApp();
const server = http.createServer(app);

// In-process cron for analytics rollups + housekeeping (records to job_runs, the
// SuperAdmin "crons" panel reads). Returns a stop() handle for graceful exit.
const stopScheduler = startScheduler();

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    { port: env.PORT, host: env.HOST, env: env.NODE_ENV, kms: env.KMS_PROVIDER, jwt: env.jwtAlg },
    '🚀 API server listening',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down gracefully');
  stopScheduler();
  server.close(async () => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  });
  // Force-exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
