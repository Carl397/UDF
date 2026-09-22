import { query, withTransaction, withReadSnapshot } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { isNationalScope, Role, type Principal } from '../../auth/permissions.js';
import { principalSeesWard, wardCodeScope } from '../../auth/scope.js';
import { councillorForWard, councillorWasFielded } from '../transparency/service.js';
import { notify } from '../notifications/service.js';
import { rollupQuery, type AcknowledgeBody, type HistoryQuery, type RollupQuery, type SubmitScorecard } from './schemas.js';

/**
 * Councillor performance scorecards (PRD-growth FR-S).
 *
 * A member rates THEIR OWN ward councillor every calendar month across five fixed
 * categories (1–5). A score of 1 or 2 is a complaint, so it must carry a reason of
 * at least {@link MIN_REASON_WORDS} words explaining what is wrong and how to
 * improve; 3–5 need no reason. The councillor sees the reasons aggregated by
 * category, acknowledges them, and the member is notified.
 *
 * PRIVACY INVARIANT (mirrors the recruitment module, AC-O2). Identity is NEVER
 * returned as a sealed name. A scorecard is attributed to `member_id` internally
 * (abuse control, the one-per-month uniqueness), but the councillor/staff inbox
 * reveals the member only as their PUBLIC CODE and only when the member opted into
 * `shareName` (FR-S7); otherwise the row is anonymous. The reasons — not the
 * author — are the actionable content the councillor sees.
 *
 * SCOPING mirrors `auth/scope.ts`. A member reaches only their OWN scorecards;
 * staff reach their ward/region; national reaches everything. Every read is
 * filtered through `visibleWardCodes`, and each view/acknowledge re-checks the
 * single row with `principalSeesWard` before it mutates.
 *
 * ROLLUPS (FR-S8) are computed LIVE by aggregation over the two scorecard tables
 * rather than from a materialised `scorecard_rollup` — the same call Phase A made
 * for the recruitment report (migration 019 walked the tree live). At party scale
 * an indexed aggregate is well inside the 200 ms budget and can never drift from
 * the source rows; a materialised rollup can be layered on later without touching
 * this contract.
 */

/** FR-S3: the compulsory reason length for a score of 1 or 2. */
const MIN_REASON_WORDS = 100;

// ── Small helpers (same shapes the recruitment/jobs modules use) ──────────

/** Read a feature flag; unknown keys fall back to `fallback`. */
async function isFlagEnabled(key: string, fallback: boolean, run = query): Promise<boolean> {
  const res = await run<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE key = $1`,
    [key],
  );
  const row = res.rows[0];
  return row ? row.enabled : fallback;
}

/** Build a typed ApiError so the central handler maps it to the right status. */
function httpError(status: number, message: string): ApiError {
  switch (status) {
    case 400: return ApiError.badRequest(message);
    case 403: return ApiError.forbidden(message);
    case 404: return ApiError.notFound(message);
    case 409: return ApiError.conflict(message);
    default: return new ApiError(status, 'error', message);
  }
}

/** Word count on the trimmed reason — the FR-S3 measure (whitespace-delimited). */
function wordCount(text: string | null | undefined): number {
  const t = (text ?? '').trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

/** A member's public, scope-relevant fields — no PII. */
interface MemberRef {
  memberId: string;
  publicCode: string | null;
  ward: string | null;
  regionCode: string | null;
}

/**
 * The member row linked to this account. Prefers the explicit `users.member_id`
 * link set at onboarding (FR-P1); falls back to the legacy `created_by` guess for
 * accounts provisioned before Phase B. Returns `null` when the account has no
 * member row (an analyst, or an admin who is not themselves a registered member).
 */
async function memberForPrincipal(p: Principal): Promise<MemberRef | null> {
  const res = await query<{
    id: string; public_code: string | null; ward: string | null; region_code: string | null;
  }>(
    `SELECT m.id, m.public_code, m.ward, m.region_code
       FROM members m
      WHERE m.deleted_at IS NULL
        AND m.id = COALESCE(
          (SELECT u.member_id FROM users u WHERE u.id = $1),
          (SELECT m2.id FROM members m2 WHERE m2.created_by = $1 AND m2.deleted_at IS NULL LIMIT 1)
        )
      LIMIT 1`,
    [p.sub],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    memberId: row.id,
    publicCode: row.public_code,
    ward: row.ward ?? p.wardCode ?? null,
    regionCode: row.region_code,
  };
}

/** First day of the current calendar month, `'YYYY-MM-01'`, on the DB clock. */
async function currentPeriod(run = query): Promise<string> {
  const res = await run<{ period: string }>(
    `SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') AS period`,
  );
  return res.rows[0]!.period;
}

