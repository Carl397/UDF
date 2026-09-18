import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { sealRecord, openRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import { notify } from '../notifications/service.js';
import { isDeviceBanned } from '../auth/service.js';
import { provisionMemberUser } from '../onboarding/service.js';
import { logger } from '../../config/logger.js';
import { TERMS_VERSION } from '../public/content.js';
import type { MemberTier } from '../members/schemas.js';

/**
 * Public membership flows.
 *
 * Three link types power the "join → confirm → mandate" journey:
 *   • verify link   /v/<public_code>  — the QR on a party ID card. Public,
 *                     privacy-preserving: membership number, ward, roles and
 *                     status only. Contact details appear only when the member
 *                     consented to data sharing.
 *   • confirm link  /confirm/<token>  — proves the registrant controls the
 *                     contact they gave us; flips `pending` → `active`.
 *   • mandate link  /confirm/<token>  — same mechanism, bound to an
 *                     appointment; accepting it confirms the mandate.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — human friendly

export function newPublicCode(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `UDF-${out.slice(0, 3)}-${out.slice(3)}`;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function publicUrl(path: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
}

/** Join link used by the QR card / posters; `ref` attributes the recruit. */
export function joinUrl(ref?: string | null): string {
  return publicUrl(`/register${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
}

export async function issueToken(input: {
  memberId: string;
  appointmentId?: string | null;
  kind: 'register' | 'mandate';
  ttlDays?: number;
}): Promise<{ token: string; expiresAt: string; confirmUrl: string }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + (input.ttlDays ?? 14) * 86_400_000);
  await query(
    `INSERT INTO member_tokens (member_id, appointment_id, kind, token, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.memberId, input.appointmentId ?? null, input.kind, token, expiresAt.toISOString()],
  );
  return { token, expiresAt: expiresAt.toISOString(), confirmUrl: publicUrl(`/confirm/${token}`) };
}

/** Assign a public verify code once; safe to call repeatedly. */
export async function ensurePublicCode(memberId: string): Promise<string> {
  const existing = await query<{ public_code: string | null }>(
    'SELECT public_code FROM members WHERE id = $1',
    [memberId],
  );
  const current = existing.rows[0]?.public_code;
  if (current) return current;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPublicCode();
    try {
      await query('UPDATE members SET public_code = $1 WHERE id = $2', [code, memberId]);
      return code;
    } catch {
      /* collision — retry */
    }
  }
  throw ApiError.internal('Could not allocate a public code');
}

// ── Public registration ──────────────────────────────────────────
export const registerSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(320),
  phone: z.string().min(3).max(32).optional(),
  address: z.string().max(500).optional(),
  regionCode: z.string().min(1).max(32),
  districtCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  tier: z.enum(['voter', 'volunteer', 'activist', 'donor']).default('voter'),
  motivation: z.string().max(1000).optional(),
  referral: z.string().max(64).optional(),
  /** Terms & Conditions must be accepted to register (records the version). */
  tcAccepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms & Conditions to register' }),
  }),
  consent: z
    .object({
      emailOptin: z.boolean().default(true),
      smsOptin: z.boolean().default(false),
      phoneOptin: z.boolean().default(false),
      dataShare: z.boolean().default(false),
    })
    .default({ emailOptin: true, smsOptin: false, phoneOptin: false, dataShare: false }),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export interface RegisterResult {
  memberId: string;
  membershipNo: string;
  publicCode: string;
  status: string;
  confirmUrl: string;
  verifyUrl: string;
  joinUrl: string;
}

