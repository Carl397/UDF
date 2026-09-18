import { query } from '../../db/pool.js';
import { recordAudit } from '../../security/audit.js';
import { isNationalScope } from '../../auth/permissions.js';
import type { Principal } from '../../auth/permissions.js';
import {
  canSeeUnpublished,
  principalSeesWard,
  publishedOrInTerritory,
} from '../../auth/scope.js';
import type { z } from 'zod';
import type { createProjectSchema, createMilestoneSchema } from './schemas.js';

export interface Project {
  id: string;
  title: string;
  description: string | null;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  stage: string;
  progressPct: number | null;
  budget: number | null;
  owner: string | null;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  dueDate: Date | null;
  completedAt: Date | null;
  status: string;
  seq: number;
}

export async function createProject(
  input: z.infer<typeof createProjectSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Project> {
  const res = await query<Project>(
    `INSERT INTO projects (title, description, scope, ward_code, region_code, stage, budget, owner, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, title, description, scope, ward_code AS "wardCode", region_code AS "regionCode",
            stage, progress_pct AS "progressPct", budget, owner, is_published AS "isPublished",
            created_at AS "createdAt", updated_at AS "updatedAt"`,
    [input.title, input.description ?? null, input.scope,
     input.wardCode ?? principal.wardCode ?? null, input.regionCode ?? null,
     input.stage, input.budget ?? null, input.owner ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw new Error('Failed to create project');
  const project = res.rows[0]!;

  await recordAudit({
    action: 'project.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'projects',
    targetId: project.id,
    metadata: { title: project.title, wardCode: project.wardCode, stage: project.stage },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return project;
}

export async function addMilestone(
  projectId: string,
  input: z.infer<typeof createMilestoneSchema>,
): Promise<Milestone> {
  const res = await query<Milestone>(
    `INSERT INTO project_milestones (project_id, title, due_date, status, seq)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id AS "projectId", title, due_date AS "dueDate",
            completed_at AS "completedAt", status, seq`,
    [projectId, input.title, input.dueDate ?? null, input.status, input.seq],
  );

  if (res.rowCount === 0) throw new Error('Failed to create milestone');
  return res.rows[0]!;
}

/**
 * Row-level counterpart of the `publishedOrInTerritory()` gate that `listProjects`
 * applies — the SAME contract, so a row the list hides can never be fetched by id.
 *
 * Publication, not territory, is what makes a project public: anyone holding
 * `case:read` may read a PUBLISHED project in any ward, while an UNPUBLISHED one
 * is readable only by a staff role inside its own territory (national scope sees
 * drafts everywhere, exactly as the list clause does).
 */
export async function canReadProject(p: Principal, project: Project): Promise<boolean> {
  if (project.isPublished) return true;
  if (!canSeeUnpublished(p)) return false;
  if (isNationalScope(p)) return true;
  // A region-level draft (ward_code NULL) is deliberately unreachable to
  // ward- and region-scoped callers: `wardCodeScope` filters on `ward_code`, so
  // the list never shows it to them either. Keeping the two in step means the id
  // is not an oracle for rows the caller's own feed cannot contain.
  if (!project.wardCode) return false;
  return principalSeesWard(p, project.wardCode);
}

/**
 * Fetch one project, gated for `principal`.
 *
 * Returns `null` — which the route maps to 404 — rather than throwing 403, so a
 * denied read is indistinguishable from a project that does not exist. A 403 here
 * would confirm the id is real and turn the endpoint into an enumeration oracle
 * over unpublished work.
 *
 * This previously took no principal at all: any `case:read` holder could read any
 * project in any ward by id, including drafts. The list endpoint was gated and the
 * read endpoint was not, so the gate was trivially bypassed (D43).
 */
export async function getProject(id: string, principal: Principal): Promise<Project | null> {
  const res = await query<Project>(
    `SELECT id, title, description, scope, ward_code AS "wardCode", region_code AS "regionCode",
            stage, progress_pct AS "progressPct", budget, owner, is_published AS "isPublished",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM projects WHERE id = $1`,
    [id],
  );
  const project = res.rows[0] ?? null;
  if (!project) return null;
  return (await canReadProject(principal, project)) ? project : null;
}

export async function getProjectMilestones(projectId: string): Promise<Milestone[]> {
  const res = await query<Milestone>(
    `SELECT id, project_id AS "projectId", title, due_date AS "dueDate",
            completed_at AS "completedAt", status, seq
     FROM project_milestones WHERE project_id = $1
     ORDER BY seq ASC`,
    [projectId],
  );
  return res.rows;
}

export async function listProjects(
  principal: Principal,
  filters: {
    wardCode?: string;
    stage?: string;
    limit: number;
    offset: number;
  },
): Promise<{ items: Project[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.wardCode) { conditions.push(`ward_code = $${idx++}`); values.push(filters.wardCode); }
  if (filters.stage) { conditions.push(`stage = $${idx++}`); values.push(filters.stage); }

  // Publication is the public gate; territory gates only UNPUBLISHED projects.
  // `is_published` was selected but never filtered, so an ordinary member with
  // `case:read` received draft `idea`/`concept` projects from every ward.
  const gate = await publishedOrInTerritory(principal, 'is_published = TRUE', 'ward_code', idx);
  values.push(...gate.params);
  idx = gate.nextIndex;
  if (gate.sql) conditions.push(gate.sql.replace(/^\s*AND\s*/, ''));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<Project>(
      `SELECT id, title, description, scope, ward_code AS "wardCode", region_code AS "regionCode",
              stage, progress_pct AS "progressPct", budget, owner, is_published AS "isPublished",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM projects ${where}
       ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM projects ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}