/** A `YYYY-MM` filter → the `YYYY-MM-01` DATE literal; omitted ⇒ current month. */
async function resolvePeriod(period?: string, run = query): Promise<string> {
  return period ? `${period}-01` : currentPeriod(run);
}

/** `'ward' | 'region' | 'national'` — the caller's territory, for the response. */
function scopeLabel(p: Principal): 'ward' | 'region' | 'national' {
  return isNationalScope(p) ? 'national' : p.wardCode ? 'ward' : 'region';
}

// ── Category taxonomy (FR-S1) ──────────────────────────────────────────────

export interface CategoryConfig {
  code: string;
  label: string;
  position: number;
}

/** The active categories, national-owned, in display order. */
async function activeCategories(): Promise<CategoryConfig[]> {
  const res = await query<{ code: string; label: string; position: number }>(
    `SELECT code::text AS code, label, position
       FROM rating_category_config WHERE is_active ORDER BY position, code`,
  );
  return res.rows.map((r) => ({ code: r.code, label: r.label, position: Number(r.position) }));
}

function labelFor(categories: CategoryConfig[], code: string): string {
  return categories.find((c) => c.code === code)?.label ?? code;
}

/** FR-S1: the active category taxonomy (labels + order) for the CRM editor. */
export async function categories(): Promise<{ categories: CategoryConfig[] }> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  return { categories: await activeCategories() };
}

// ── Eligibility (FR-S5) ────────────────────────────────────────────────────

export type IneligibleReason = 'no_member' | 'no_ward' | 'vacant_seat' | 'self';

export interface CouncillorRef {
  memberId: string;
  fullName: string;
  photoId: string | null;
}

interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  /**
   * Wording for the card. Usually `INELIGIBLE_MESSAGE[reason]`, but one reason
   * covers two different situations that must not share a sentence — see the
   * `vacant_seat` branch of `eligibility`.
   */
  message: string | null;
  member: MemberRef | null;
  ward: string | null;
  councillor: CouncillorRef | null;
}

/**
 * A member may rate only when they have a member row, that row has a ward, the
 * ward has an ACTIVE councillor, and the councillor is not the member themselves
 * (FR-S5). Staff never reach this — the write route is gated on
 * `rating:scorecard_write`, which only the `member` role holds.
 */
async function eligibility(p: Principal): Promise<Eligibility> {
  const member = await memberForPrincipal(p);
  if (!member) return { eligible: false, reason: 'no_member', message: null, member: null, ward: null, councillor: null };
  const ward = member.ward;
  if (!ward) return { eligible: false, reason: 'no_ward', message: null, member, ward: null, councillor: null };
  const c = await councillorForWard(ward);
  if (!c || !c.memberId) {
    // "No active councillor right now" only holds for a seat that has been
    // vacant since the election. In a ward UDF never stood anyone in there is no
    // councillor coming to inherit a seat, and the card has to say that instead
    // of inviting the member to wait. Same reason code (the UI needs no new
    // state), different sentence.
    const contested = await councillorWasFielded(ward);
    return {
      eligible: false,
      reason: 'vacant_seat',
      message: contested
        ? INELIGIBLE_MESSAGE.vacant_seat
        : 'UDF has no ward councillor in this ward — no UDF candidate was fielded here at the 2026 local elections',
      member,
      ward,
      councillor: null,
    };
  }
  const councillor = { memberId: c.memberId, fullName: c.fullName, photoId: c.photoId };
  if (c.memberId === member.memberId) {
    return { eligible: false, reason: 'self', message: null, member, ward, councillor };
  }
  return { eligible: true, reason: null, message: null, member, ward, councillor };
}