export async function registerMember(
  input: RegisterInput,
  ctx: { ip?: string | null; userAgent?: string | null; actorId?: string | null; deviceId?: string | null },
): Promise<RegisterResult> {
  // A blocked device cannot register, mirroring the login-time device ban.
  if (await isDeviceBanned(ctx.deviceId)) {
    throw new ApiError(403, 'device_banned', 'This device has been blocked from registering.');
  }

  const id = randomUUID();
  const sealed = await sealRecord(id, {
    fullName: input.fullName,
    email: input.email,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.address ? { address: input.address } : {}),
  });

  const emailBidx = blindIndex('email', input.email);
  const dup = await query<{ id: string }>('SELECT id FROM members WHERE email_bidx = $1', [
    emailBidx,
  ]);
  if (dup.rows[0]) {
    throw ApiError.conflict('That email is already registered with the party');
  }

  const publicCode = newPublicCode();
  const membershipNo = `UDF-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const hasGeo = input.lat !== undefined && input.lng !== undefined;

  // FR-O1/O3: resolve the recruitment attribution into a durable member link.
  // The referral code (`?ref=` / "Referred by" field) is a member PUBLIC CODE and
  // wins; failing that, a staff actor registering from their own session
  // attributes the recruit to themselves (their `sub` → their member row). An
  // unresolvable or blank code leaves the link NULL (organic signup) — never an
  // error, so a mistyped reference can never block registration.
  let referredByMemberId: string | null = null;
  const referralCode = input.referral?.trim();
  if (referralCode) {
    const ref = await query<{ id: string }>(
      `SELECT id FROM members WHERE public_code = $1 AND deleted_at IS NULL LIMIT 1`,
      [referralCode],
    );
    referredByMemberId = ref.rows[0]?.id ?? null;
  }
  if (!referredByMemberId && ctx.actorId) {
    const actor = await query<{ id: string }>(
      `SELECT id FROM members WHERE created_by = $1 AND deleted_at IS NULL LIMIT 1`,
      [ctx.actorId],
    );
    referredByMemberId = actor.rows[0]?.id ?? null;
  }

  await withTransaction(async (client) => {
    // Placeholder numbering has to stay contiguous: when the applicant gives no
    // coordinates the lat/lng params are left out entirely, because Postgres
    // cannot infer the type of a parameter the statement never references.
    const params: unknown[] = [
      id,
      membershipNo,
      publicCode,
      input.tier,
      input.regionCode,
      input.districtCode ?? null,
      input.ward ?? null,
    ];

    let locationSql = 'NULL';
    if (hasGeo) {
      const latAt = params.push(input.lat);
      const lngAt = params.push(input.lng);
      locationSql = `ST_SetSRID(ST_MakePoint($${latAt},$${lngAt}),4326)::geography`;
    }

    const sealedAt = params.push(JSON.stringify(sealed));
    params.push(emailBidx);
    params.push(input.phone ? blindIndex('phone', input.phone) : null);
    params.push(['self-registered', ...(input.ward ? [`ward:${input.ward}`] : [])]);
    params.push(input.referral ?? null);
    params.push(ctx.actorId ?? null);
    // Terms accepted at registration: stamp the server's current version.
    params.push(TERMS_VERSION);
    params.push(new Date().toISOString());
    // FR-O1: the resolved recruitment link (public-code referrer, else the staff
    // actor's own member row). It is the LAST parameter, `$sealedAt + 8` below.
    params.push(referredByMemberId);

    await client.query(
      `INSERT INTO members
         (id, membership_no, public_code, tier, status, region_code, district_code, ward,
          location, heat_weight, sealed_pii, email_bidx, phone_bidx, tags, referral, created_by,
          tc_version, tc_accepted_at, referred_by_member_id)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,
               ${locationSql},
               1, $${sealedAt}::jsonb, $${sealedAt + 1}, $${sealedAt + 2}, $${sealedAt + 3},
               $${sealedAt + 4}, $${sealedAt + 5}, $${sealedAt + 6}, $${sealedAt + 7}, $${sealedAt + 8})`,
      params,
    );

    await client.query(
      `INSERT INTO member_consents (member_id, email_optin, sms_optin, phone_optin, data_share, gdpr_basis)
       VALUES ($1,$2,$3,$4,$5,'consent')`,
      [
        id,
        input.consent.emailOptin,
        input.consent.smsOptin,
        input.consent.phoneOptin,
        input.consent.dataShare,
      ],
    );
  });

  const { confirmUrl } = await issueToken({ memberId: id, kind: 'register', ttlDays: 14 });

  await recordAudit({
    action: 'member.register',
    actorId: ctx.actorId ?? null,
    actorRole: 'public',
    targetType: 'member',
    targetId: id,
    regionCode: input.regionCode,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: { tier: input.tier, source: input.referral ? 'referral' : 'direct', membershipNo, referredBy: referredByMemberId },
  });

  await notify({
    kind: 'member',
    title: 'New membership application',
    body: `${membershipNo} · ${input.regionCode}${input.ward ? ` · Ward ${input.ward}` : ''} — awaiting confirmation`,
    link: `tab:members#${id}`,
    regionCode: input.regionCode,
    audience: 'staff',
  });

  // FR-P1/P2: provision the member's login account and email the starter pack
  // with their one-time sign-in code. Best-effort — a provisioning or mail
  // failure must never roll back or block a successful registration (a resend
  // exists at POST /auth/otp/resend), so it is caught and logged, not thrown.
  try {
    await provisionMemberUser(id, {
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      actorId: ctx.actorId ?? null,
    });
  } catch (err) {
    logger.error({ err, memberId: id }, 'Onboarding provisioning failed (registration continues)');
  }

  return {
    memberId: id,
    membershipNo,
    publicCode,
    status: 'pending',
    confirmUrl,
    verifyUrl: publicUrl(`/v/${publicCode}`),
    joinUrl: joinUrl(publicCode),
  };
}

