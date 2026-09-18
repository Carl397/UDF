/**
 * Ground-truth route inventory.
 *
 * Instead of parsing source text (which is how a stale comment like
 * "national_admin only" on /api/crm went unnoticed), this walks the LIVE
 * Express router stack of `createApp()` and records, for every registered
 * route, the exact middleware chain that will run before the handler.
 *
 * `requirePermission` / `requireRegionInScope` tag themselves with `__guard`
 * and `__permission` (see src/middleware/authorize.ts), so the declared
 * permission is read off the real object graph rather than guessed.
 *
 * Output: JSON array on stdout, or `--out <file>` to write it.
 *   { method, path, mount, guards[], permission|null, authenticated, scopeGuard }
 *
 * `scopeGuard` reports MIDDLEWARE only — see the caveat on that field below.
 *
 * Usage: npm run routes:inventory [-- --out deploy/.artifacts/routes.json]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { Permission, Role, ROLE_PERMISSIONS } from '../src/auth/permissions.js';

interface RouteRecord {
  method: string;
  path: string;
  mount: string;
  guards: string[];
  permission: string | null;
  authenticated: boolean;
  optionalAuth: boolean;
  scopeGuard: boolean;
}

/**
 * WHAT `scopeGuard` MEANS, and what it does not.
 *
 * It is true only when the route's chain declares the `requireRegionInScope`
 * MIDDLEWARE. It is a statement about the middleware graph, nothing more.
 *
 * Row-level territory checks that live inside a handler or a service —
 * `principalSeesWard`, `principalSeesMember`, `principalSeesPlace`,
 * `memberScope`, `privateTierClause` — are invisible here and always will be:
 * every handler is registered through an async wrapper
 * (`(req,res,next)=>{fn(req,res,next).catch(next)}`), so the real function is
 * reachable only through the wrapper's closure, not through the object graph
 * this script walks. Reading its source back therefore yields the wrapper, not
 * the handler.
 *
 * `scopeGuard:false` consequently means "not proven statically" and NEVER
 * "not enforced". During the Phase 1 sweep two routes
 * (`POST /api/posts`, `POST /api/events`) deliberately DROPPED
 * `requireRegionInScope` and moved to ward-aware in-handler checks — a strictly
 * stronger control, because `principal.regionCodes` holds SUBCOUNCIL codes and a
 * region-only test let a ward councillor act anywhere in their subcouncil. This
 * artifact reads as `true -> false` for exactly those two, which is the opposite
 * of the truth, so the empirical proof is the role-audit harness, as the plan
 * specifies.
 */

/** Turn an Express mount regexp back into its path prefix. */
function mountPath(regexp: RegExp | undefined): string {
  if (!regexp) return '';
  let src = regexp.source;
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '');
  src = src.replace(/\\\//g, '/');
  src = src.replace(/\(\?=\)|\(\?!\\\/\)/g, '');
  return src === '/(?:)' || src === '/' ? '' : src;
}

function describeHandler(handle: any): { label: string; permission: string | null; guard: string | null } {
  const permission: string | null = typeof handle?.__permission === 'string' ? handle.__permission : null;
  const guard: string | null = typeof handle?.__guard === 'string' ? handle.__guard : null;
  const name: string = guard ?? (handle?.name && handle.name !== 'guard' ? handle.name : 'anonymous');
  const label = permission ? `${name}:${permission}` : name;
  return { label, permission, guard };
}

const NOISE = new Set(['router', 'expressInit', 'query', 'bound dispatch', 'anonymous']);

interface Inherited {
  guards: string[];
  permission: string | null;
  authenticated: boolean;
  optionalAuth: boolean;
  scopeGuard: boolean;
}

const EMPTY: Inherited = { guards: [], permission: null, authenticated: false, optionalAuth: false, scopeGuard: false };

/**
 * Walk a router stack IN ORDER. Express applies `router.use(...)` guards to
 * every route registered AFTER them, and several modules mount public routes
 * first and then call `router.use(authenticate)` part-way down the file — so
 * the accumulated guard set must be carried forward rather than read once from
 * the head of the stack.
 */