const INELIGIBLE_MESSAGE: Record<IneligibleReason, string> = {
  no_member: 'No member profile is linked to this account',
  no_ward: 'Your membership has no ward yet, so there is no councillor to rate',
  vacant_seat: 'Your ward has no active councillor to rate right now',
  self: 'You cannot rate yourself',
};

// ── Scorecard views ────────────────────────────────────────────────────────

export interface ScorecardItemView {
  category: string;
  score: number;
  reason: string | null;
}

export interface ScorecardView {
  id: string;
  /** `'YYYY-MM-01'` — the calendar month this scorecard covers. */
  period: string;
  status: string;
  wardCode: string;
  councillorMemberId: string | null;
  shareName: boolean;
  ackNote: string | null;
  ackAt: string | null;
  viewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: ScorecardItemView[];
}

interface ScorecardRow {
  id: string; period: string; status: string; ward_code: string;
  councillor_member_id: string | null; share_name: boolean;
  ack_note: string | null; ack_at: string | null; viewed_at: string | null;
  created_at: string; updated_at: string;
}

const SCORECARD_COLS = `id, to_char(period_month, 'YYYY-MM-DD') AS period, status, ward_code,
  councillor_member_id, share_name, ack_note, ack_at::text, viewed_at::text,
  created_at::text, updated_at::text`;

function toView(r: ScorecardRow, items: ScorecardItemView[]): ScorecardView {
  return {
    id: r.id,
    period: r.period,
    status: r.status,
    wardCode: r.ward_code,
    councillorMemberId: r.councillor_member_id,
    shareName: r.share_name,
    ackNote: r.ack_note,
    ackAt: r.ack_at,
    viewedAt: r.viewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    items,
  };
}

interface ItemRow { scorecard_id: string; category: string; score: number; reason: string | null; }

async function itemsForScorecards(ids: string[], run = query): Promise<Map<string, ScorecardItemView[]>> {
  const out = new Map<string, ScorecardItemView[]>();
  if (ids.length === 0) return out;
  const res = await run<ItemRow>(
    `SELECT scorecard_id, category::text AS category, score, reason
       FROM councillor_scorecard_items
      WHERE scorecard_id = ANY($1::uuid[])
      ORDER BY scorecard_id, category`,
    [ids],
  );
  for (const r of res.rows) {
    const arr = out.get(r.scorecard_id) ?? [];
    arr.push({ category: r.category, score: Number(r.score), reason: r.reason });
    out.set(r.scorecard_id, arr);
  }
  return out;
}

async function loadScorecardWithItems(id: string): Promise<ScorecardView | null> {
  const res = await query<ScorecardRow>(
    `SELECT ${SCORECARD_COLS} FROM councillor_scorecards WHERE id = $1`,
    [id],
  );
  const r = res.rows[0];
  if (!r) return null;
  const items = await itemsForScorecards([r.id]);
  return toView(r, items.get(r.id) ?? []);
}

async function scorecardForMemberPeriod(memberId: string, period: string): Promise<ScorecardView | null> {
  const res = await query<ScorecardRow>(
    `SELECT ${SCORECARD_COLS} FROM councillor_scorecards
      WHERE member_id = $1 AND period_month = $2::date`,
    [memberId, period],
  );
  const r = res.rows[0];
  if (!r) return null;
  const items = await itemsForScorecards([r.id]);
  return toView(r, items.get(r.id) ?? []);
}

// ── FR-S4: the member's current-month card ─────────────────────────────────

export interface CurrentView {
  eligible: boolean;
  reason: IneligibleReason | null;
  /** Human-readable cause when ineligible, so the card can explain the vacancy. */
  message: string | null;
  ward: string | null;
  councillor: CouncillorRef | null;
  period: string;
  status: 'not_rated' | 'submitted' | 'viewed' | 'acknowledged';
  scorecardId: string | null;
  /** True once acknowledged — the month's card is frozen (FR-S2). */
  frozen: boolean;
  ackNote: string | null;
  /** FR-S7: the member's saved opt-in, so a re-edit within the month keeps it. */
  shareName: boolean;
  categories: CategoryConfig[];
  items: ScorecardItemView[];
}

