import { query } from '../../db/pool.js';
import { councillorForWard, councillorWasFielded } from '../transparency/service.js';
import { loadMediaBuffer } from '../crm/mediaService.js';
import { MANIFESTO, PARTY_PROFILE } from '../public/content.js';
import type { EmailAttachment } from '../../security/mailer.js';

/**
 * Starter-pack email (PRD-growth FR-Q1/Q2/Q3).
 *
 * One welcome email carries everything a new member needs to start and to hold
 * their councillor accountable:
 *   (a) welcome + membership number + reference number,
 *   (b) the 6-digit OTP and "use this as your first password, then change it",
 *   (c) the ward councillor's bio brochure (name, role, bio, public office
 *       contact) and photo,
 *   (d) the mini-manifesto (mission + pillar headlines, no outbound link — see
 *       the note above `esc`),
 *   (e) the party leader's picture + a short line,
 *   (f) a thank-you for joining and for keeping the councillor accountable, with
 *       a pointer to the in-app rating surface (FR-S).
 *
 * Content is resolved server-side and degrades gracefully: a ward with no
 * published councillor renders a vacancy block (never a broken email), worded to
 * match why the seat is empty — vacant when UDF contested the ward, "no
 * candidate" when it did not — and a missing photo simply omits that image.
 * Photos are embedded as CID inline
 * attachments (FR-Q3) so they render without a third-party host and survive the
 * self-signed edge — the plaintext part still carries the OTP and every fact.
 */

