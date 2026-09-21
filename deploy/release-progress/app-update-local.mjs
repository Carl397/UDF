// Apply only the additive app-update schema to the verified local database.
// Run from the backend workspace with node --import tsx; never targets production.
import { readFile, readdir } from 'node:fs/promises';
import { env } from '../../backend/src/config/env.ts';
import { pool } from '../../backend/src/db/pool.ts';

if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('Local non-production database required');
}
const apply = process.argv.includes('--apply');
const directory = new URL('../../backend/src/db/migrations/', import.meta.url);
const target = '052_app_releases.sql';
const files = (await readdir(directory)).filter(x => x.endsWith('.sql')).sort();
const c = await pool.connect();
try {
  await c.query('BEGIN');
  if (apply) await c.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
  else await c.query('SET TRANSACTION READ ONLY');
  const done = (await c.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(x => x.id);
  if (files.length !== 52 || files.at(-1) !== target) throw new Error('Unexpected migration source');
  if (JSON.stringify(done) === JSON.stringify(files)) {
    console.log('Local schema already at 052; no migration repeated.');
  } else {
    if (JSON.stringify(done) !== JSON.stringify(files.slice(0, -1))) throw new Error('Unexpected local migration history');
    if (apply) {
      await c.query(await readFile(new URL(target, directory), 'utf8'));
      await c.query('INSERT INTO schema_migrations(id) VALUES ($1)', [target]);
      console.log('Local additive migration 052 applied atomically.');
    } else console.log('Local schema at 051; only migration 052 pending.');
  }
  if (apply || done.includes(target)) {
    const state = (await c.query('SELECT active_id, highest_version FROM app_release_state')).rows;
    console.log(JSON.stringify({ releaseStateRows: state.length, activeAnnouncement: state.some(x => x.active_id !== null) }));
  }
  await c.query('COMMIT');
} catch (e) { await c.query('ROLLBACK'); throw e; }
finally { c.release(); await pool.end(); }
