import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

/**
 * Factory reset — DESTRUCTIVE.
 *
 * Wipes ALL demo/business data and KEEPS the geo + config + bookkeeping tables
 * and every Postgres-extension table (PostGIS / tiger_geocoder / topology), so
 * the result is a clean, production-like database with ward geometry intact.
 *
 * KEEP (never truncated):
 *   - regions            ward / sub-council geometry (geo)
 *   - work_types         job work-type taxonomy (config)
 *   - feature_flags      feature kill-switches (config)
 *   - job_config         jobs feature configuration (config)
 *   - schema_migrations  migration bookkeeping
 *   - + every extension-owned table (auto-detected: spatial_ref_sys, edges,
 *     faces, tabblock, topology, ...). These are PostGIS internals, not data.
 *
 * WIPE: every other table in the `public` schema (members, users, refresh
 * tokens, member tokens/consents, audit log, media, service requests, resident
 * reports + outboxes, job opportunities/interests/stats/demand + relay outbox,
 * petitions, events, posts, appointments, participations, ratings, patrols,
 * verifications, projects, ward bulletins/profiles/change-log, moderation
 * actions/items, banned devices, notifications/reads, ...).
 *
 * Safety:
 *   - Operator MUST take a pg_dump backup first (plan/RUNBOOK guardrail).
 *   - Aborts if any KEEP/extension table has a FK pointing at a WIPE table,
 *     because TRUNCATE ... CASCADE would otherwise drag kept data down too.
 *   - --dry-run prints the plan and changes nothing.
 *   - Requires --force (or FACTORY_RESET=yes) to actually truncate.
 *
 * Usage:
 *   npm run factory:reset -- --dry-run
 *   npm run factory:reset -- --force
 */

const KEEP_TABLES = new Set<string>([
  'regions',
  'work_types',
  'feature_flags',
  'job_config',
  'schema_migrations',
]);

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Quote a trusted, validated identifier for interpolation into DDL. */
function q(ident: string): string {
  if (!IDENT.test(ident)) throw new Error(`unsafe identifier: ${ident}`);
  return `"${ident}"`;
}

function redactUrl(url: string | undefined): string {
  return String(url ?? '(unknown)').replace(/(\/\/[^:]+:)[^@]+@/, '$1****@');
}

async function listTables(): Promise<string[]> {
  const { rows } = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

async function extensionTables(): Promise<Set<string>> {
  const { rows } = await query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_depend d ON d.objid = c.oid
       JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.deptype = 'e'
        AND c.relkind = 'r'
        AND c.relnamespace = 'public'::regnamespace`,
  );
  return new Set(rows.map((r) => r.relname));
}

/** KEEP/extension tables that FK-reference a WIPE table => CASCADE hazard. */
async function cascadeHazards(
  keep: string[],
  wipe: string[],
): Promise<Array<{ child: string; parent: string }>> {
  if (keep.length === 0 || wipe.length === 0) return [];
  const { rows } = await query<{ child: string; parent: string }>(
    `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ANY($1::text[])
        AND ccu.table_name = ANY($2::text[])`,
    [keep, wipe],
  );
  return rows;
}

async function exactCounts(tables: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (tables.length === 0) return map;
  const sql = tables
    .map((t, i) => `SELECT ${i} AS idx, count(*)::int AS n FROM ${q(t)}`)
    .join(' UNION ALL ');
  const { rows } = await query<{ idx: number; n: number }>(sql);
  for (const r of rows) map.set(tables[r.idx], r.n);
  return map;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force') || process.env.FACTORY_RESET === 'yes';

  const all = await listTables();
  const ext = await extensionTables();

  const wipe = all.filter((t) => !KEEP_TABLES.has(t) && !ext.has(t));
  const keepExplicit = all.filter((t) => KEEP_TABLES.has(t));
  const keepAll = all.filter((t) => KEEP_TABLES.has(t) || ext.has(t));

  console.log('FACTORY RESET — target database:');
  console.log(`   ${redactUrl(env.DATABASE_URL)}`);
  console.log(`   NODE_ENV=${env.NODE_ENV ?? 'development'}`);
  console.log('');
  console.log(
    `KEEP  (${keepAll.length}): ${keepExplicit.join(', ')} + ${ext.size} extension table(s)`,
  );
  console.log(`WIPE  (${wipe.length}): ${wipe.join(', ')}`);
  console.log('');

  // Safety net: refuse if truncating the wipe set could cascade into kept data.
  const hazards = await cascadeHazards(keepAll, wipe);
  if (hazards.length > 0) {
    console.error(
      'ABORT: KEEP/extension table(s) FK-reference WIPE table(s) — TRUNCATE ... CASCADE would delete kept data:',
    );
    for (const h of hazards) console.error(`   ${h.child} -> ${h.parent}`);
    process.exit(1);
  }

  if (wipe.length === 0) {
    console.log('Nothing to wipe.');
    return;
  }

  const before = await exactCounts(wipe);
  const nonEmpty = [...before.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalRows = nonEmpty.reduce((s, [, n]) => s + n, 0);
  console.log(
    `Rows to delete: ${totalRows} across ${nonEmpty.length} non-empty table(s):`,
  );
  for (const [t, n] of nonEmpty) console.log(`   ${String(n).padStart(6)}  ${t}`);
  console.log('');

  if (dryRun) {
    console.log('DRY-RUN: no changes made.');
    return;
  }
  if (!force) {
    console.error('Refusing to run without --force (or FACTORY_RESET=yes).');
    console.error('   Take a pg_dump backup first, then re-run with --force.');
    process.exit(1);
  }

  const keepBefore = await exactCounts(keepExplicit);
  logger.info({ tables: wipe.length, rows: totalRows }, 'factory reset: truncating');
  await query(`TRUNCATE TABLE ${wipe.map(q).join(', ')} RESTART IDENTITY CASCADE`);

  const after = await exactCounts(wipe);
  const leftover = [...after.entries()].filter(([, n]) => n > 0);
  const keepAfter = await exactCounts(keepExplicit);

  console.log('');
  if (leftover.length === 0) {
    console.log(`OK: wiped ${wipe.length} business table(s); all now empty.`);
  } else {
    console.error(`${leftover.length} table(s) still have rows:`);
    for (const [t, n] of leftover) console.error(`   ${n}  ${t}`);
  }
  console.log('   KEEP row counts (before -> after):');
  for (const t of keepExplicit) {
    console.log(`     ${t}: ${keepBefore.get(t)} -> ${keepAfter.get(t)}`);
  }
  console.log('');
  console.log(
    'Next: npm run seed:admin   (SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD from env)',
  );
}

// Run directly: `npm run factory:reset -- --force`
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'factory reset failed');
      console.error(
        'factory reset failed:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