// ── Confirmation (membership + mandate) ──────────────────────────
export interface ConfirmResult {
  kind: 'register' | 'mandate';
  membershipNo: string;
  status: string;
  mandateAccepted: boolean;
  position: string | null;
  ward: string | null;
  regionCode: string | null;
  alreadyUsed: boolean;
  verifyUrl: string;
}

export async function confirmToken(
  token: string,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<ConfirmResult> {
  const found = await query<{
    id: string;
    member_id: string;
    appointment_id: string | null;
    kind: 'register' | 'mandate';
    used_at: string | null;
    expires_at: string;
    membership_no: string | null;
    public_code: string | null;
    status: string;
    region_code: string | null;
    ward: string | null;
    appt_region: string | null;
    appt_ward: string | null;
    position_name: string | null;
  }>(
    `SELECT t.id, t.member_id, t.appointment_id, t.kind, t.used_at, t.expires_at,
            m.membership_no, m.public_code, m.status, m.region_code, m.ward,
            a.region_code AS appt_region, a.ward AS appt_ward,
            p.name AS position_name
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
  LEFT JOIN appointments a ON a.id = t.appointment_id
  LEFT JOIN positions p ON p.code = a.position_code
      WHERE t.token = $1`,
    [token],
  );

  const row = found.rows[0];
  if (!row) throw ApiError.notFound('This link is not valid');

  // A mandate confirms an office, so the appointment's own ward and region are
  // the ones worth showing — the member's home ward may be a different one.
  const ward = row.appt_ward ?? row.ward;
  const regionCode = row.appt_region ?? row.region_code;

  if (row.used_at) {
    return {
      kind: row.kind,
      membershipNo: row.membership_no ?? '—',
      status: row.status,
      mandateAccepted: row.kind === 'mandate',
      position: row.position_name,
      ward,
      regionCode,
      alreadyUsed: true,
      verifyUrl: row.public_code ? publicUrl(`/v/${row.public_code}`) : '',
    };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw ApiError.badRequest('This link has expired — please request a new one');
  }

  await withTransaction(async (client) => {
    await client.query('UPDATE member_tokens SET used_at = now() WHERE id = $1', [row.id]);

    if (row.kind === 'mandate' && row.appointment_id) {
      await client.query(
        `UPDATE appointments
            SET status = 'confirmed', mandate_accepted_at = now()
          WHERE id = $1`,
        [row.appointment_id],
      );
      await client.query('UPDATE members SET mandate_accepted_at = now() WHERE id = $1', [
        row.member_id,
      ]);
    }

    await client.query(
      `UPDATE members
          SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              joined_at = COALESCE(joined_at, now())
        WHERE id = $1`,
      [row.member_id],
    );
  });

  const after = await query<{ status: string }>('SELECT status FROM members WHERE id = $1', [
    row.member_id,
  ]);
  const status = after.rows[0]?.status ?? row.status;

  await recordAudit({
    action: row.kind === 'mandate' ? 'mandate.accept' : 'member.confirm',
    actorRole: 'public',
    targetType: row.kind === 'mandate' ? 'appointment' : 'member',
    targetId: row.kind === 'mandate' ? row.appointment_id : row.member_id,
    regionCode,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: { membershipNo: row.membership_no, kind: row.kind },
  });

  await notify({
    kind: row.kind === 'mandate' ? 'mandate' : 'member',
    title:
      row.kind === 'mandate'
        ? `Mandate accepted: ${row.position_name ?? 'appointment'}`
        : 'Membership confirmed',
    body: `${row.membership_no ?? ''}${ward ? ` · Ward ${ward}` : ''}`,
    link: row.kind === 'mandate' ? 'tab:engage#appointments' : `tab:members#${row.member_id}`,
    regionCode,
    audience: 'staff',
  });

  // FR-P1: backfill a login account for anyone who registered before onboarding
  // existed (or while the flag was off). `onlyIfMissing` means an already-
  // provisioned member is not re-emailed. Best-effort; never blocks confirmation.
  try {
    await provisionMemberUser(
      row.member_id,
      { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null },
      { onlyIfMissing: true },
    );
  } catch (err) {
    logger.error({ err, memberId: row.member_id }, 'Onboarding provisioning failed (confirmation continues)');
  }

  return {
    kind: row.kind,
    membershipNo: row.membership_no ?? '—',
    status,
    mandateAccepted: row.kind === 'mandate',
    position: row.position_name,
    ward,
    regionCode,
    alreadyUsed: false,
    verifyUrl: row.public_code ? publicUrl(`/v/${row.public_code}`) : '',
  };
}

// ── Public verification card (QR target) ─────────────────────────
export interface VerifyCard {
  membershipNo: string | null;
  publicCode: string;
  tier: MemberTier;
  status: string;
  regionCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  mandateAcceptedAt: string | null;
  confirmed: boolean;
  roles: { name: string; title: string | null; ward: string | null; status: string }[];
  /** Present only when the member consented to sharing contact details. */
  contact: { fullName: string; phone?: string; email?: string } | null;
  joinUrl: string;
  vcard: string;
}

export async function verifyByCode(
  code: string,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<VerifyCard> {
  const res = await query<{
    id: string;
    membership_no: string | null;
    public_code: string;
    tier: MemberTier;
    status: string;
    region_code: string | null;
    ward: string | null;
    joined_at: string | null;
    mandate_accepted_at: string | null;
    sealed_pii: any;
    data_share: boolean | null;
  }>(
    `SELECT m.id, m.membership_no, m.public_code, m.tier, m.status, m.region_code, m.ward,
            m.joined_at, m.mandate_accepted_at, m.sealed_pii, c.data_share
       FROM members m
  LEFT JOIN member_consents c ON c.member_id = m.id
      WHERE m.public_code = $1 AND m.deleted_at IS NULL`,
    [code],
  );
  const m = res.rows[0];
  if (!m) throw ApiError.notFound('No active party card matches this code');

  const rolesRes = await query<{
    name: string;
    title: string | null;
    ward: string | null;
    status: string;
  }>(
    `SELECT p.name, a.title, a.ward, a.status
       FROM appointments a
       JOIN positions p ON p.code = a.position_code
      WHERE a.member_id = $1 AND a.status <> 'revoked'
      ORDER BY a.created_at DESC`,
    [m.id],
  );

  // Contact details are only released with explicit consent — and audited.
  let contact: VerifyCard['contact'] = null;
  if (m.data_share) {
    const opened = (await openRecord(m.id, m.sealed_pii)) as Record<string, string>;
    contact = {
      fullName: opened.fullName ?? 'UDF Member',
      ...(opened.phone ? { phone: opened.phone } : {}),
      ...(opened.email ? { email: opened.email } : {}),
    };
    await recordAudit({
      action: 'member.pii.decrypt',
      actorRole: 'public_verify',
      targetType: 'member',
      targetId: m.id,
      regionCode: m.region_code,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { fields: Object.keys(opened), via: 'qr_verify', consent: 'data_share' },
    });
  } else {
    await recordAudit({
      action: 'member.public_verify',
      actorRole: 'public',
      targetType: 'member',
      targetId: m.id,
      regionCode: m.region_code,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: { code: m.public_code },
    });
  }

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${contact ? contact.fullName : 'UDF Party Card'}`,
    `FN:${contact ? contact.fullName : 'UDF Party'}`,
    'ORG:UDF Party',
    ...(rolesRes.rows[0] ? [`TITLE:${rolesRes.rows[0].name}`] : []),
    ...(contact?.phone ? [`TEL;TYPE=CELL:${contact.phone}`] : []),
    ...(contact?.email ? [`EMAIL:${contact.email}`] : []),
    `NOTE:Membership ${m.membership_no ?? m.public_code}${m.ward ? ` · Ward ${m.ward}` : ''}`,
    `URL:${joinUrl(m.public_code)}`,
    'END:VCARD',
  ].join('\n');

  return {
    membershipNo: m.membership_no,
    publicCode: m.public_code,
    tier: m.tier,
    status: m.status,
    regionCode: m.region_code,
    ward: m.ward,
    joinedAt: m.joined_at,
    mandateAcceptedAt: m.mandate_accepted_at,
    confirmed: m.status === 'active',
    roles: rolesRes.rows.map((r) => ({
      name: r.name,
      title: r.title,
      ward: r.ward,
      status: r.status,
    })),
    contact,
    joinUrl: joinUrl(m.public_code),
    vcard,
  };
}
