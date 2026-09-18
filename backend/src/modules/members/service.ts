import { randomUUID } from 'node:crypto';
import { sealRecord, openRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import { ensurePublicCode } from '../memberships/service.js';
import type { Principal } from '../../auth/permissions.js';
import { isNationalScope } from '../../auth/permissions.js';
import { principalSeesMember } from '../../auth/scope.js';
import * as repo from './repository.js';
import type { MemberRow, MemberView, MemberScope, ConsentRow } from './types.js';
import type {
  CreateMemberInput,
  UpdateMemberInput,
  ListMembersQuery,
  Pii,
} from './schemas.js';

/**
 * Members domain service.
 *
 * Responsibilities:
 *   • Seal PII (Layer 3) before persistence; compute blind indexes for search.
 *   • Enforce region scope derived from the caller's principal.
 *   • Emit audit events for every sensitive action (esp. PII decryption).
 */

interface ActorCtx {
  actorId?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Resolve the row filter for this caller.
 *
 * National scope ⇒ `null` (no filter). Otherwise BOTH the ward and the parent
 * regions are applied and AND-ed, because `principal.regionCodes` holds the
 * subcouncil rather than the ward: filtering on regions alone let a
 * ward_councillor read every member in the whole subcouncil, including the
 * adjacent control ward.
 */
function scopeFor(p: Principal): MemberScope {
  if (isNationalScope(p)) return null;
  return { ward: p.wardCode ?? null, regions: p.regionCodes ?? [] };
}

function rowToView(row: MemberRow, consent?: ConsentRow | null, pii?: Partial<Pii> | null): MemberView {
  return {
    id: row.id,
    membershipNo: row.membership_no,
    tier: row.tier,
    status: row.status,
    regionCode: row.region_code,
    districtCode: row.district_code,
    lat: row.lat,
    lng: row.lng,
    heatWeight: Number(row.heat_weight),
    tags: row.tags ?? [],
    publicCode: row.public_code ?? null,
    ward: row.ward ?? null,
    joinedAt: row.joined_at ?? null,
    consent: consent
      ? {
          emailOptin: consent.email_optin,
          smsOptin: consent.sms_optin,
          phoneOptin: consent.phone_optin,
          dataShare: consent.data_share,
          gdprBasis: (consent.gdpr_basis as any) ?? undefined,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pii: pii ?? null,
  };
}

export async function createMember(
  input: CreateMemberInput,
  actor: ActorCtx & { principal?: Principal },
): Promise<MemberView> {
  const id = randomUUID();

  // Territory check on the record being created. `requireRegionInScope` on the
  // route only validates `regionCode`, which for a ward-scoped caller is their
  // whole subcouncil — so a `local_coordinator` could enrol a member tagged to
  // a neighbouring ward. A ward-scoped caller who omits the ward gets their own.
  //
  // `principal` is absent for system callers (the seed scripts), which have no
  // territory of their own and are trusted to place members deliberately.
  const p = actor.principal;
  const ward = input.ward ?? p?.wardCode ?? null;
  if (p && !(await principalSeesMember(p, { regionCode: input.regionCode, ward }))) {
    throw ApiError.forbidden('Member outside your authorized scope');
  }

  const sealed = await sealRecord(id, {
    fullName: input.pii.fullName,
    email: input.pii.email,
    ...(input.pii.phone ? { phone: input.pii.phone } : {}),
    ...(input.pii.address ? { address: input.pii.address } : {}),
  });

  const row = await repo.insertMember({
    id,
    membershipNo: input.membershipNo ?? null,
    tier: input.tier,
    status: input.status,
    regionCode: input.regionCode,
    districtCode: input.districtCode ?? null,
    ward,
    lat: input.lat,
    lng: input.lng,
    heatWeight: input.heatWeight,
    tags: input.tags,
    sealedPii: sealed,
    emailBidx: blindIndex('email', input.pii.email),
    phoneBidx: input.pii.phone ? blindIndex('phone', input.pii.phone) : null,
    createdBy: actor.actorId ?? null,
  });

  let consent: ConsentRow | null = null;
  if (input.consent) {
    consent = await repo.upsertConsent(id, input.consent);
  }

  // Every member gets a public QR/verify code so a party card can be issued.
  row.public_code = await ensurePublicCode(id);

  await recordAudit({
    action: 'member.create',
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    targetType: 'member',
    targetId: id,
    regionCode: input.regionCode,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { tier: input.tier, status: input.status },
  });

  return rowToView(row, consent, null);
}

export async function getMember(
  id: string,
  principal: Principal,
  opts: { decryptPii?: boolean } & ActorCtx = {},
): Promise<MemberView> {
  const scope = scopeFor(principal);
  const row = await repo.findMemberById(id, scope);
  if (!row) throw ApiError.notFound('Member not found');

  const consent = await repo.getConsent(id);

  let pii: Partial<Pii> | null = null;
  if (opts.decryptPii) {
    const opened = await openRecord(row.id, row.sealed_pii);
    pii = opened as Partial<Pii>;
    // Every PII decryption is audited — this is the sensitive-path signal.
    await recordAudit({
      action: 'member.pii.decrypt',
      actorId: principal.sub,
      actorRole: principal.role,
      targetType: 'member',
      targetId: id,
      regionCode: row.region_code,
      ip: opts.ip,
      userAgent: opts.userAgent,
      metadata: { fields: Object.keys(opened) },
    });
  }

  return rowToView(row, consent, pii);
}

export async function listMembers(
  q: ListMembersQuery,
  principal: Principal,
): Promise<{ items: MemberView[]; total: number; limit: number; offset: number }> {
  const scope = scopeFor(principal);
  const { rows, total } = await repo.listMembers(q, scope);
  return {
    items: rows.map((r) => rowToView(r, null, null)),
    total,
    limit: q.limit,
    offset: q.offset,
  };
}

export async function updateMember(
  id: string,
  input: UpdateMemberInput,
  actor: ActorCtx & { principal: Principal },
): Promise<MemberView> {
  const scope = scopeFor(actor.principal);
  const existing = await repo.findMemberById(id, scope);
  if (!existing) throw ApiError.notFound('Member not found');

  // Moving a member between wards or regions is a write into the DESTINATION as
  // well as the source. Checking only the source let a ward official push a
  // member into a ward they do not represent — out of their own view and into
  // somebody else's data.
  if (input.regionCode !== undefined || input.ward !== undefined) {
    const dest = {
      regionCode: input.regionCode !== undefined ? input.regionCode : existing.region_code,
      ward: input.ward !== undefined ? input.ward : existing.ward,
    };
    if (!(await principalSeesMember(actor.principal, dest))) {
      throw ApiError.forbidden('Destination ward outside your authorized scope');
    }
  }

  const patch: repo.MemberPatch = {};
  if (input.membershipNo !== undefined) patch.membershipNo = input.membershipNo;
  if (input.tier !== undefined) patch.tier = input.tier;
  if (input.status !== undefined) patch.status = input.status;
  if (input.regionCode !== undefined) patch.regionCode = input.regionCode;
  if (input.districtCode !== undefined) patch.districtCode = input.districtCode;
  if (input.ward !== undefined) patch.ward = input.ward;
  if (input.lat !== undefined) patch.lat = input.lat;
  if (input.lng !== undefined) patch.lng = input.lng;
  if (input.heatWeight !== undefined) patch.heatWeight = input.heatWeight;
  if (input.tags !== undefined) patch.tags = input.tags;

  // PII update: merge with existing plaintext, then re-seal under a fresh DEK.
  if (input.pii && Object.keys(input.pii).length > 0) {
    const current = await openRecord(existing.id, existing.sealed_pii);
    const merged: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(input.pii)) {
      if (v !== undefined) merged[k] = String(v);
    }
    const sealed = await sealRecord(id, merged);
    patch.sealedPii = sealed;
    if (merged.email) patch.emailBidx = blindIndex('email', merged.email);
    if (merged.phone) patch.phoneBidx = blindIndex('phone', merged.phone);
  }

  const row = await repo.updateMember(id, patch, scope);
  if (!row) throw ApiError.notFound('Member not found');

  let consent: ConsentRow | null = await repo.getConsent(id);
  if (input.consent) {
    consent = await repo.upsertConsent(id, input.consent);
    await recordAudit({
      action: 'consent.update',
      actorId: actor.principal.sub,
      actorRole: actor.principal.role,
      targetType: 'member',
      targetId: id,
      regionCode: row.region_code,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  await recordAudit({
    action: 'member.update',
    actorId: actor.principal.sub,
    actorRole: actor.principal.role,
    targetType: 'member',
    targetId: id,
    regionCode: row.region_code,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(patch) },
  });

  return rowToView(row, consent, null);
}

export async function deleteMember(
  id: string,
  actor: ActorCtx & { principal: Principal },
): Promise<void> {
  const scope = scopeFor(actor.principal);
  const ok = await repo.softDeleteMember(id, scope);
  if (!ok) throw ApiError.notFound('Member not found');

  await recordAudit({
    action: 'member.delete',
    actorId: actor.principal.sub,
    actorRole: actor.principal.role,
    targetType: 'member',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}