export async function getCurrent(p: Principal): Promise<CurrentView> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  const [period, cats] = await Promise.all([currentPeriod(), activeCategories()]);
  const el = await eligibility(p);
  if (!el.eligible) {
    return {
      eligible: false,
      reason: el.reason,
      message: el.message ?? (el.reason ? INELIGIBLE_MESSAGE[el.reason] : null),
      ward: el.ward,
      councillor: el.councillor,
      period,
      status: 'not_rated',
      scorecardId: null,
      frozen: false,
      ackNote: null,
      shareName: false,
      categories: cats,
      items: [],
    };
  }
  const existing = await scorecardForMemberPeriod(el.member!.memberId, period);
  return {
    eligible: true,
    reason: null,
    message: null,
    ward: el.ward,
    councillor: el.councillor,
    period,
    status: (existing?.status as CurrentView['status']) ?? 'not_rated',
    scorecardId: existing?.id ?? null,
    frozen: existing?.status === 'acknowledged',
    ackNote: existing?.ackNote ?? null,
    shareName: existing?.shareName ?? false,
    categories: cats,
    items: existing?.items ?? [],
  };
}

// ── FR-S2/S3: submit or update this month's scorecard ──────────────────────

export async function submit(p: Principal, body: SubmitScorecard): Promise<ScorecardView> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  // Defence in depth: the route already gates on the member-only write permission.
  if (p.role !== Role.MEMBER) {
    throw httpError(403, 'Only a member can submit a councillor scorecard');
  }
  const el = await eligibility(p);
  if (!el.eligible || !el.member || !el.ward || !el.councillor) {
    throw httpError(403, el.message ?? INELIGIBLE_MESSAGE[el.reason ?? 'no_member']);
  }
  const { member, ward, councillor } = el;
  const [period, cats] = await Promise.all([currentPeriod(), activeCategories()]);

  // FR-S1: a complete card rates every ACTIVE category exactly once.
  const activeCodes = new Set(cats.map((c) => c.code));
  const seen = new Set<string>();
  for (const it of body.items) {
    if (!activeCodes.has(it.category)) throw httpError(400, `Unknown or retired category: ${it.category}`);
    if (seen.has(it.category)) throw httpError(400, `Duplicate category: ${it.category}`);
    seen.add(it.category);
  }
  const missing = [...activeCodes].filter((c) => !seen.has(c));
  if (missing.length > 0) {
    throw httpError(400, `Rate every category before submitting (missing: ${missing.map((c) => labelFor(cats, c)).join(', ')})`);
  }

  // FR-S3: a score of 1 or 2 is a complaint — it must carry ≥100 words.
  for (const it of body.items) {
    if (it.score <= 2) {
      const words = wordCount(it.reason);
      if (words < MIN_REASON_WORDS) {
        throw httpError(400,
          `${labelFor(cats, it.category)}: a score of ${it.score} needs a reason of at least ` +
          `${MIN_REASON_WORDS} words explaining what is wrong and how to improve (you wrote ${words}).`);
      }
    }
  }

  // FR-S2: frozen once acknowledged.
  const existing = await scorecardForMemberPeriod(member.memberId, period);
  if (existing && existing.status === 'acknowledged') {
    throw httpError(409, "This month's scorecard has been acknowledged and can no longer be edited");
  }

  const id = await withTransaction(async (client) => {
    const up = await client.query<{ id: string }>(
      `INSERT INTO councillor_scorecards
         (member_id, councillor_member_id, ward_code, period_month, status, share_name)
       VALUES ($1, $2, $3, $4::date, 'submitted', $5)
       ON CONFLICT (member_id, period_month) DO UPDATE
         SET councillor_member_id = EXCLUDED.councillor_member_id,
             ward_code            = EXCLUDED.ward_code,
             share_name           = EXCLUDED.share_name,
             status               = 'submitted',
             viewed_at            = NULL,
             updated_at           = now()
       RETURNING id`,
      [member.memberId, councillor.memberId, ward, period, body.shareName],
    );
    const scorecardId = up.rows[0]!.id;
    await client.query(`DELETE FROM councillor_scorecard_items WHERE scorecard_id = $1`, [scorecardId]);
    for (const it of body.items) {
      const reason = it.score <= 2 ? (it.reason ?? '').trim() : (it.reason?.trim() || null);
      await client.query(
        `INSERT INTO councillor_scorecard_items (scorecard_id, category, score, reason)
         VALUES ($1, $2::rating_category, $3, $4)`,
        [scorecardId, it.category, it.score, reason],
      );
    }
    return scorecardId;
  });

  // Best-effort: let the councillor know fresh feedback landed in their ward.
  await notifyCouncillor(councillor.memberId, ward);

  return (await loadScorecardWithItems(id))!;
}

