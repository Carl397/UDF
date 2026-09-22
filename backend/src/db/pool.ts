import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;

/**
 * Connection pool.
 *
 * Spatial values are converted to GeoJSON inside SQL (ST_AsGeoJSON), so no
 * custom PostGIS type parser is needed on the client.
 *
 * Layer 2 (at-rest) is enforced by the database/volume encryption and,
 * in production, by requiring TLS to the DB (PGSSL=true → verify-full).
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.PGSSL ? { rejectUnauthorized: env.isProduction } : undefined,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle DB client');
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params as any[]);
  logger.debug(
    { durationMs: Date.now() - start, rows: res.rowCount },
    'executed query',
  );
  return res;
}

/** Run a callback inside a transaction. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A multi-query read uses one database clock and one immutable MVCC snapshot. */
export async function withReadSnapshot<T>(fn: (run: typeof query) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn(<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => client.query<R>(text, params));
  });
}

export async function checkDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
