-- ============================================================
-- 038 — Register the SuperAdmin operations module.
--
-- Section 1 of the ops-dashboard change set added `ModuleKey.SUPERADMIN`
-- (owning `platform:read`, `analytics:read`, `content:manage`) in
-- `auth/permissions.ts`. The stripping logic in `effectivePermissions` already
-- flows through that map, but the CRM → Settings → Module registry can only
-- list/persist a toggle for a module that has a row in `modules`
-- (`role_module_gates.module_key` FK-references it). Without this row an
-- administrator could not switch the ops surface off for the `superadmin` role,
-- so the "disabling the module strips the trio" guarantee was unenforceable
-- from the UI.
--
-- Insert the module and seed an enabled gate for the `superadmin` role (the only
-- role that holds these permissions). `enabled=TRUE` strips nothing — access is
-- unchanged until an administrator toggles the cell. Idempotent.
-- ============================================================

INSERT INTO modules (key, label, description, sort) VALUES
  ('superadmin', 'SuperAdmin ops', 'Platform operations: server/cron/live-status dashboards, first-party website/app analytics, and the structured website content editor.', 140)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_module_gates (role, module_key, enabled) VALUES
  ('superadmin', 'superadmin', TRUE)
ON CONFLICT (role, module_key) DO NOTHING;