// ── FR-S2: the member's own history ────────────────────────────────────────

export async function history(p: Principal, q: HistoryQuery): Promise<{ scorecards: ScorecardView[] }> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  const member = await memberForPrincipal(p);
  if (!member) throw httpError(403, 'No member profile is linked to this account');
  const res = await query<ScorecardRow>(
    `SELECT ${SCORECARD_COLS} FROM councillor_scorecards
      WHERE member_id = $1 ORDER BY period_month DESC LIMIT $2`,
    [member.memberId, q.limit],
  );
  const items = await itemsForScorecards(res.rows.map((r) => r.id));
  return { scorecards: res.rows.map((r) => toView(r, items.get(r.id) ?? [])) };
}

// ── Ward scoping for the staff/CRM read surfaces ───────────────────────────

/**
 * The wards a read surface may span: `null` ⇒ national (no filter). An explicit
 * `ward` filter must sit inside the caller's scope or it is a 403 (a ward
 * councillor cannot peek at a neighbouring ward by naming it).
 */
async function scopedWards(p: Principal, wardFilter: string | undefined, run: typeof query): Promise<string[] | null> {
  const scope = await wardCodeScope(p, 'r.code', 1);
  const wards = isNationalScope(p) ? null : p.wardCode ? [p.wardCode] :
    (await run<{ code: string }>(`SELECT r.code FROM regions r WHERE r.level = 'ward'${scope.sql}`, scope.params)).rows.map((r) => r.code);
  if (wardFilter) {
    if (wards !== null && !wards.includes(wardFilter)) throw httpError(403, 'Ward outside your scope');
    return [wardFilter];
  }
  return wards;
}

/** A `ward_code = ANY(...)` fragment on alias `s`; empty for national scope. */
const ROLLUP_WHERE = `s.period_month = $1::date
  AND ($2::text[] IS NULL OR s.ward_code = ANY($2::text[]))
  AND ($3::text IS NULL OR s.status = $3)`;

interface RollupMeta {
  period: string;
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  statusFilter: RollupQuery['status'] | null;
  asOf: string;
}

function readRollup<T>(p: Principal, input: RollupQuery,
  read: (run: typeof query, q: RollupQuery, meta: RollupMeta, params: unknown[]) => Promise<T>): Promise<T> {
  const q = rollupQuery.parse(input);
  return withReadSnapshot(async (run) => {
    if (!(await isFlagEnabled('rating.scorecard', true, run))) {
      throw httpError(403, 'Councillor scorecards are currently disabled');
    }
    const period = await resolvePeriod(q.period, run);
    const wards = await scopedWards(p, q.ward, run);
    const { rows: [clock] } = await run<{ as_of: Date }>('SELECT now() AS as_of');
    return read(run, q, { period, scope: scopeLabel(p), wardFilter: q.ward ?? null,
      statusFilter: q.status ?? null, asOf: clock!.as_of.toISOString() }, [period, wards, q.status ?? null]);
  });
}

// ── FR-S6/S7: the councillor/staff acknowledgement inbox ───────────────────