function walk(stack: any[], prefix: string, out: RouteRecord[], inherited: Inherited = EMPTY): void {
  const acc: Inherited = { ...inherited, guards: [...inherited.guards] };

  const absorb = (handle: any) => {
    const d = describeHandler(handle);
    if (NOISE.has(d.label)) return;
    if (!acc.guards.includes(d.label)) acc.guards.push(d.label);
    if (d.permission && !acc.permission) acc.permission = d.permission;
    if (d.guard === 'requireRegionInScope') acc.scopeGuard = true;
    if (d.label === 'authenticate') acc.authenticated = true;
    if (d.label === 'optionalAuthenticate') acc.optionalAuth = true;
  };

  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path}`.replace(/\/$/, '') || '/';
      const routeGuards: string[] = [];
      let routePerm: string | null = null;
      let routeScope = false;
      let routeAuth = false;
      let routeOptAuth = false;
      for (const h of layer.route.stack) {
        const d = describeHandler(h.handle);
        if (NOISE.has(d.label)) continue;
        routeGuards.push(d.label);
        if (d.permission && !routePerm) routePerm = d.permission;
        if (d.guard === 'requireRegionInScope') routeScope = true;
        if (d.label === 'authenticate') routeAuth = true;
        if (d.label === 'optionalAuthenticate') routeOptAuth = true;
      }
      const methods = new Set(layer.route.methods ? Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]) : ['use']);
      for (const method of methods) {
        out.push({
          method: method.toUpperCase(),
          path,
          mount: prefix,
          guards: [...new Set([...acc.guards, ...routeGuards])],
          permission: routePerm ?? acc.permission,
          authenticated: routeAuth || acc.authenticated,
          optionalAuth: routeOptAuth || acc.optionalAuth,
          scopeGuard: routeScope || acc.scopeGuard,
        });
      }
      continue;
    }

    const handle = layer.handle;
    if (handle && typeof handle === 'function' && handle.stack) {
      // A mounted sub-router — recurse carrying the accumulated guards.
      walk(handle.stack, `${prefix}${mountPath(layer.regexp)}`, out, acc);
      continue;
    }
    if (typeof handle === 'function') {
      // Router-level middleware: applies to everything registered after it.
      absorb(handle);
    }
  }
}

function collect(): RouteRecord[] {
  const app: any = createApp();
  const router = app._router ?? app.router;
  const out: RouteRecord[] = [];
  walk(router?.stack ?? [], '', out);

  // Merge per-method records for the same path into one entry per
  // (method, path) pair, deduplicating guard labels.
  const byKey = new Map<string, RouteRecord>();
  for (const rec of out) {
    const key = `${rec.method} ${rec.path}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...rec, guards: [...new Set(rec.guards)] });
      continue;
    }
    existing.guards = [...new Set([...existing.guards, ...rec.guards])];
    existing.permission = existing.permission ?? rec.permission;
    existing.authenticated ||= rec.authenticated;
    existing.optionalAuth ||= rec.optionalAuth;
    existing.scopeGuard ||= rec.scopeGuard;
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const routes = collect();
const json = JSON.stringify(routes, null, 2);

const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1]!, `${json}\n`, 'utf8');
  process.stderr.write(`wrote ${routes.length} routes to ${process.argv[outIdx + 1]}\n`);
} else {
  process.stdout.write(`${json}\n`);
}

/**
 * The permission matrix, exported from the SAME object the running server uses,
 * so the harness cannot drift from `src/auth/permissions.ts`.
 */
const matrixIdx = process.argv.indexOf('--matrix');
if (matrixIdx !== -1 && process.argv[matrixIdx + 1]) {
  const matrix = {
    generatedAt: new Date().toISOString(),
    roles: Object.values(Role),
    permissions: Object.values(Permission),
    rolePermissions: ROLE_PERMISSIONS,
  };
  writeFileSync(process.argv[matrixIdx + 1]!, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  process.stderr.write(`wrote permission matrix to ${process.argv[matrixIdx + 1]}\n`);
}

process.exit(0);