export interface StarterPackMember {
  to: string;
  fullName: string;
  membershipNo: string;
  publicCode: string;
  wardCode: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

interface LeaderBlock {
  fullName: string;
  position: string | null;
  bio: string | null;
  attachment: EmailAttachment | null;
}

interface CouncillorBlock {
  fullName: string;
  bio: string | null;
  contact: Record<string, unknown>;
  attachment: EmailAttachment | null;
}

const RED = PARTY_PROFILE.colors.red;
const BLACK = PARTY_PROFILE.colors.black;
const GOLD = PARTY_PROFILE.colors.gold;

// NB: there is deliberately no `appUrl()`/PUBLIC_BASE_URL link in this email.
// The mini-manifesto used to end with "Read the full manifesto →" pointing at
// `${PUBLIC_BASE_URL}/manifesto`, which resolves to
// https://crm.udf-party.co.za/manifesto. That page does not exist: the CRM
// static export has no /manifesto route, and nginx's `try_files … /index.html`
// fallback answers it with a 200 carrying the app shell — so the link looked
// alive and landed members on the sign-in app instead of a manifesto. The party
// manifesto lives on the public marketing site, whose base URL is NOT
// PUBLIC_BASE_URL (that origin is still correct for /register and /confirm
// links built in the memberships service). Re-add a link only against a URL
// that is known to serve manifesto content.
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turn a stored photo into a CID-inline attachment (null when absent/unreadable). */
async function photoAttachment(
  photoId: string | null | undefined,
  cid: string,
  filename: string,
): Promise<EmailAttachment | null> {
  if (!photoId) return null;
  const media = await loadMediaBuffer(photoId);
  if (!media) return null;
  const ext = media.contentType === 'image/png' ? 'png' : 'jpg';
  return { cid, filename: `${filename}.${ext}`, contentType: media.contentType, buffer: media.buffer };
}

async function resolveCouncillor(wardCode: string | null): Promise<CouncillorBlock | null> {
  if (!wardCode) return null;
  const c = await councillorForWard(wardCode);
  if (!c) return null;
  return {
    fullName: c.fullName,
    bio: c.bio,
    contact: (c.contactPublic ?? {}) as Record<string, unknown>,
    attachment: await photoAttachment(c.photoId, 'councillor', 'ward-councillor'),
  };
}

/** Party leader: President, else Secretary General, else Spokesperson. */
async function resolveLeader(): Promise<LeaderBlock | null> {
  const res = await query<{ full_name: string; bio: string | null; photo_id: string | null; position: string | null }>(
    `SELECT l.full_name, l.bio, l.photo_id, p.name AS position
       FROM leaders l
       LEFT JOIN positions p ON p.code = l.position_code
      WHERE l.is_public AND l.position_code IN ('PRESIDENT','SECRETARY_GENERAL','SPOKESPERSON')
      ORDER BY CASE l.position_code
                 WHEN 'PRESIDENT' THEN 0 WHEN 'SECRETARY_GENERAL' THEN 1 ELSE 2 END,
               l.updated_at DESC
      LIMIT 1`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    fullName: row.full_name,
    position: row.position,
    bio: row.bio,
    attachment: await photoAttachment(row.photo_id, 'leader', 'party-leader'),
  };
}

async function resolveWardName(wardCode: string | null): Promise<string | null> {
  if (!wardCode) return null;
  const res = await query<{ name: string }>(`SELECT name FROM regions WHERE code = $1`, [wardCode]);
  const raw = res.rows[0]?.name ?? wardCode;
  // Ensure ward names that are plain numbers get the "Ward" prefix
  return /^\d/.test(raw) ? `Ward ${raw}` : raw;
}

function contactLine(contact: Record<string, unknown>): string {
  const bits: string[] = [];
  const office = contact.officeEmail ?? contact.email;
  const phone = contact.officePhone ?? contact.phone ?? contact.whatsapp;
  if (office) bits.push(`📧 ${esc(office)}`);
  if (phone) bits.push(`📞 ${esc(phone)}`);
  if (contact.clinicDay) bits.push(`🗓 ${esc(contact.clinicDay)}`);
  return bits.join(' &nbsp;·&nbsp; ');
}

function miniManifestoHtml(): string {
  const pillars = MANIFESTO.pillars
    .map(
      (p) =>
        `<li style="margin:0 0 6px 0;"><strong style="color:${BLACK};">${esc(p.title)}</strong>` +
        `<span style="color:#555;"> — ${esc(p.points[0])}</span></li>`,
    )
    .join('');
  return `
    <div style="margin:0 0 8px 0;color:#333;font-size:15px;line-height:1.5;">${esc(MANIFESTO.mission)}</div>
    <ul style="margin:8px 0 0 18px;padding:0;">${pillars}</ul>`;
}

function miniManifestoText(): string {
  const pillars = MANIFESTO.pillars.map((p) => `• ${p.title} — ${p.points[0]}`).join('\n');
  return `${MANIFESTO.mission}\n\n${pillars}`;
}

/** Build the starter-pack email for a newly provisioned member. */
export async function buildStarterPackEmail(
  member: StarterPackMember,
  otp: string,
): Promise<RenderedEmail> {
  const [wardName, councillor, leader, fielded] = await Promise.all([
    resolveWardName(member.wardCode),
    resolveCouncillor(member.wardCode),
    resolveLeader(),
    member.wardCode ? councillorWasFielded(member.wardCode) : Promise.resolve(true),
  ]);

  // An empty ward has two honest explanations, and a welcome email naming the
  // wrong one is the one thing this mail can get badly wrong: a contested seat
  // that is currently empty will be filled, while a ward the party never stood
  // anyone in at LGE2026 had no seat to fill. A member with no ward on record
  // is neither, so they keep the neutral wording (`fielded` defaults true).
  const neverContested = !councillor && !fielded;

  const attachments: EmailAttachment[] = [];
  if (councillor?.attachment) attachments.push(councillor.attachment);
  if (leader?.attachment) attachments.push(leader.attachment);

  const firstName = member.fullName.split(' ')[0] || member.fullName;
  const subject = `Welcome to the ${PARTY_PROFILE.fullName} — your starter pack & sign-in code`;

  const councillorHtml = councillor
    ? `
      <tr><td style="padding:0 0 8px 0;">
        <h2 style="margin:0 0 10px 0;font-size:18px;color:${BLACK};">Your ward councillor</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:10px;overflow:hidden;">
          <tr>
            ${councillor.attachment ? `<td width="120" valign="top" style="padding:14px;background:#fafafa;"><img src="cid:councillor" alt="${esc(councillor.fullName)}" width="120" height="120" style="border-radius:8px;display:block;object-fit:cover;border:2px solid ${RED};" /></td>` : ''}
            <td valign="top" style="padding:14px;">
              <div style="font-size:17px;font-weight:700;color:${BLACK};">${esc(councillor.fullName)}</div>
              <div style="font-size:13px;color:${RED};font-weight:600;margin:2px 0 8px 0;">Ward Councillor${wardName ? ` · ${esc(wardName)}` : ''}</div>
              ${councillor.bio ? `<div style="font-size:14px;color:#333;line-height:1.5;margin:0 0 8px 0;">${esc(councillor.bio)}</div>` : ''}
              ${contactLine(councillor.contact) ? `<div style="font-size:13px;color:#444;">${contactLine(councillor.contact)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>`
    : `
      <tr><td style="padding:0 0 8px 0;">
        <h2 style="margin:0 0 10px 0;font-size:18px;color:${BLACK};">Your ward councillor</h2>
        <div style="border:1px dashed #ddd;border-radius:10px;padding:14px;background:#fafafa;color:#444;font-size:14px;line-height:1.5;">
          ${neverContested
            ? `UDF did not field a candidate in ${esc(wardName ?? 'this ward')} at the 2026 local elections, so there is no ward councillor here.`
            : `The ${esc(wardName ?? 'ward')} seat is currently <strong>vacant</strong>.`} In the meantime, your regional
          contact is the ${esc(PARTY_PROFILE.fullName)} National Secretariat —
          ${esc(PARTY_PROFILE.contacts.email)}.
        </div>
      </td></tr>`;

  const leaderHtml = leader
    ? `
      <tr><td style="padding:16px 0 8px 0;border-top:1px solid #f0f0f0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            ${leader.attachment ? `<td width="96" valign="top"><img src="cid:leader" alt="${esc(leader.fullName)}" width="88" height="88" style="border-radius:8px;display:block;object-fit:cover;border:2px solid ${GOLD};" /></td>` : ''}
            <td valign="top" style="${leader.attachment ? 'padding-left:14px;' : ''}">
              <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${RED};font-weight:700;">A word from our ${esc(leader.position ?? 'leadership')}</div>
              <div style="font-size:17px;font-weight:700;color:${BLACK};margin:2px 0 4px 0;">${esc(leader.fullName)}</div>
              <div style="font-size:14px;color:#333;line-height:1.5;">${esc(leader.bio ?? 'Thank you for joining the movement. Organise your street, hold your representatives to account, and we will deliver together.')}</div>
            </td>
          </tr>
        </table>
      </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:20px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ececec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${BLACK};padding:20px 24px;">
        <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:.02em;">${esc(PARTY_PROFILE.fullName)}</div>
        <div style="color:${GOLD};font-size:13px;margin-top:2px;">${esc(PARTY_PROFILE.tagline)} · ${esc(PARTY_PROFILE.slogan)}</div>
      </td></tr>
      <tr><td style="padding:24px;">
        <p style="margin:0 0 14px 0;font-size:16px;color:#222;line-height:1.5;">Welcome, <strong>${esc(firstName)}</strong> — you are now a member of the ${esc(PARTY_PROFILE.fullName)}.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">
          <tr>
            <td width="50%" style="padding:10px 12px;background:#fafafa;border:1px solid #eee;border-radius:8px;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;">Membership no</div>
              <div style="font-size:15px;font-weight:700;color:${BLACK};">${esc(member.membershipNo)}</div>
            </td>
            <td width="8"></td>
            <td width="50%" style="padding:10px 12px;background:#fafafa;border:1px solid #eee;border-radius:8px;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;">Reference no</div>
              <div style="font-size:15px;font-weight:700;color:${BLACK};">${esc(member.publicCode)}</div>
            </td>
          </tr>
        </table>

        <div style="border:2px solid ${RED};border-radius:12px;padding:16px;text-align:center;background:#fff6f5;margin:0 0 18px 0;">
          <div style="font-size:13px;color:#a11;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Your one-time sign-in code</div>
          <div style="font-size:38px;font-weight:800;letter-spacing:.28em;color:${BLACK};margin:6px 0 4px 0;">${esc(otp)}</div>
          <div style="font-size:13px;color:#555;line-height:1.5;">Open the app, sign in with your email and use this code as your <strong>first password</strong>. You will be asked to change it straight away. It expires in 10 minutes.</div>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${councillorHtml}</table>

        <tr><td style="padding:16px 0 8px 0;border-top:1px solid #f0f0f0;">
          <h2 style="margin:0 0 8px 0;font-size:18px;color:${BLACK};">The mini-manifesto</h2>
          ${miniManifestoHtml()}
        </td></tr>

        ${leaderHtml}

        <tr><td style="padding:18px 0 4px 0;border-top:1px solid #f0f0f0;">
          <div style="font-size:15px;color:#222;line-height:1.55;">
            Thank you for joining us in ${esc(wardName ?? 'your ward')}, and for helping keep our ward councillors
            <strong>accountable</strong>. Once you are signed in, open the app and tap
            <strong>“Rate your councillor”</strong> on the Home tab any time to score their performance each month —
            your honest feedback is what makes representation work.
          </div>
        </td></tr>
      </td></tr>
      <tr><td style="background:#fafafa;padding:16px 24px;border-top:1px solid #eee;">
        <div style="font-size:12px;color:#777;line-height:1.6;">
          ${esc(PARTY_PROFILE.fullName)} · ${esc(PARTY_PROFILE.contacts.address)}<br/>
          ${esc(PARTY_PROFILE.contacts.email)} · ${esc(PARTY_PROFILE.contacts.website)}<br/>
          You received this because you registered as a member. Your contact details are stored encrypted (POPIA).
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const cText = councillor
    ? `Your ward councillor: ${councillor.fullName}${wardName ? ` (${wardName})` : ''}\n${councillor.bio ?? ''}`.trim()
    : neverContested
      ? `UDF did not field a candidate in ${wardName ?? 'your ward'} at the 2026 local elections, so there is no ward councillor here. Regional contact: ${PARTY_PROFILE.contacts.email}.`
      : `Your ward seat (${wardName ?? 'your ward'}) is currently vacant. Regional contact: ${PARTY_PROFILE.contacts.email}.`;
  const lText = leader
    ? `A word from our ${leader.position ?? 'leadership'}, ${leader.fullName}:\n${leader.bio ?? 'Thank you for joining the movement.'}`
    : '';

  const text = `${PARTY_PROFILE.fullName} — ${PARTY_PROFILE.tagline}

Welcome, ${firstName}. You are now a member.

Membership no: ${member.membershipNo}
Reference no:  ${member.publicCode}

YOUR ONE-TIME SIGN-IN CODE: ${otp}
Open the app, sign in with your email and use this code as your FIRST password,
then change it when prompted. It expires in 10 minutes.

${cText}

THE MINI-MANIFESTO
${miniManifestoText()}

${lText}

Thank you for joining us and for helping keep our ward councillors accountable.
Once signed in, tap "Rate your councillor" on the Home tab any time to score
their performance each month.

${PARTY_PROFILE.fullName} · ${PARTY_PROFILE.contacts.address}
${PARTY_PROFILE.contacts.email}
You received this because you registered as a member. Your details are stored encrypted (POPIA).`;

  return { subject, html, text, attachments };
}

/** A short OTP-only resend (FR-P5) — no bio/manifesto, just the code. */
export function buildOtpResendEmail(member: StarterPackMember, otp: string): RenderedEmail {
  const firstName = member.fullName.split(' ')[0] || member.fullName;
  const subject = `Your ${PARTY_PROFILE.name} sign-in code`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f4f4f5;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#fff;border:1px solid #ececec;border-radius:14px;overflow:hidden;">
<tr><td style="background:${BLACK};padding:18px 22px;color:#fff;font-size:19px;font-weight:800;">${esc(PARTY_PROFILE.fullName)}</td></tr>
<tr><td style="padding:22px;">
<p style="margin:0 0 12px 0;font-size:15px;color:#222;">Hi ${esc(firstName)}, here is a fresh one-time sign-in code.</p>
<div style="border:2px solid ${RED};border-radius:12px;padding:16px;text-align:center;background:#fff6f5;">
<div style="font-size:34px;font-weight:800;letter-spacing:.28em;color:${BLACK};">${esc(otp)}</div>
<div style="font-size:13px;color:#555;margin-top:6px;">Use this as your password to sign in, then change it. Expires in 10 minutes.</div>
</div>
<p style="margin:14px 0 0 0;font-size:13px;color:#777;">If you did not request this, you can ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${PARTY_PROFILE.fullName}\n\nHi ${firstName}, your fresh one-time sign-in code is:\n\n${otp}\n\nUse it as your password to sign in, then change it. Expires in 10 minutes.\nIf you did not request this, ignore it.`;
  return { subject, html, text, attachments: [] };
}
