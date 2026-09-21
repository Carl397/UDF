import { query, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { principalSeesWard } from '../../auth/scope.js';
import { Permission, isNationalAdmin, type Principal } from '../../auth/permissions.js';
import { openRecord, sealRecord } from '../../security/encryption.js';
import { recordAudit } from '../../security/audit.js';
import { notify } from '../notifications/service.js';
import { logger } from '../../config/logger.js';
import type { UpdateResidentReport } from './schemas.js';
import { liveReportStaff, staffNames } from './reportAccess.js';
import { getReportManagementMetadata } from './reportManagement.js';

const STAFF = ['superadmin', 'national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor'];
const SUPERVISORS = ['superadmin', 'national_admin', 'regional_organizer', 'local_coordinator'];
const STATUS_ACTION: Record<string, string> = { acknowledged: 'acknowledge', in_progress: 'follow_up', resolved: 'resolve', closed: 'close' };

export function maskReference(value: string): string {
  return value.length < 8 ? '*'.repeat(value.length) : `${value[0]}${'*'.repeat(value.length - 2)}${value.at(-1)}`;
}

/** Called only after parent-report authorization, never as a substitute for it. */
export async function reportWorkflowView(id: string, principal: Principal) {
  if (STAFF.includes(principal.role) && principal.permissions?.includes(Permission.REPORT_READ)) principal = await liveReportStaff(principal);
  const { rows: [r] } = await query(`SELECT user_id, councillor_user_id, ward_code, sealed_reference,
    masked_reference, reference_kind, c3_requirement, c3_reason, version, acknowledged_at, resolved_at, confirmed_at, follow_up_at,
    EXISTS (SELECT 1 FROM users u WHERE u.id = councillor_user_id AND u.is_active AND u.moderation_status NOT IN ('banned','suspended') AND u.role = 'ward_councillor' AND u.ward_code = resident_reports.ward_code) AS active_assignment
    FROM resident_reports WHERE id = $1`, [id]);
  if (!r) throw ApiError.notFound('Report not found');
  const owner = r.user_id === principal.sub;
  const staff = STAFF.includes(principal.role) && principal.permissions?.includes(Permission.REPORT_READ)
    && (isNationalAdmin(principal.role) || (!!r.ward_code && await principalSeesWard(principal, r.ward_code)));
  if (!owner && !staff) throw ApiError.forbidden('You do not have access to this report');
  const fullReference = owner || (staff && ((r.active_assignment && r.councillor_user_id === principal.sub) || SUPERVISORS.includes(principal.role)));
  const reference = fullReference && r.sealed_reference
    ? (await openRecord(id, r.sealed_reference)).reference ?? null : r.masked_reference ?? null;
  if (fullReference && r.sealed_reference) await recordAudit({ action: 'transparency.reference.read', actorId: principal.sub,
    actorRole: principal.role, targetType: 'resident_report', targetId: id, metadata: { owner } });
  const events = await query(`SELECT id, CASE WHEN $2 THEN actor_id ELSE NULL END AS "actorId", actor_role AS "actorRole", action, from_status AS "fromStatus",
    to_status AS "toStatus", note, contact_method AS "contactMethod", follow_up_at AS "followUpAt",
    CASE WHEN $2 THEN contact_target ELSE NULL END AS "contactTarget",
    CASE WHEN $2 THEN contact_method_detail ELSE NULL END AS "contactMethodDetail",
    CASE WHEN $2 THEN internal_note ELSE NULL END AS "internalNote",
    CASE WHEN $2 THEN metadata ELSE '{}'::jsonb END AS metadata,
    created_at AS "createdAt" FROM resident_report_events WHERE report_id = $1
    AND ($2 OR action <> 'internal_note') ORDER BY created_at, id`, [id, !!staff]);
  const names = staff ? await staffNames(events.rows.map((e) => e.actorId), principal) : {};
  return {
    c3Requirement: r.c3_requirement, c3Reason: staff ? r.c3_reason : undefined,
    referenceKind: r.reference_kind, hasC3: r.reference_kind === 'c3' && !!r.sealed_reference,
    version: r.version, externalReference: reference, referenceMasked: !fullReference,
    acknowledgedAt: r.acknowledged_at, resolvedAt: r.resolved_at, confirmedAt: r.confirmed_at,
    followUpAt: r.follow_up_at, assigned: !!r.active_assignment,
    ...(staff ? await getReportManagementMetadata(id, principal) : {}),
    canManage: staff && principal.permissions?.includes(Permission.REPORT_WRITE),
    isOwner: owner, canSetReference: staff && fullReference,
    events: events.rows.map((e) => ({ ...e, ...(staff ? { actorName: names[e.actorId] ?? 'Former staff member' } : {}) })),
  };
}

export async function applyReportAction(id: string, input: UpdateResidentReport, principal: Principal,
  ctx: { ip: string | null; userAgent: string | null }) {
  const result = await withTransaction(async (client) => {
    if (STAFF.includes(principal.role)) principal = await liveReportStaff(principal, true, client);
    const { rows: [r] } = await client.query(`SELECT *,
      EXISTS (SELECT 1 FROM users u WHERE u.id = councillor_user_id AND u.is_active AND u.moderation_status NOT IN ('banned','suspended') AND u.role = 'ward_councillor' AND u.ward_code = resident_reports.ward_code) AS active_assignment
      FROM resident_reports WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw ApiError.notFound('Report not found');
    const staff = STAFF.includes(principal.role) && principal.permissions?.includes(Permission.REPORT_READ)
      && (isNationalAdmin(principal.role) || (!!r.ward_code && await principalSeesWard(principal, r.ward_code)));
    const owner = r.user_id === principal.sub;
    const action = input.action ?? (STATUS_ACTION[input.status ?? ''] ?? (input.internalNote && !input.feedback && !input.externalReference ? 'internal_note' : 'update'));
    const memberAction = action === 'confirm' || action === 'request_follow_up';
    if (!principal.permissions?.includes(Permission.REPORT_WRITE) || (memberAction ? !owner : !staff)) throw ApiError.forbidden('This action is not available to you');
    if (memberAction && (input.externalReference !== undefined || input.contactMethod || input.contactTarget || input.contactMethodDetail || input.internalNote || input.followUpAt !== undefined || input.status || input.c3Requirement !== undefined || input.c3Reason !== undefined || input.referenceKind !== undefined)) {
      throw ApiError.badRequest('Member actions cannot change staff contact or reference fields');
    }
    if (input.requestId) {
      const previous = await client.query('SELECT actor_id FROM resident_report_events WHERE report_id = $1 AND request_id = $2', [id, input.requestId]);
      if (previous.rows[0]) {
        if (previous.rows[0].actor_id !== principal.sub) throw ApiError.conflict('Request already used');
        return null;
      }
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== r.version) throw ApiError.conflict('Report changed. Reload before saving.');
    if (input.status === 'submitted') throw ApiError.badRequest('A report cannot return to submitted');
    if (input.action && input.status) throw ApiError.badRequest('Provide an action or a status, not both');
    let status = r.status;
    const note = input.feedback?.trim() || null;
    if (['follow_up', 'request_follow_up', 'reopen', 'resolve', 'close', 'contact'].includes(action) && !note) {
      throw ApiError.badRequest('An outcome or reason is required');
    }
    if (action === 'acknowledge') {
      if (r.status !== 'submitted') throw ApiError.conflict('Only submitted reports can be acknowledged');
      status = 'acknowledged';
    }
    if (action === 'follow_up' || action === 'contact') {
      if (!['acknowledged', 'in_progress'].includes(r.status)) throw ApiError.conflict('Acknowledge the report first; reopen resolved reports before follow-up');
      status = 'in_progress';
    }
    if (action === 'contact' && (!input.contactMethod || !input.contactTarget)) throw ApiError.badRequest('Contact method and organization/person are required');
    if (action === 'contact' && input.contactMethod === 'other' && !input.contactMethodDetail) throw ApiError.badRequest('Describe the other contact method');
    if (action === 'follow_up' && !input.followUpAt) throw ApiError.badRequest('Choose the next follow-up date');
    if (input.followUpAt && Date.parse(input.followUpAt) <= Date.now()) throw ApiError.badRequest('Follow-up date must be in the future');
    if (action === 'resolve') {
      if (!['acknowledged', 'in_progress'].includes(r.status)) throw ApiError.conflict('Only acknowledged or in-progress reports can be resolved');
      status = 'resolved';
    }
    if (action === 'confirm') {
      if (r.status !== 'resolved') throw ApiError.conflict('The councilor must resolve the report before confirmation');
      status = 'closed';
    }
    if (action === 'close') {
      if (r.status === 'closed') throw ApiError.conflict('Report is already completed');
      status = 'closed';
    }
    if (action === 'reopen' && !['resolved', 'closed'].includes(r.status)) throw ApiError.conflict('Only resolved or closed reports can be reopened');
    if (['request_follow_up', 'reopen'].includes(action) && ['resolved', 'closed'].includes(r.status)) status = 'in_progress';
    const canSetReference = staff && ((r.active_assignment && r.councillor_user_id === principal.sub) || SUPERVISORS.includes(principal.role));
    if ((input.externalReference || input.referenceKind !== undefined) && !canSetReference) throw ApiError.forbidden('Only assigned staff or territorial supervisors may change the reference');
    if (input.referenceKind === 'c3' && !input.externalReference && !r.sealed_reference) throw ApiError.badRequest('Enter a C3 number before marking the reference as C3');
    const requirement = input.c3Requirement ?? r.c3_requirement;
    const c3Reason = input.c3Reason !== undefined ? input.c3Reason : r.c3_reason;
    if (requirement === 'not_required' && !c3Reason) throw ApiError.badRequest('Explain why a C3 number is not required');
    const c3Changed = input.c3Requirement !== undefined || input.c3Reason !== undefined || input.referenceKind !== undefined;
    const sealed = input.externalReference ? await sealRecord(id, { reference: input.externalReference }) : null;
    await client.query(`UPDATE resident_reports SET status = $2, updated_at = now(), version = version + 1,
      feedback = COALESCE($3, feedback), responded_at = CASE WHEN $3::text IS NOT NULL AND $4 THEN now() ELSE responded_at END,
      responded_by = CASE WHEN $3::text IS NOT NULL AND $4 THEN $5::uuid ELSE responded_by END,
      acknowledged_at = CASE WHEN $6 = 'acknowledge' THEN now() ELSE acknowledged_at END,
      resolved_at = CASE WHEN $6 = 'resolve' THEN now() WHEN $6 IN ('request_follow_up','reopen') THEN NULL ELSE resolved_at END,
      confirmed_at = CASE WHEN $6 = 'confirm' THEN now() WHEN $6 IN ('request_follow_up','reopen') THEN NULL ELSE confirmed_at END,
      follow_up_at = CASE WHEN $2 IN ('resolved','closed') THEN NULL WHEN $7 THEN $8::timestamptz ELSE follow_up_at END,
      sealed_reference = COALESCE($9::jsonb, sealed_reference), masked_reference = COALESCE($10, masked_reference),
      c3_requirement=$11, c3_reason=$12, reference_kind=COALESCE($13,reference_kind)
      WHERE id = $1`, [id, status, staff && !memberAction ? note : null, staff, principal.sub, action,
      input.followUpAt !== undefined, input.followUpAt ?? null, sealed ? JSON.stringify(sealed) : null,
      input.externalReference ? maskReference(input.externalReference) : null, requirement, c3Reason, input.referenceKind ?? null]);
    await client.query(`INSERT INTO resident_report_events(report_id, actor_id, actor_role, action,
      from_status, to_status, note, contact_method, contact_target, follow_up_at, request_id, contact_method_detail, internal_note, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, principal.sub, principal.role, action,
      r.status, status, note, input.contactMethod ?? null, input.contactTarget ?? null, input.followUpAt ?? null, input.requestId ?? null,
      input.contactMethodDetail ?? null, input.internalNote ?? null,
      JSON.stringify(c3Changed ? { c3Requirement: requirement, c3Reason, referenceKind: input.referenceKind ?? r.reference_kind } : {})]);
    const recipient = memberAction ? (r.active_assignment ? r.councillor_user_id : null) : r.user_id;
    if (recipient && action !== 'internal_note') await notify({ userId: recipient, kind: 'report', title: 'Report updated',
      body: 'Open your report to view the latest action and reference.', link: `tab:engage#report:${id}`, regionCode: r.ward_code }, client);
    return { ward: r.ward_code, action, status };
  });
  if (!result) return;
  // Committed work must not be reported as failed because notification transport failed.
  await Promise.allSettled([
    recordAudit({ action: 'transparency.report.update', actorId: principal.sub, actorRole: principal.role,
      targetType: 'resident_report', targetId: id, regionCode: result.ward,
      metadata: { action: result.action, status: result.status, referenceChanged: !!input.externalReference, c3Requirement: input.c3Requirement, referenceKind: input.referenceKind }, ...ctx }),

  ]).then((results) => {
    if (results.some((r) => r.status === 'rejected')) logger.error({ reportId: id }, 'Report committed; audit or notification delivery failed');
  });
}
