import type { RequestHandler } from 'express';
import {
  roleHasPermission,
  isNationalScope,
  type Permission,
} from '../auth/permissions.js';
import { ApiError } from '../http/errors.js';

/** Non-runtime tags read by the route-inventory / role-audit tooling. */
interface GuardMeta {
  __guard?: string;
  __permission?: Permission;
}

/**
 * Require that the authenticated principal's role grants `permission`.
 * Must run AFTER `authenticate`.
 *
 * The returned handler is tagged with `__permission` / `__guard` so that
 * tooling (scripts/route-inventory.ts, scripts/role-audit.mjs) can read the
 * declared guard straight off the live middleware chain instead of parsing
 * source text. This is what makes the authorization sweep evidence-based.
 */
export function requirePermission(permission: Permission): RequestHandler {
  const guard: RequestHandler = (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(ApiError.unauthorized());
    // Prefer the principal's live effective set (role base ± per-user
    // overrides, read from the DB by `authenticate`) so an admin's grant or
    // revoke applies immediately. Principals attached without a DB read
    // (optional-auth) carry no `permissions` and fall back to the role matrix.
    const allowed = p.permissions
      ? p.permissions.includes(permission)
      : roleHasPermission(p.role, permission);
    if (!allowed) {
      return next(ApiError.forbidden(`Missing permission: ${permission}`));
    }
    next();
  };
  (guard as GuardMeta).__guard = 'requirePermission';
  (guard as GuardMeta).__permission = permission;
  return guard;
}

/**
 * Require that the principal holds AT LEAST ONE of `permissions` — a disjunctive
 * gate, unlike `requirePermission` which is a single conjunctive link in a chain.
 *
 * Used by the Wave 4 member-safe geo routes (`/api/geo/my-ward*`), which accept
 * the staff-wide `geo:read` OR the member's ward-scoped `geo:read_own_ward`. The
 * handlers still hard-scope every result to `principal.wardCode`, so holding
 * either permission only ever yields the caller's OWN ward — the disjunction
 * decides *whether* you see a ward, never *whose*.
 *
 * Deliberately NOT tagged with `__permission`. The route-inventory records a
 * single permission per route and the role-audit expectation model treats a
 * middleware chain as CONJUNCTIVE (the caller must hold EVERY declared
 * permission), which cannot express "any of": tagging one permission here would
 * mis-score exactly the roles that hold only the other. The disjunction is
 * proven instead by the dedicated `/api/geo/my-ward*` probes in role-audit.mjs.
 * Reads the live effective set, so disabling the `map` module — which strips
 * BOTH permissions — still 403s here, exactly as `requirePermission` would.
 */
export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  const guard: RequestHandler = (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(ApiError.unauthorized());
    const allowed = p.permissions
      ? permissions.some((permission) => p.permissions!.includes(permission))
      : permissions.some((permission) => roleHasPermission(p.role, permission));
    if (!allowed) {
      return next(ApiError.forbidden(`Missing any of: ${permissions.join(', ')}`));
    }
    next();
  };
  (guard as GuardMeta).__guard = 'requireAnyPermission';
  return guard;
}

/**
 * Require that a UI-only module is enabled for the principal's role.
 *
 * Permission-backed modules need no such guard: disabling one strips its
 * permissions in `effectivePermissions`, so `requirePermission` already 403s
 * every route the module owns. This is for the modules that own NO permission —
 * `id_cards`, which rides on `member:read` — where there is nothing to strip and
 * the surface must be gated explicitly. Reads `principal.enabledModules`, which
 * `authenticate` populates live from `role_module_gates`; an optional-auth
 * principal carries none, so this fails closed. Must run AFTER `authenticate`.
 */
export function requireModule(moduleKey: string): RequestHandler {
  const guard: RequestHandler = (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(ApiError.unauthorized());
    if (!(p.enabledModules ?? []).includes(moduleKey)) {
      return next(ApiError.forbidden(`Module disabled: ${moduleKey}`));
    }
    next();
  };
  (guard as GuardMeta).__guard = 'requireModule';
  return guard;
}

/**
 * Region scoping guard (ABAC on top of RBAC).
 *
 * Reads a region code from the request (query/body/params) and rejects it if
 * the principal is not authorized for that region. National-scope principals
 * bypass the check.
 */
export function requireRegionInScope(
  pickRegion: (req: Parameters<RequestHandler>[0]) => string | undefined,
): RequestHandler {
  const guard: RequestHandler = (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(ApiError.unauthorized());
    if (isNationalScope(p)) return next();

    const region = pickRegion(req);
    if (!region) {
      // No explicit region → results must be filtered downstream; allow.
      return next();
    }
    if (!p.regionCodes?.includes(region)) {
      return next(ApiError.forbidden('Region outside your authorized scope'));
    }
    next();
  };
  (guard as GuardMeta).__guard = 'requireRegionInScope';
  return guard;
}