export interface InboxRow {
  id: string;
  period: string;
  status: string;
  wardCode: string;
  wardName: string | null;
  councillorMemberId: string | null;
  /** FR-S7: the member's public code, revealed ONLY when they opted in. */
  shareName: boolean;
  memberPublicCode: string | null;
  submittedAt: string;
  viewedAt: string | null;
  ackAt: string | null;
  ackNote: string | null;
  average: number | null;
  /** Count of categories scored ≤2 (the actionable complaints on this card). */
  lowCount: number;
  items: ScorecardItemView[];
}

export interface InboxView extends RollupMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  rows: InboxRow[];
}

export async function inbox(p: Principal, q: RollupQuery): Promise<InboxView> {
  return readRollup(p, q, async (run, filter, meta, params) => {
    const count = await run<{ total: number }>(
      `SELECT count(*)::int AS total FROM councillor_scorecards s WHERE ${ROLLUP_WHERE}`, params);
    const res = await run<{
      id: string; period: string; status: string; ward_code: string; ward_name: string | null;
      councillor_member_id: string | null; share_name: boolean; member_public_code: string | null;
      submitted_at: string; viewed_at: string | null; ack_at: string | null; ack_note: string | null;
      average: number | null; low_count: number;
    }>(
      `SELECT s.id, to_char(s.period_month, 'YYYY-MM-DD') AS period, s.status, s.ward_code,
              r.name AS ward_name, s.councillor_member_id, s.share_name,
              CASE WHEN s.share_name THEN m.public_code END AS member_public_code,
              s.created_at::text AS submitted_at, s.viewed_at::text, s.ack_at::text, s.ack_note,
              (SELECT round(avg(i.score), 2)::float8 FROM councillor_scorecard_items i WHERE i.scorecard_id = s.id) AS average,
              (SELECT count(*)::int FROM councillor_scorecard_items i WHERE i.scorecard_id = s.id AND i.score <= 2) AS low_count
         FROM councillor_scorecards s
         LEFT JOIN regions r ON r.code = s.ward_code
         LEFT JOIN members m ON m.id = s.member_id
        WHERE ${ROLLUP_WHERE}
        ORDER BY s.created_at DESC, s.id
        LIMIT $4 OFFSET $5`, [...params, filter.limit, filter.offset]);
    const items = await itemsForScorecards(res.rows.map((r) => r.id), run);
    const rows: InboxRow[] = res.rows.map((r) => ({
      id: r.id, period: r.period, status: r.status, wardCode: r.ward_code, wardName: r.ward_name,
      councillorMemberId: r.councillor_member_id, shareName: r.share_name,
      // FR-S7: identity (here, the public code) only when the member opted in.
      memberPublicCode: r.share_name ? r.member_public_code : null,
      submittedAt: r.submitted_at, viewedAt: r.viewed_at, ackAt: r.ack_at, ackNote: r.ack_note,
      average: r.average, lowCount: r.low_count, items: items.get(r.id) ?? [],
    }));
    const total = count.rows[0]!.total;
    return { ...meta, total, limit: filter.limit, offset: filter.offset,
      hasMore: filter.offset + rows.length < total, rows };
  });
}

// ── FR-S8: category rollups ────────────────────────────────────────────────

export interface CategorySummary {
  category: string;
  label: string;
  position: number;
  active: boolean;
  count: number;
  average: number | null;
  /** Score histogram, keys `'1'`..`'5'`. */
  distribution: Record<string, number>;
  lowCount: number;
}

export interface SummaryView extends RollupMeta {
  scorecards: number;
  itemCount: number;
  lowScoreItems: number;
  lowScorecards: number;
  awaitingAcknowledgement: number;
  overallAverage: number | null;
  categories: CategorySummary[];
}

