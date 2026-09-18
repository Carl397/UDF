import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';

/**
 * Minimal, dependency-free migration runner.
 * Applies every `*.sql` file in ./migrations once, tracked in schema_migrations.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

async function ensureTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function applied(): Promise<Set<string>> {
  const res = await query<{ id: string }>('SELECT id FROM schema_migrations');
  return new Set(res.rows.map((r) => r.id));
}

export async function migrate(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (done.has(file)) {
      logger.debug({ file }, 'migration already applied');
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    logger.info({ file }, 'applying migration');
    await query(sql);
    await query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
    logger.info({ file }, 'migration applied');
  }
}

// Run directly: `npm run migrate`
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  migrate()
    .then(() => {
      logger.info('Migrations complete');
      return pool.end();
    })
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