export async function summary(p: Principal, q: RollupQuery): Promise<SummaryView> {
  return readRollup(p, q, async (run, _filter, meta, params) => {
    const { rows: [totals] } = await run<Omit<SummaryView, keyof RollupMeta | 'categories'>>(
      `WITH cards AS (SELECT s.id, s.status FROM councillor_scorecards s WHERE ${ROLLUP_WHERE}),
       items AS (SELECT i.* FROM councillor_scorecard_items i JOIN cards c ON c.id = i.scorecard_id)
       SELECT (SELECT count(*)::int FROM cards) AS scorecards,
         count(*)::int AS "itemCount", count(*) FILTER (WHERE score <= 2)::int AS "lowScoreItems",
         count(DISTINCT scorecard_id) FILTER (WHERE score <= 2)::int AS "lowScorecards",
         (SELECT count(*)::int FROM cards WHERE status IN ('submitted','viewed')) AS "awaitingAcknowledgement",
         round(avg(score), 2)::float8 AS "overallAverage" FROM items`, params);
    const catRes = await run<CategorySummary>(
      `WITH items AS (
         SELECT i.* FROM councillor_scorecard_items i JOIN councillor_scorecards s ON s.id = i.scorecard_id
         WHERE ${ROLLUP_WHERE}
       ), scores AS (
         SELECT category, count(*)::int AS count, round(avg(score), 2)::float8 AS average,
           count(*) FILTER (WHERE score <= 2)::int AS "lowCount",
           json_build_object('1', count(*) FILTER (WHERE score=1), '2', count(*) FILTER (WHERE score=2),
             '3', count(*) FILTER (WHERE score=3), '4', count(*) FILTER (WHERE score=4),
             '5', count(*) FILTER (WHERE score=5)) AS distribution
         FROM items GROUP BY category
       ) SELECT COALESCE(c.code, s.category)::text AS category,
           COALESCE(c.label, s.category::text) AS label, COALESCE(c.position, 2147483647) AS position,
           COALESCE(c.is_active, false) AS active, COALESCE(s.count, 0) AS count, s.average,
           COALESCE(s."lowCount", 0) AS "lowCount",
           COALESCE(s.distribution, '{"1":0,"2":0,"3":0,"4":0,"5":0}'::json) AS distribution
         FROM rating_category_config c FULL JOIN scores s ON s.category = c.code
         WHERE c.is_active OR s.category IS NOT NULL ORDER BY position, category`, params);
    return { ...meta, ...totals!, categories: catRes.rows };
  });
}

// ── FR-S8: the ≤2 reasons queue ────────────────────────────────────────────

export interface LowReasonRow {
  scorecardId: string;
  category: string;
  label: string;
  score: number;
  reason: string | null;
  wardCode: string;
  wardName: string | null;
  period: string;
  status: string;
  shareName: boolean;
  memberPublicCode: string | null;
}

export interface LowReasonsView extends RollupMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  rows: LowReasonRow[];
}

export async function lowReasons(p: Principal, q: RollupQuery): Promise<LowReasonsView> {
  return readRollup(p, q, async (run, filter, meta, params) => {
    const count = await run<{ total: number }>(
      `SELECT count(*)::int AS total FROM councillor_scorecard_items i
       JOIN councillor_scorecards s ON s.id = i.scorecard_id
       WHERE i.score <= 2 AND ${ROLLUP_WHERE}`, params);
    const res = await run<LowReasonRow>(
      `SELECT s.id AS "scorecardId", i.category::text AS category,
         COALESCE(c.label, i.category::text) AS label, i.score, i.reason,
         s.ward_code AS "wardCode", r.name AS "wardName",
         to_char(s.period_month, 'YYYY-MM-DD') AS period, s.status, s.share_name AS "shareName",
         CASE WHEN s.share_name THEN m.public_code END AS "memberPublicCode"
       FROM councillor_scorecard_items i
       JOIN councillor_scorecards s ON s.id = i.scorecard_id
       LEFT JOIN rating_category_config c ON c.code = i.category
       LEFT JOIN regions r ON r.code = s.ward_code
       LEFT JOIN members m ON m.id = s.member_id
       WHERE i.score <= 2 AND ${ROLLUP_WHERE}
       ORDER BY i.score ASC, s.created_at DESC, s.id, i.category
       LIMIT $4 OFFSET $5`, [...params, filter.limit, filter.offset]);
    const total = count.rows[0]!.total;
    return { ...meta, total, limit: filter.limit, offset: filter.offset,
      hasMore: filter.offset + res.rows.length < total, rows: res.rows };
  });
}

// ── FR-S6: view + acknowledge transitions ──────────────────────────────────

/** Opening a submitted scorecard marks it `viewed` (idempotent thereafter). */
export async function view(p: Principal, id: string): Promise<ScorecardView> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  const meta = await query<{ status: string; ward_code: string }>(
    `SELECT status, ward_code FROM councillor_scorecards WHERE id = $1`,
    [id],
  );
  const row = meta.rows[0];
  if (!row) throw httpError(404, 'No scorecard matches that id');
  if (!(await principalSeesWard(p, row.ward_code))) throw httpError(403, 'That scorecard is outside your scope');
  if (row.status === 'submitted') {
    await query(
      `UPDATE councillor_scorecards
          SET status = 'viewed', viewed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'submitted'`,
      [id],
    );
  }
  return (await loadScorecardWithItems(id))!;
}

/**
 * Acknowledge a scorecard (→ `acknowledged`) with an optional note, and notify
 * the member that their feedback was received and reviewed (FR-S6). Freezes the
 * month's card against further edits.
 */
export async function acknowledge(p: Principal, id: string, body: AcknowledgeBody): Promise<ScorecardView> {
  if (!(await isFlagEnabled('rating.scorecard', true))) {
    throw httpError(403, 'Councillor scorecards are currently disabled');
  }
  const meta = await query<{ status: string; ward_code: string; member_id: string }>(
    `SELECT status, ward_code, member_id FROM councillor_scorecards WHERE id = $1`,
    [id],
  );
  const row = meta.rows[0];
  if (!row) throw httpError(404, 'No scorecard matches that id');
  if (!(await principalSeesWard(p, row.ward_code))) throw httpError(403, 'That scorecard is outside your scope');
  if (row.status === 'acknowledged') throw httpError(409, 'That scorecard has already been acknowledged');

  const note = body.note?.trim() || null;
  await query(
    `UPDATE councillor_scorecards
        SET status = 'acknowledged', ack_note = $2, ack_by = $3, ack_at = now(),
            viewed_at = COALESCE(viewed_at, now()), updated_at = now()
      WHERE id = $1`,
    [id, note, p.sub],
  );

  await notifyMember(row.member_id, row.ward_code, note);
  return (await loadScorecardWithItems(id))!;
}

// ── Best-effort notifications (never throw — `notify` swallows failures) ───

/** Resolve a member's login account id (migration 020 link), or null. */
async function userIdForMember(memberId: string): Promise<string | null> {
  const res = await query<{ id: string }>(
    `SELECT id FROM users WHERE member_id = $1 LIMIT 1`,
    [memberId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Ping the councillor that new feedback landed. Skipped when the councillor has
 * no login account — `notify` with a null user would BROADCAST to everyone, which
 * is exactly wrong for a single-ward event, so we simply do not send.
 */
async function notifyCouncillor(councillorMemberId: string, ward: string): Promise<void> {
  const userId = await userIdForMember(councillorMemberId);
  if (!userId) return;
  await notify({
    kind: 'rating',
    title: 'New councillor scorecard',
    body: 'A member in your ward submitted a monthly scorecard. Open Scorecards to review and acknowledge it.',
    // The acknowledgement workflow lives in the desktop CRM (ward_councillor is a
    // desktop role); a `/…` path is what its notifications panel follows.
    link: '/crm/scorecards',
    regionCode: ward,
    userId,
  });
}

/** FR-S6: tell the member their feedback was received and reviewed. */
async function notifyMember(memberId: string, ward: string, note: string | null): Promise<void> {
  const userId = await userIdForMember(memberId);
  if (!userId) return;
  await notify({
    kind: 'rating',
    title: 'Your feedback was reviewed',
    body: note
      ? `Ward acknowledgement: ${note}`
      : 'Your councillor scorecard was received and reviewed. Thank you for holding your ward accountable.',
    link: 'tab:home#scorecard',
    regionCode: ward,
    userId,
  });
}
