import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';
import { sealRecord } from '../security/encryption.js';
import {
  MP_WARDS,
  CONTROL_WARD,
  OUTSIDE_WARDS,
  PRIMARY_WARD as W079,
  MP_LABEL,
  TEST_USERS,
  RESIDENTS,
  VALIDATION_PASSWORD,
  ensureWardNaming,
  ensureUsers,
  ensureMembers,
  ensureCouncillorIdentity,
  linkMemberAccounts,
  writePiiCorpus,
  userByEmail,
  markerExists,
  rowExists,
} from './seedValidationCore.js';

/**
 * Validation-campaign business fixtures (Phase 4 of the validation plan).
 *
 * Builds the record spread the role/POPIA audit needs in order to be
 * MEASURABLE rather than merely plausible:
 *
 *   - cases across every status, including a `private` one, an SLA breach and a
 *     merged duplicate, so dashboards, escalations and the public overview each
 *     have something real to count;
 *   - records in the ADJACENT control ward (CPT-W043) and in OTHER metro areas
 *     (CPT-W009 / CPT-W025). A ward-scoped principal that returns these is
 *     failing, which is exactly what the scope scanner asserts.
 *
 * Idempotent: each section is guarded by a `[MP-VAL]` marker and skipped when
 * already present. Run with: npm run seed:validation
 */

const W078 = MP_WARDS[1]!;
const W075 = MP_WARDS[2]!;
const W116 = MP_WARDS[3]!;
const OUT9 = OUTSIDE_WARDS[0]!;

type Ward = { code: string; num: string; parent: string; area: string; lat: number; lng: number };

interface Ctx {
  users: Record<string, string>;
  members: Record<string, string>;
}

/** Insert helper returning the new id. */
async function ins(sql: string, params: unknown[]): Promise<string> {
  const res = await query<{ id: string }>(sql, params);
  return res.rows[0]!.id;
}

/** Inline geography literal (fixtures use fixed, non-user-supplied coordinates). */
const point = (lat: number, lng: number) => `ST_SetSRID(ST_MakePoint(${lng},${lat}),4326)::geography`;

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Service requests — every status, both visibilities, an SLA breach, a merge
// ─────────────────────────────────────────────────────────────────────────────

interface CaseSeed {
  ref: string;
  ward: Ward;
  cat: string;
  sev: string;
  title: string;
  desc: string;
  status: string;
  visibility: string;
  reporter: string;
  slaDays: number | null;
  /** Set on the case this one was merged into. */
  mergeIntoRef?: string;
}

const CASES: CaseSeed[] = [
  { ref: 'SR-MP-0001', ward: W079, cat: 'water', sev: 'urgent', title: '[MP-VAL] Water main burst on Spine Road', desc: 'Major burst in front of the Town Centre; road flooded and supply down for three blocks.', status: 'in_progress', visibility: 'members', reporter: 'r1', slaDays: 3 },
  { ref: 'SR-MP-0002', ward: W079, cat: 'power', sev: 'report', title: '[MP-VAL] Street lights out along Westgate Drive', desc: 'Nine consecutive poles dark since the storm; pedestrians walking in the roadway.', status: 'reported', visibility: 'members', reporter: 'r2', slaDays: 12 },
  { ref: 'SR-MP-0003', ward: W079, cat: 'sanitation', sev: 'urgent', title: '[MP-VAL] Blocked sewer overflow in Eastridge', desc: 'Raw sewage overflowing into the stormwater channel for six days. SLA already breached.', status: 'escalated', visibility: 'members', reporter: 'r3', slaDays: -4 },
  { ref: 'SR-MP-0004', ward: W079, cat: 'roads', sev: 'report', title: '[MP-VAL] Potholes on Rocklands Avenue', desc: 'Cluster of potholes near the school crossing; repaired and independently verified.', status: 'verified', visibility: 'members', reporter: 'r4', slaDays: -20 },
  { ref: 'SR-MP-0005', ward: W079, cat: 'safety', sev: 'report', title: '[MP-VAL] Illegal dumping site near Town Centre', desc: 'Dumping on the vacant erf behind the taxi rank; cleared and closed.', status: 'closed', visibility: 'members', reporter: 'r6', slaDays: -35 },
  { ref: 'SR-MP-0006', ward: W078, cat: 'water', sev: 'report', title: '[MP-VAL] Low water pressure in Westridge', desc: 'Pressure drops every evening between 18:00 and 21:00.', status: 'submitted', visibility: 'members', reporter: 'r7', slaDays: 9 },
  { ref: 'SR-MP-0007', ward: W075, cat: 'power', sev: 'urgent', title: '[MP-VAL] Transformer fault in Rocklands', desc: 'Repeated tripping; 40 households affected. Overdue on SLA.', status: 'in_progress', visibility: 'members', reporter: 'r9', slaDays: -9 },
  { ref: 'SR-MP-0008', ward: W116, cat: 'roads', sev: 'report', title: '[MP-VAL] Gravel road needs grading in Woodlands', desc: 'Corrugated for roughly 800 m; impassable in wet weather.', status: 'logged', visibility: 'members', reporter: 'r11', slaDays: 20 },
  { ref: 'SR-MP-0009', ward: W079, cat: 'housing', sev: 'report', title: '[MP-VAL] Overcrowded backyard dwelling (private)', desc: 'Sensitive household matter — private visibility, excluded from public counts.', status: 'triaged', visibility: 'private', reporter: 'r2', slaDays: 15 },
  { ref: 'SR-MP-0010', ward: W079, cat: 'water', sev: 'report', title: '[MP-VAL] Duplicate of the Spine Road burst', desc: 'Second report of the same burst; merged into SR-MP-0001.', status: 'duplicate', visibility: 'members', reporter: 'r4', slaDays: null, mergeIntoRef: 'SR-MP-0001' },
  // ── Scope controls: must NOT appear for a W079-scoped or MP-regional principal ──
  { ref: 'SR-MP-0011', ward: CONTROL_WARD, cat: 'sanitation', sev: 'report', title: '[MP-VAL] Open drainage channel in Lentegeur', desc: 'Control record in the adjacent ward CPT-W043.', status: 'reported', visibility: 'members', reporter: 'c1', slaDays: 10 },
  { ref: 'SR-MP-0012', ward: OUT9, cat: 'water', sev: 'report', title: '[MP-VAL] Burst pipe in Table View', desc: 'Control record outside Mitchell\'s Plain (CPT-W009).', status: 'reported', visibility: 'members', reporter: 'o1', slaDays: 6 },
];

async function ensureServiceRequests(ctx: Ctx): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  if (await markerExists('service_requests', 'title')) {
    const found = await query<{ id: string; ref_no: string }>(`SELECT id, ref_no FROM service_requests WHERE ref_no LIKE 'SR-MP-%'`);
    for (const r of found.rows) ids[r.ref_no] = r.id;
    logger.info({ cases: found.rows.length }, 'Service requests already seeded — reusing');
    return ids;
  }

  const councillorMember = ctx.members['r5'] ?? null;
  for (const c of CASES) {
    const reporterMemberId = ctx.members[c.reporter] ?? null;
    const id = await ins(
      `INSERT INTO service_requests
         (ref_no, category, severity, title, description, status, visibility, ward_code,
          reporter_member_id, councillor_member_id, location, street_address,
          sla_due_at, resolved_at, verified_at, closed_at, created_by, report_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${point(c.ward.lat, c.ward.lng)},$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        c.ref, c.cat, c.sev, c.title, c.desc, c.status, c.visibility, c.ward.code,
        reporterMemberId, councillorMember, `${Math.round(10 + Math.random() * 80)} ${c.ward.area.split(' ')[0]}`,
        c.slaDays === null ? null : daysFromNow(c.slaDays),
        ['resolved', 'verified', 'closed'].includes(c.status) ? daysFromNow(-10) : null,
        ['verified', 'closed'].includes(c.status) ? daysFromNow(-8) : null,
        c.status === 'closed' ? daysFromNow(-7) : null,
        ctx.users['councillor'] ?? null,
        c.mergeIntoRef ? 2 : 1,
      ],
    );
    ids[c.ref] = id;

    // Seal the reporter's contact details exactly as the live flow does, so a
    // leak scanner sees real ciphertext rather than an empty object.
    if (reporterMemberId) {
      const m = await query<{ sealed_pii: unknown }>(`SELECT sealed_pii FROM members WHERE id = $1`, [reporterMemberId]);
      const sealed = await sealRecord(id, { reporterNote: `Follow-up contact for ${c.ref}` });
      await query(`UPDATE service_requests SET reporter_sealed = $2::jsonb WHERE id = $1`, [id, JSON.stringify(sealed)]);
      void m;
    }
  }

  // Wire the merge.
  const dup = ids['SR-MP-0010'];
  const orig = ids['SR-MP-0001'];
  if (dup && orig) await query(`UPDATE service_requests SET merged_into = $2 WHERE id = $1`, [dup, orig]);

  logger.info({ cases: Object.keys(ids).length }, 'Service requests seeded');
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patrols
// ─────────────────────────────────────────────────────────────────────────────

async function ensurePatrols(ctx: Ctx): Promise<void> {
  if (await markerExists('patrols', 'purpose')) return;
  const councillor = ctx.members['r5']!;
  const rows: [Ward, string, string, string, string, number | null][] = [
    [W079, '[MP-VAL] Spine Road litter and drainage walk', 'completed', 'walk', daysFromNow(-12), 3400],
    [W079, '[MP-VAL] Westridge night safety walk', 'completed', 'walk', daysFromNow(-4), 2100],
    [W079, '[MP-VAL] Town Centre market-day oversight', 'planned', 'walk', daysFromNow(6), null],
    [W079, '[MP-VAL] Strandfontein perimeter drive', 'active', 'drive', daysFromNow(0), null],
    [W079, '[MP-VAL] Internal patrol (not member-visible)', 'completed', 'walk', daysFromNow(-2), 1500],
    [CONTROL_WARD, '[MP-VAL] Lentegeur canal inspection (control ward)', 'completed', 'walk', daysFromNow(-6), 2600],
  ];
  for (const [ward, purpose, status, mode, when, dist] of rows) {
    const visibility = purpose.includes('Internal') ? 'private' : 'members';
    const started = status === 'planned' ? null : when;
    const ended = status === 'completed' ? daysFromNow(-11) : null;
    await query(
      `INSERT INTO patrols (councillor_member_id, ward_code, mode, purpose, planned_date, started_at, ended_at, distance_m, summary, status, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        councillor, ward.code, mode, purpose, (when ?? daysFromNow(0)).slice(0, 10),
        started, ended, dist,
        status === 'completed' ? 'Completed without incident; two issues logged as cases.' : null,
        status, visibility,
      ],
    );
  }
  logger.info({ patrols: rows.length }, 'Patrols seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ward bulletins
// ─────────────────────────────────────────────────────────────────────────────

async function ensureBulletins(ctx: Ctx, caseIds: Record<string, string>): Promise<void> {
  const councillor = ctx.members['r5']!;
  const adminUser = ctx.users['admin'] ?? null;

  if (!(await markerExists('ward_bulletins', 'title'))) {
    await query(
      `INSERT INTO ward_bulletins (ward_code, councillor_member_id, kind, title, body, service_request_id, status, published_at, created_by)
       VALUES ($1,$2,'completed_work',$3,$4,$5,'published',now(),$6)`,
      [
        W079.code, councillor,
        '[MP-VAL] Rocklands Avenue resurfacing finished',
        'The pothole repairs on Rocklands Avenue are complete and were independently verified by residents on Saturday. Thank you to everyone who reported and then confirmed the work.',
        caseIds['SR-MP-0004'] ?? null, adminUser,
      ],
    );
    await query(
      `INSERT INTO ward_bulletins (ward_code, councillor_member_id, kind, title, body, status, published_at, created_by)
       VALUES ($1,$2,'news',$3,$4,'published',now(),$5)`,
      [
        W079.code, councillor,
        '[MP-VAL] Ward safety task team — September update',
        'Street lighting repairs on Westgate Drive are scheduled. The task team meets on the last Wednesday of the month at the Town Centre hall, 18:00.',
        adminUser,
      ],
    );
    await query(
      `INSERT INTO ward_bulletins (ward_code, councillor_member_id, kind, title, body, vacancy_type, vacancy_deadline, vacancy_contact, status, published_at, created_by)
       VALUES ($1,$2,'vacancy',$3,$4,'public_participation',$5,$6::jsonb,'published',now(),$7)`,
      [
        W079.code, councillor,
        '[MP-VAL] Call for comment: Spine Road trading layout',
        'The ward invites written comment on the proposed informal-trading layout for Spine Road before the deadline.',
        daysFromNow(21).slice(0, 10),
        JSON.stringify({ email: 'ward79.office@udf.test', phone: '+27215550079' }),
        adminUser,
      ],
    );
    await query(
      `INSERT INTO ward_bulletins (ward_code, councillor_member_id, kind, title, body, status, published_at, created_by)
       VALUES ($1,$2,'announcement',$3,$4,'published',now(),$5)`,
      [CONTROL_WARD.code, councillor, '[MP-VAL] Lentegeur canal cleaning (control ward)', 'Control bulletin in CPT-W043 — must not surface in a W079-scoped feed.', adminUser],
    );
    logger.info('Ward bulletins seeded');
  }

  // DRAFT: `status <> 'published'`. It sits in the primary ward, so territory
  // alone would still return it to the ward's own members — only the publication
  // gate keeps it staff-only. Proves D26 independently of D5.
  //
  // Additively idempotent on its own title: a database seeded before this
  // fixture existed would otherwise never receive it, and the matching scanner
  // token would then pass vacuously.
  const draftTitle = '[MP-VAL] DRAFT water interruption notice (unpublished)';
  if (!(await rowExists('ward_bulletins', 'title', draftTitle))) {
    await query(
      `INSERT INTO ward_bulletins (ward_code, councillor_member_id, kind, title, body, status, created_by)
       VALUES ($1,$2,'news',$3,$4,'draft',$5)`,
      [
        W079.code, councillor,
        draftTitle,
        'Draft notice awaiting confirmation from the City. Must not reach members, analysts or the public site.',
        adminUser,
      ],
    );
    logger.info('Draft ward bulletin seeded');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects + milestones
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectSeed {
  title: string;
  ward: Ward;
  stage: string;
  progress: number;
  budget: number;
  owner: string;
  description: string;
  milestones: [string, string, number][]; // title, status, dueDaysFromNow
  /** Defaults to true. Set false to seed a DRAFT, which only staff in the ward may see. */
  published?: boolean;
}

const PROJECTS: ProjectSeed[] = [
  {
    title: '[MP-VAL] Spine Road informal trading upgrade',
    ward: W079, stage: 'in_progress', progress: 55, budget: 1250000, owner: 'Aisha Adams (Ward 79)',
    description: 'Formalised trading bays, ablution block and stormwater drainage along Spine Road in the Town Centre.',
    milestones: [
      ['Design and engineering sign-off', 'done', -120],
      ['Community consultation completed', 'done', -75],
      ['Construction phase 1 — 12 bays', 'in_progress', 30],
      ['Ablution block and handover', 'pending', 120],
    ],
  },
  {
    title: '[MP-VAL] Westridge street lighting renewal',
    ward: W078, stage: 'approved', progress: 10, budget: 480000, owner: 'Ward 78 committee',
    description: 'Replacement of 140 failed luminaires with LED units across Westridge Avenue and Colorama Crescent.',
    milestones: [
      ['Funding approved', 'done', -30],
      ['Bulk procurement', 'in_progress', 45],
      ['Installation', 'pending', 150],
    ],
  },
  {
    title: '[MP-VAL] Lentegeur canal rehabilitation (control ward)',
    ward: CONTROL_WARD, stage: 'funded', progress: 25, budget: 900000, owner: 'Subcouncil 17',
    description: 'Control project in CPT-W043 — must never appear in a W079-scoped project feed.',
    milestones: [
      ['Site assessment', 'done', -60],
      ['Canal lining', 'in_progress', 90],
    ],
  },
  {
    // DRAFT: proves the publication gate independently of territory. It sits IN
    // the primary ward, so a ward-scoped filter alone would still return it —
    // only the `is_published` gate keeps it away from members, analysts and the
    // public site.
    title: '[MP-VAL] DRAFT Town Centre taxi rank shelter (unpublished)',
    ward: W079, stage: 'concept', progress: 0, budget: 320000, owner: 'Aisha Adams (Ward 79)',
    description: 'Draft concept, not yet approved for publication. Must be invisible to members, analysts and anonymous visitors even though it is in their ward.',
    published: false,
    milestones: [
      ['Concept costed', 'pending', 60],
    ],
  },
];

async function ensureProjects(ctx: Ctx): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  let inserted = 0;
  for (const p of PROJECTS) {
    // Per-row, not per-table: the table-level marker guard would skip the whole
    // section once any project existed, so a fixture added in a later pass never
    // landed and the scanner token for it passed vacuously.
    const existing = await query<{ id: string }>('SELECT id FROM projects WHERE title = $1', [p.title]);
    if (existing.rows[0]) {
      ids[p.title] = existing.rows[0].id;
      continue;
    }
    const id = await ins(
      `INSERT INTO projects (title, description, scope, ward_code, region_code, stage, progress_pct, budget, owner, is_published, created_by)
       VALUES ($1,$2,'ward',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [p.title, p.description, p.ward.code, p.ward.parent, p.stage, p.progress, p.budget, p.owner,
       p.published !== false, ctx.users['admin'] ?? null],
    );
    ids[p.title] = id;
    inserted++;
    let seq = 0;
    for (const [mTitle, mStatus, dueDays] of p.milestones) {
      await query(
        `INSERT INTO project_milestones (project_id, title, due_date, completed_at, status, seq)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id, mTitle, daysFromNow(dueDays).slice(0, 10),
          mStatus === 'done' ? daysFromNow(dueDays - 5) : null, mStatus, seq++,
        ],
      );
    }
  }
  logger.info({ projects: PROJECTS.length, inserted }, 'Projects + milestones ready');
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS: [string, Ward, string, string, string, string, number, number | null][] = [
  ['[MP-VAL] Ward 79 community imbizo', W079, 'meeting', 'Monthly ward meeting: service delivery, safety and the Spine Road trading layout.', 'Town Centre Hall, Spine Road', 'scheduled', 14, 250],
  ['[MP-VAL] Strandfontein clean-up canvass', W079, 'canvass', 'Door-to-door canvass combined with a litter clean-up along the strand.', 'Strandfontein beach parking', 'done', -20, 120],
  ['[MP-VAL] Rocklands voter registration drive', W075, 'service', 'IEC registration weekend hosted with the local coordinator branch.', 'Rocklands Community Hall', 'scheduled', 21, 400],
  ['[MP-VAL] Westridge safety walk briefing', W078, 'training', 'Briefing for volunteers joining the night safety walks.', 'Westridge Avenue corner park', 'live', 0, 60],
  ['[MP-VAL] Lentegeur town hall (control ward)', CONTROL_WARD, 'meeting', 'Control event in CPT-W043 — must not surface for a W079-scoped principal.', 'Lentegeur Civic Centre', 'scheduled', 30, 180],
  ['[MP-VAL] Table View fundraising breakfast (outside MP)', OUT9, 'fundraiser', 'Control event outside Mitchell\'s Plain (CPT-W009).', 'Table View Hotel', 'scheduled', 45, 90],
];

async function ensureEvents(ctx: Ctx): Promise<void> {
  if (await markerExists('events', 'title')) return;
  for (const [title, ward, kind, summary, venue, status, days, capacity] of EVENTS) {
    const starts = daysFromNow(days);
    const ends = new Date(new Date(starts).getTime() + 2 * 3600_000).toISOString();
    await query(
      `INSERT INTO events (title, kind, summary, body, region_code, ward, venue, lat, lng, starts_at, ends_at, capacity, rsvp_count, status, created_by, publication_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'published')`,
      [
        title, kind, summary, `${summary}\n\nAll residents of ${ward.area} are welcome. Please arrive 15 minutes early for registration.`,
        ward.parent, ward.code, venue, ward.lat, ward.lng, starts, ends, capacity,
        Math.round((capacity ?? 100) * 0.4), status, ctx.users['admin'] ?? null,
      ],
    );
  }
  logger.info({ events: EVENTS.length }, 'Events seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Posts — the publication gate on a MIXED public/internal surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `posts` is the one surface where published and unpublished material share a
 * single, unauthenticated endpoint: `/api/posts` is readable by anonymous, and
 * `?status=` selects the publication state. That makes it the sharpest test of
 * the publication gate in the system, and it is why these fixtures exist.
 *
 * The spread is chosen so that each scope level has a draft that exactly one tier
 * of caller may see. Note that lifting the publication gate on `posts` requires
 * `post:moderate`, which only `national_admin` and `regional_organizer` hold — a
 * `ward_councillor` deliberately has neither `post:write` nor `post:moderate`, so
 * they see no drafts at all, not even in their own ward. Verified empirically:
 *
 *   DRAFT in CPT-W079 (primary ward)  → regional, admin
 *   DRAFT in CPT-W043 (adjacent, SAME subcouncil CPT-SC17)
 *                                     → regional, admin — NOT the councillor.
 *                                       This is the subcouncil-trap pin: a
 *                                       region-only check lets it through.
 *   DRAFT in CPT-W009 (outside Mitchell's Plain, subcouncil CPT-SC4)
 *                                     → admin ONLY. A `regional_organizer` holds
 *                                       `post:moderate`, but for CPT-SC17/SC12 —
 *                                       not for another subcouncil's internal
 *                                       communications. Receiving this row is D41.
 *   DRAFT with region_code only, no ward → region-level content: the regional
 *                                       organizer sees it, a ward official does not.
 *   PUBLISHED rows in every ward        → everybody, including anonymous:
 *                                       publication, not territory, is what makes
 *                                       these public.
 *
 * `taken_down` is seeded too because it carries a moderation reason, which is
 * internal material even though the underlying note came from the community.
 */
interface PostSeed {
  title: string;
  kind: string;
  ward: Ward | null;
  /** Overrides the ward's parent — used for the region-level (ward-less) post. */
  regionCode?: string;
  status: 'published' | 'draft' | 'taken_down';
  body: string;
  takeDownReason?: string;
}

const POSTS: PostSeed[] = [
  { title: "[MP-VAL] Ward 79 water outage update", kind: 'news', ward: W079, status: 'published', body: 'Published update on the Spine Road burst: repairs under way, tankers stationed at the Town Centre.' },
  { title: "[MP-VAL] Lentegeur drainage update (control ward)", kind: 'news', ward: CONTROL_WARD, status: 'published', body: 'Published control post in CPT-W043 — public content, so territory does not gate it.' },
  { title: "[MP-VAL] Table View road works (outside MP)", kind: 'news', ward: OUT9, status: 'published', body: 'Published control post outside Mitchell\'s Plain (CPT-W009).' },
  { title: "[MP-VAL] DRAFT Ward 79 budget briefing (unpublished)", kind: 'statement', ward: W079, status: 'draft', body: 'Unpublished briefing for the ward councillor and the subcouncil organizer only.' },
  { title: "[MP-VAL] DRAFT Lentegeur internal note (control ward, unpublished)", kind: 'statement', ward: CONTROL_WARD, status: 'draft', body: 'Unpublished note inside CPT-SC17 but outside CPT-W079 — the subcouncil trap.' },
  { title: "[MP-VAL] DRAFT Table View provincial memo (outside MP, unpublished)", kind: 'press_release', ward: OUT9, status: 'draft', body: 'Unpublished memo belonging to another subcouncil entirely — national admin only.' },
  { title: "[MP-VAL] DRAFT SC17 regional circular (region-level, unpublished)", kind: 'news', ward: null, regionCode: 'CPT-SC17', status: 'draft', body: 'Region-level unpublished circular: no ward, so only the subcouncil organizer and national admin may read it.' },
  { title: "[MP-VAL] TAKEN DOWN Westridge spam note", kind: 'community_note', ward: W078, status: 'taken_down', body: 'Community note removed by a moderator. The take-down reason is internal material.', takeDownReason: 'Commercial advertising posted as a community service report.' },
];

async function ensurePosts(ctx: Ctx): Promise<void> {
  // Per-row idempotency on `title`, NOT the table-level `markerExists` guard: that
  // guard is all-or-nothing, so a database seeded before these fixtures existed
  // would never receive them and the probes below would then assert against an
  // empty table — passing while exercising nothing (D40).
  let inserted = 0;
  for (const p of POSTS) {
    if (await rowExists('posts', 'title', p.title)) continue;
    const regionCode = p.regionCode ?? p.ward?.parent ?? null;
    // `published_at` is NOT NULL on this table, so an unpublished row still needs
    // a timestamp; `publication_status` mirrors `status` for the legacy column.
    await query(
      `INSERT INTO posts (kind, title, excerpt, body, region_code, ward, author, status,
                          take_down_reason, taken_down_at, published_at, created_by, publication_status)
       VALUES ($1::post_kind,$2,$3,$4,$5,$6,$7,$8::post_status,$9,$10,now(),$11,$12)`,
      [
        p.kind, p.title, p.body.slice(0, 160), p.body, regionCode, p.ward?.code ?? null,
        'UDF Validation Fixture', p.status, p.takeDownReason ?? null,
        p.status === 'taken_down' ? new Date().toISOString() : null,
        ctx.users['admin'] ?? null,
        p.status === 'published' ? 'published' : 'draft',
      ],
    );
    inserted++;
  }
  logger.info({ posts: POSTS.length, inserted }, 'Posts seeded (publication-gate fixtures)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Petitions + signatures
// ─────────────────────────────────────────────────────────────────────────────

interface PetitionSeed {
  title: string;
  body: string;
  ward: Ward;
  target: string;
  status: string;
  goal: number;
  closesInDays: number;
  signers: string[]; // resident keys
}

const PETITIONS: PetitionSeed[] = [
  {
    title: '[MP-VAL] Permanently repair the Spine Road water main',
    body: 'We, residents of Ward 79, call on the City to replace rather than patch the failing Spine Road water main, which has burst four times this year.',
    ward: W079, target: 'municipality', status: 'open', goal: 500, closesInDays: 30,
    signers: ['r1', 'r2', 'r3', 'r4', 'r6'],
  },
  {
    title: '[MP-VAL] Reinstate the Westridge evening bus service',
    body: 'The 19:40 bus was withdrawn without consultation. Residents working evening shifts in the Town Centre have no safe way home.',
    ward: W078, target: 'municipality', status: 'submitted', goal: 300, closesInDays: -5,
    signers: ['r7', 'r8'],
  },
  {
    title: '[MP-VAL] Lentegeur open-drainage petition (control ward)',
    body: 'Control petition in CPT-W043 — must not appear in a W079-scoped petition feed.',
    ward: CONTROL_WARD, target: 'municipality', status: 'open', goal: 200, closesInDays: 45,
    signers: ['c1'],
  },
];

async function ensurePetitions(ctx: Ctx): Promise<void> {
  if (await markerExists('petitions', 'title')) return;
  for (const p of PETITIONS) {
    const id = await ins(
      `INSERT INTO petitions (title, body, target, scope, ward_code, region_code, opens_at, closes_at, signature_goal, status, created_by)
       VALUES ($1,$2,$3,'ward',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        p.title, p.body, p.target, p.ward.code, p.ward.parent,
        daysFromNow(p.closesInDays - 30), daysFromNow(p.closesInDays), p.goal, p.status, ctx.users['admin'] ?? null,
      ],
    );
    for (const key of p.signers) {
      const memberId = ctx.members[key];
      if (!memberId) continue;
      await query(
        `INSERT INTO petition_signatures (petition_id, member_id, ward_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id, memberId, p.ward.code],
      );
    }
  }
  logger.info({ petitions: PETITIONS.length }, 'Petitions + signatures seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public participations + comments
// ─────────────────────────────────────────────────────────────────────────────

const PARTICIPATIONS: [string, string, Ward, string, number, number, [string, number, string | null][]][] = [
  [
    '[MP-VAL] Comment: Spine Road informal trading layout',
    'The ward invites written comment on the proposed informal-trading layout, including bay allocation, waste collection and pedestrian access.',
    W079, 'open', -7, 21,
    [
      ['Support the layout but ask that the taxi rank side be kept clear for pedestrian access.', 4, null],
      ['Bay allocation must prioritise residents who have traded here for more than five years.', 3, null],
      ['No public toilets were promised last time and none were built. Fix that first.', 1, 'Previous commitment on ablution facilities was not delivered.'],
    ],
  ],
  [
    '[MP-VAL] Comment: Eastridge road grading priorities',
    'Rank the gravel roads in Eastridge and Woodlands that should be graded first in the coming financial year.',
    W116, 'submitted', -40, -10,
    [
      ['Woodlands Avenue first — it is the school route.', 5, null],
      ['Eastridge Boulevard floods badly after rain.', 4, null],
    ],
  ],
  [
    '[MP-VAL] Comment: Lentegeur canal (control ward)',
    'Control participation in CPT-W043 — must not appear in a W079-scoped participation feed.',
    CONTROL_WARD, 'open', -3, 25,
    [['The canal needs lining before the winter rains.', 2, 'Ongoing overflow risk was raised twice before with no action.']],
  ],
];

async function ensureParticipations(ctx: Ctx): Promise<void> {
  if (await markerExists('public_participations', 'title')) return;
  for (const [title, body, ward, status, opensDays, closesDays, comments] of PARTICIPATIONS) {
    const id = await ins(
      `INSERT INTO public_participations (title, subject, body, scope, ward_code, region_code, opens_at, closes_at, status, created_by)
       VALUES ($1,$2,$3,'ward',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        title, ward.area, body, ward.code, ward.parent,
        daysFromNow(opensDays), daysFromNow(closesDays), status, ctx.users['admin'] ?? null,
      ],
    );
    const commenters = ward.code === W079.code ? ['r1', 'r2', 'r3'] : ward.code === W116.code ? ['r11', 'r12'] : ['c1', 'c2'];
    let i = 0;
    for (const [text, rating, reasonIfLow] of comments) {
      const memberId = ctx.members[commenters[i % commenters.length]!] ?? ctx.members['r1']!;
      await query(
        `INSERT INTO participation_comments (participation_id, member_id, ward_code, comment, rating, reason_if_low, event_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, memberId, ward.code, text, rating, reasonIfLow, daysFromNow(opensDays + i + 1)],
      );
      i++;
    }
  }
  logger.info({ participations: PARTICIPATIONS.length }, 'Public participations + comments seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ratings (councillor scorecard, case outcome, project, patrol)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureRatings(ctx: Ctx, caseIds: Record<string, string>, projectIds: Record<string, string>): Promise<void> {
  if (await markerExists('ratings', 'reason')) return;
  const councillorMember = ctx.members['r5']!;

  const add = async (targetType: string, targetId: string, memberKey: string, rating: number, reason: string, days: number) => {
    const memberId = ctx.members[memberKey];
    if (!memberId || !targetId) return;
    await query(
      `INSERT INTO ratings (target_type, target_id, member_id, rating, reason, event_timestamp)
       VALUES ($1::rating_target_type,$2,$3,$4,$5,$6)`,
      [targetType, targetId, memberId, rating, `[MP-VAL] ${reason}`, daysFromNow(days)],
    );
  };

  // Councillor scorecard — a spread, not five stars, so the average is real.
  await add('councillor', councillorMember, 'r1', 5, 'Responded within a day and kept us updated on the water main.', -3);
  await add('councillor', councillorMember, 'r2', 4, 'Good communication; street lights still outstanding.', -6);
  await add('councillor', councillorMember, 'r3', 3, 'Clinic day was cancelled twice without notice.', -9);
  await add('councillor', councillorMember, 'r6', 2, 'No feedback at all on the dumping complaint.', -12);

  await add('service_request', caseIds['SR-MP-0004'] ?? '', 'r4', 5, 'Potholes properly repaired and the crossing is safe again.', -8);
  await add('service_request', caseIds['SR-MP-0005'] ?? '', 'r6', 4, 'Cleared quickly, but dumping has started again nearby.', -7);
  await add('service_request', caseIds['SR-MP-0003'] ?? '', 'r3', 1, 'Still overflowing six days after the first report.', -1);

  await add('project', projectIds[PROJECTS[0]!.title] ?? '', 'r3', 4, 'Bays look good; we still need the ablution block.', -2);

  const patrol = await query<{ id: string }>(
    `SELECT id FROM patrols WHERE purpose LIKE '[MP-VAL]%' AND ward_code = $1 ORDER BY created_at LIMIT 1`,
    [W079.code],
  );
  await add('patrol', patrol.rows[0]?.id ?? '', 'r1', 5, 'Visible presence; two problems were logged the same evening.', -11);

  logger.info('Ratings seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifications (resident confirmation that work was actually done)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureVerifications(ctx: Ctx, caseIds: Record<string, string>): Promise<void> {
  if (await markerExists('verifications', 'note')) return;
  const rows: [string, string, string, string, number][] = [
    ['SR-MP-0004', 'r4', 'fixed', 'Resurfaced properly and marked. School crossing is safe again.', -8],
    ['SR-MP-0004', 'r1', 'fixed', 'Confirmed from the pavement side too.', -8],
    ['SR-MP-0005', 'r6', 'partial', 'Cleared, but half the vacant erf is still being used for dumping.', -6],
    ['SR-MP-0003', 'r3', 'not_fixed', 'Sewage is still overflowing into the channel. Nothing has been done.', -1],
    ['SR-MP-0001', 'r2', 'not_fixed', 'Water is back on but the burst section was only clamped.', -2],
  ];
  for (const [ref, memberKey, verdict, note, days] of rows) {
    const srId = caseIds[ref];
    const memberId = ctx.members[memberKey];
    if (!srId || !memberId) continue;
    await query(
      `INSERT INTO verifications (service_request_id, member_id, verdict, note, created_at)
       VALUES ($1,$2,$3::verification_verdict,$4,$5)`,
      [srId, memberId, verdict, `[MP-VAL] ${note}`, daysFromNow(days)],
    );
  }
  logger.info({ verifications: rows.length }, 'Verifications seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Engagement requests (member → councillor channel)
// ─────────────────────────────────────────────────────────────────────────────

const ENGAGEMENTS: [string, string, string, string[], string | null][] = [
  ['r2', 'meeting', 'requested', ['Tuesday 18:00', 'Thursday 17:30'], 'Want to discuss the street lighting on Westgate Drive.'],
  ['r3', 'site_visit', 'scheduled', ['Saturday 09:00'], 'Please come and see the sewer overflow in person before it is closed off.'],
  ['r4', 'complaint_escalation', 'acknowledged', ['Monday 08:00', 'Wednesday 08:00'], 'Escalating the dumping behind the taxi rank — third complaint this quarter.'],
  ['r6', 'home_visit', 'declined', ['Friday 10:00'], 'Requested a home visit regarding the backyard dwelling overcrowding.'],
  ['c1', 'meeting', 'requested', ['Sunday 11:00'], 'Control request from the adjacent ward CPT-W043.'],
];

async function ensureEngagementRequests(ctx: Ctx): Promise<void> {
  if (await markerExists('engagement_requests', 'notes')) return;
  const councillorMember = ctx.members['r5']!;
  for (const [memberKey, type, status, slots, notes] of ENGAGEMENTS) {
    const memberId = ctx.members[memberKey];
    if (!memberId) continue;
    const ward = memberKey === 'c1' ? CONTROL_WARD : W079;
    await query(
      `INSERT INTO engagement_requests (member_id, councillor_member_id, type, preferred_slots, ward_code, status, notes)
       VALUES ($1,$2,$3::engagement_type,$4::jsonb,$5,$6::engagement_status,$7)`,
      [memberId, councillorMember, type, JSON.stringify(slots), ward.code, status, `[MP-VAL] ${notes}`],
    );
  }
  logger.info({ engagementRequests: ENGAGEMENTS.length }, 'Engagement requests seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Resident reports (the mobile member → councillor channel)
// ─────────────────────────────────────────────────────────────────────────────

const REPORTS: [string, string, string, string, string, string, number][] = [
  ['RR-MP-0001', 'member', W079.code, 'sanitation', 'Public toilet block at the Town Centre taxi rank has no water and is unusable.', 'submitted', -2],
  ['RR-MP-0002', 'member', W079.code, 'safety', 'Two street lights out outside the primary school gate; children leave in the dark.', 'acknowledged', -5],
  ['RR-MP-0003', 'member', W079.code, 'roads', 'Pothole the size of a dustbin lid on Westgate Drive near the clinic.', 'closed', -25],
  ['RR-MP-0004', 'memberOutside', CONTROL_WARD.code, 'water', 'Control report from CPT-W043 — must not appear in the W079 councillor queue.', 'submitted', -1],
];

async function ensureResidentReports(ctx: Ctx): Promise<void> {
  if (await markerExists('resident_reports', 'message')) return;
  for (const [ref, userKey, wardCode, category, message, status, days] of REPORTS) {
    const userId = ctx.users[userKey];
    if (!userId) continue;
    // Link to the member row that shares the account holder's identity where one
    // exists (r1 = Thandeka Majola = member.mp79; c1 = Johan Botha = member.mp43).
    const memberKey = userKey === 'member' ? 'r1' : 'c1';
    const ward = wardCode === W079.code ? W079 : CONTROL_WARD;
    await query(
      `INSERT INTO resident_reports (ref_no, user_id, member_id, ward_code, category, message, location, accuracy_m, status, councillor_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,${point(ward.lat, ward.lng)},$7,$8,$9,$10,$10)`,
      [
        ref, userId, ctx.members[memberKey] ?? null, wardCode, category,
        `[MP-VAL] ${message}`, 12, status, ctx.users['councillor'] ?? null, daysFromNow(days),
      ],
    );
  }
  logger.info({ residentReports: REPORTS.length }, 'Resident reports seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ward jobs — interests (members) + opportunities (branches)
// ─────────────────────────────────────────────────────────────────────────────

const JOB_INTERESTS: [string, string, string[], string][] = [
  ['r9', 'CPT-W075', ['driving', 'security'], 'Code 10 PDP, eight years driving for a logistics firm; PSIRA grade C.'],
  ['r4', 'CPT-W079', ['labourer', 'gardening'], 'General labour and grounds maintenance; available immediately.'],
  ['r12', 'CPT-W116', ['catering', 'cleaning'], 'Catering for up to 200 covers; food-handling certificate.'],
  ['r7', 'CPT-W078', ['admin', 'retail'], 'Retail floor experience and basic bookkeeping.'],
];

const JOB_OPPORTUNITIES: [string, string, Ward, string, string, string[], string, string][] = [
  ['JO-MP-0001', 'published', W079, 'Site labourers — Spine Road trading upgrade', 'Main contractor', ['labourer', 'construction'], 'Twelve positions for the Spine Road construction phase 1. Own transport preferred.', '+27215550079'],
  ['JO-MP-0002', 'published', W075, 'Community health workers', 'Mitchell\'s Plain CHC', ['healthcare', 'cleaning'], 'Home-visit support for the chronic-care programme. Stipend plus training.', 'jobs@udf.test'],
  ['JO-MP-0003', 'draft', W078, 'Catering assistants — ward imbizo', 'Ward 78 committee', ['catering'], 'Short-term catering for the monthly imbizo. Not yet published.', 'jobs@udf.test'],
  ['JO-MP-0004', 'published', CONTROL_WARD, 'Canal rehabilitation crew (control ward)', 'Subcouncil 17', ['labourer'], 'Control opportunity in CPT-W043 — must not surface in a W079-scoped feed.', 'jobs@udf.test'],
  // Audit anchors. `reachableRow` in scripts/role-audit-lib.mjs picks the first
  // fixture row a principal is entitled to reach and falls back to the NIL UUID
  // when none is eligible; the member-scope gate in modules/jobs/service.ts
  // (`getOpportunity`) admits only `status === 'published'` in the caller's own
  // ward. Without a stable published row per member ward, the audit's
  // `expectFor` (no permission declared ⇒ allow) is scored against the
  // publication gate's 403 and reported as an authorization mismatch. These two
  // rows are that stable pin — one for the primary member (CPT-W079), one for
  // the out-of-scope member (CPT-W043) — and the upsert below restores them on
  // every seed run so a stray smoke-test `close` cannot permanently retire them.
  ['JO-MP-0005', 'published', W079, 'Audit anchor — published opportunity (member ward)', 'UDF validation', ['cleaning'], 'Standing published fixture used by the role/POPIA audit to prove a member CAN open an opportunity in their own ward.', 'jobs@udf.test'],
  ['JO-MP-0006', 'published', CONTROL_WARD, 'Audit anchor — published opportunity (control ward)', 'UDF validation', ['cleaning'], 'Standing published fixture used by the role/POPIA audit to prove an out-of-scope member CAN open an opportunity in their own ward.', 'jobs@udf.test'],
];

async function ensureJobs(ctx: Ctx): Promise<void> {
  const interestsSeeded = await markerExists('job_interests', 'first_name');
  if (!interestsSeeded) {
    for (const [memberKey, wardCode, workTypes, experience] of JOB_INTERESTS) {
      const memberId = ctx.members[memberKey];
      if (!memberId) continue;
      // job_interests stores the work-seeker's own contact details in the clear by
      // design (it is the CV channel), so we reuse the resident's public-facing
      // name but a job-specific email to keep the sealed-PII set unambiguous.
      const resident = RESIDENTS.find((r) => r.key === memberKey);
      if (!resident) continue;
      const [firstName, ...rest] = resident.fullName.split(' ');
      await query(
        `INSERT INTO job_interests (member_id, user_id, ward_code, region_code, first_name, surname, email, work_types, experience, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
        [
          memberId, ctx.users['member'] ?? null, wardCode, resident.ward.parent,
          `[MP-VAL]${firstName}`, rest.join(' '), `workseeker.${memberKey}@udf.test`, workTypes, experience,
        ],
      );
    }
  }

  // Opportunities are UPSERTED on `ref_no` rather than gated by the interests
  // marker: the declared `status`, `published_at`, `closes_at` and `expires_at`
  // are the fixture's contract with the audit harness, and any drift (a smoke
  // run closing a seeded row, an operator publishing a draft by hand) is
  // repaired on the next `npm run seed:validation`. `expires_at` is forced NULL
  // so the reaper in modules/jobs/service.ts (`refreshOpportunityExpiries`)
  // cannot retire an anchor between runs.
  for (const [ref, status, ward, title, company, workTypes, description, contact] of JOB_OPPORTUNITIES) {
    const isPhone = contact.startsWith('+');
    await query(
      `INSERT INTO job_opportunities (ref_no, ward_code, region_code, title, company, work_types, description, contact_email, contact_phone, status, created_by, published_at, closes_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)
       ON CONFLICT (ref_no) DO UPDATE
         SET ward_code     = EXCLUDED.ward_code,
             region_code   = EXCLUDED.region_code,
             title         = EXCLUDED.title,
             company       = EXCLUDED.company,
             work_types    = EXCLUDED.work_types,
             description   = EXCLUDED.description,
             contact_email = EXCLUDED.contact_email,
             contact_phone = EXCLUDED.contact_phone,
             status        = EXCLUDED.status,
             published_at  = EXCLUDED.published_at,
             closes_at     = EXCLUDED.closes_at,
             expires_at    = NULL,
             updated_at    = now()`,
      [
        ref, ward.code, ward.parent, `[MP-VAL] ${title}`, company, workTypes, description,
        isPhone ? null : contact, isPhone ? contact : null, status, ctx.users['admin'] ?? null,
        status === 'published' ? daysFromNow(-4) : null, daysFromNow(28).slice(0, 10),
      ],
    );
  }
  logger.info({ interests: JOB_INTERESTS.length, opportunities: JOB_OPPORTUNITIES.length, interestsAlreadySeeded: interestsSeeded }, 'Ward jobs seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications (backs the CRM badge / mobile inbox)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureNotifications(ctx: Ctx, caseIds: Record<string, string>): Promise<void> {
  if (await markerExists('notifications', 'title')) return;
  const councillor = ctx.users['councillor'];
  const member = ctx.users['member'];
  const regional = ctx.users['regional'];

  const add = async (userId: string | undefined, kind: string, title: string, body: string, link: string, regionCode: string, read: boolean) => {
    if (!userId) return;
    const id = await ins(
      `INSERT INTO notifications (user_id, kind, title, body, link, region_code)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, kind, `[MP-VAL] ${title}`, body, link, regionCode],
    );
    if (read) await query(`INSERT INTO notification_reads (user_id, notification_id) VALUES ($1,$2)`, [userId, id]);
  };

  /**
   * Two link grammars, and a notification must use the right one for its reader:
   *
   *   • `/<route>` — a real path in `frontend/src/app`, followed by the desktop
   *     CRM bell panel via `router.push`.
   *   • `tab:<tab>#<section>[:id]` — a mobile deep link, parsed by `followLink`
   *     in `components/tabs/EngageTab.tsx` against `TabId`/`Section` in
   *     `AppShell.tsx`. There is no `/app/*` route at all: the mobile app is
   *     served from `/`.
   *
   * An earlier revision of this seed invented `/crm/cases`, `/app/cases` and
   * `/app/ward` (D54). They rendered as dead links — the CRM one a 404, the two
   * mobile ones silently ignored, because `followLink` returns early when the
   * string does not match `tab:`. A test fixture whose alerts lead nowhere
   * would have made the D9 bell panel look broken while it was working.
   */
  await add(councillor, 'escalation', 'SLA breached in Ward 79', 'The Eastridge sewer overflow has passed its SLA and escalated to the subcouncil.', '/crm/escalations', W079.parent, false);
  await add(councillor, 'case', 'New resident report', 'A resident reported an unusable toilet block at the Town Centre taxi rank.', '/crm/engagements', W079.parent, false);
  await add(councillor, 'engagement', 'Engagement request scheduled', 'A site visit for the sewer overflow has been scheduled for Saturday 09:00.', '/crm/engagements', W079.parent, true);
  await add(councillor, 'info', 'Verification received', 'A resident verified the Rocklands Avenue repairs as fixed.', '/crm/engagements', W079.parent, false);
  await add(member, 'info', 'Your report was acknowledged', 'The street-lighting report outside the school gate has been acknowledged by your ward councillor.', 'tab:engage#cases', W079.parent, false);
  await add(member, 'bulletin', 'New ward bulletin', 'Rocklands Avenue resurfacing is complete and independently verified.', 'tab:engage#bulletins', W079.parent, true);
  await add(regional, 'escalation', 'Two wards breaching SLA', 'Ward 79 and Ward 75 both have cases past their SLA window.', '/crm/escalations', 'CPT-SC17', false);

  logger.info('Notifications seeded');
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '../../../deploy/.artifacts');
const REVERT_FILE = path.join(ARTIFACTS, 'ward-rename-revert.sql');

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * `regions` is official reference data and SURVIVES `factory:reset`, so the
 * Mitchell's Plain rename cannot be undone by the seeder. Capture the exact
 * original names on first touch and write them out as revert SQL.
 */
async function captureWardRevertSql(): Promise<void> {
  const wards = [...MP_WARDS, CONTROL_WARD];
  const res = await query<{ code: string; name: string }>(
    `SELECT code, name FROM regions WHERE code = ANY($1::text[]) AND level = 'ward' ORDER BY code`,
    [wards.map((w) => w.code)],
  );
  const lines = res.rows
    .filter((r) => !r.name.startsWith(MP_LABEL))
    .map((r) => `UPDATE regions SET name = ${sqlStr(r.name)} WHERE code = ${sqlStr(r.code)} AND level = 'ward';`);
  if (lines.length === 0) return;

  await mkdir(ARTIFACTS, { recursive: true });
  let existing = '';
  try {
    existing = await readFile(REVERT_FILE, 'utf8');
  } catch {
    existing = `-- Revert the Mitchell's Plain validation rename of regions.name.\n-- Generated ${new Date().toISOString()}\n`;
  }
  const fresh = lines.filter((l) => !existing.includes(l));
  if (fresh.length === 0) return;
  await appendFile(REVERT_FILE, `${existing.endsWith('\n') ? '' : '\n'}${fresh.join('\n')}\n`, 'utf8');
  logger.info({ file: REVERT_FILE, wards: fresh.length }, 'Recorded ward-rename revert SQL');
}

/**
 * Concrete fixture ids, so the role-audit harness can build real URLs for the
 * `:id` path parameters instead of guessing UUIDs.
 */
async function writeIds(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pick = async <T extends Record<string, any>>(sql: string): Promise<T[]> => (await query<T>(sql)).rows;

  const users: Record<string, string | null> = {};
  for (const u of TEST_USERS) users[u.key] = await userByEmail(u.email);

  /**
   * `resident_reports` is the one collection whose read gate is OWNER-or-staff
   * rather than territory — migration 009: "POPIA: the report is private to the
   * author and the ward's staff", implemented as
   * `isOwner || (STAFF_ROLES.includes(role) && principalSeesWard(ward))`.
   *
   * The harness therefore has to know who owns each row before it can decide
   * whether a principal is entitled to it: territory alone is not the test, and
   * for a NON-STAFF caller territory confers nothing at all. `users` has no
   * plaintext email column (it stores `email_bidx` + `sealed_pii`), so the owner
   * is resolved through the account map built just above rather than read back
   * out of the row.
   */
  const emailByUserId = new Map<string, string>();
  for (const u of TEST_USERS) {
    const id = users[u.key];
    if (id) emailByUserId.set(id, u.email);
  }
  const reports = (
    await pick<{ id: string; ref_no: string; ward_code: string; status: string; user_id: string }>(
      `SELECT id, ref_no, ward_code, status, user_id FROM resident_reports WHERE ref_no LIKE 'RR-MP-%' ORDER BY ref_no`,
    )
  ).map(({ user_id, ...rest }) => ({ ...rest, owner_email: emailByUserId.get(user_id) ?? null }));

  const ids = {
    generatedAt: new Date().toISOString(),
    users,
    members: await pick<{ id: string; ward: string; region_code: string; tier: string; status: string }>(
      `SELECT id, ward, region_code, tier, status FROM members WHERE deleted_at IS NULL AND ward IS NOT NULL ORDER BY ward`,
    ),
    cases: await pick<{ id: string; ref_no: string; ward_code: string; status: string; visibility: string }>(
      `SELECT id, ref_no, ward_code, status, visibility FROM service_requests WHERE ref_no LIKE 'SR-MP-%' ORDER BY ref_no`,
    ),
    projects: await pick<{ id: string; title: string; ward_code: string; is_published: boolean }>(
      `SELECT id, title, ward_code, is_published FROM projects WHERE title LIKE '[MP-VAL]%' ORDER BY title`,
    ),
    patrols: await pick<{ id: string; ward_code: string; visibility: string }>(
      `SELECT id, ward_code, visibility FROM patrols WHERE purpose LIKE '[MP-VAL]%' ORDER BY created_at`,
    ),
    bulletins: await pick<{ id: string; ward_code: string; kind: string; status: string }>(
      `SELECT id, ward_code, kind, status FROM ward_bulletins WHERE title LIKE '[MP-VAL]%' ORDER BY published_at`,
    ),
    events: await pick<{ id: string; ward: string; status: string }>(
      `SELECT id, ward, status FROM events WHERE title LIKE '[MP-VAL]%' ORDER BY starts_at`,
    ),
    // Published with their titles so the D41 probes can assert on EXACT set
    // membership ("this principal sees precisely these drafts") rather than on a
    // substring scan, which cannot express the positive half of the control.
    posts: await pick<{ id: string; title: string; status: string; region_code: string | null; ward: string | null }>(
      `SELECT id, title, status, region_code, ward FROM posts WHERE title LIKE '[MP-VAL]%' ORDER BY status, title`,
    ),
    petitions: await pick<{ id: string; ward_code: string; status: string }>(
      `SELECT id, ward_code, status FROM petitions WHERE title LIKE '[MP-VAL]%' ORDER BY title`,
    ),
    participations: await pick<{ id: string; ward_code: string; status: string }>(
      `SELECT id, ward_code, status FROM public_participations WHERE title LIKE '[MP-VAL]%' ORDER BY title`,
    ),
    opportunities: await pick<{ id: string; ref_no: string; ward_code: string; status: string }>(
      `SELECT id, ref_no, ward_code, status FROM job_opportunities WHERE ref_no LIKE 'JO-MP-%' ORDER BY ref_no`,
    ),
    reports,
    councillors: await pick<{ member_id: string; id: string; ward_code: string }>(
      `SELECT id, member_id, ward_code FROM leaders WHERE is_public = TRUE`,
    ),
    wards: {
      primary: W079.code,
      mp: MP_WARDS.map((w) => w.code),
      control: CONTROL_WARD.code,
      outside: OUTSIDE_WARDS.map((w) => w.code),
    },
  };

  await mkdir(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, 'validation-ids.json');
  await writeFile(file, `${JSON.stringify(ids, null, 2)}\n`, 'utf8');
  logger.info({ file }, 'Published fixture ids for the role-audit harness');
}

function printSummary(): void {
  const rows = TEST_USERS.map((u) => `  ${u.email.padEnd(30)} ${u.role.padEnd(20)} ${u.wardCode ?? (u.regionCodes.length ? u.regionCodes.join(',') : 'national')}`);
  /* eslint-disable no-console */
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log("Mitchell's Plain validation fixtures are in place.");
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`All accounts share the password in VALIDATION_PASSWORD (default shown below).`);
  console.log(`  password: ${VALIDATION_PASSWORD}`);
  console.log('\nAccounts:');
  console.log(rows.join('\n'));
  console.log('\nOut-of-scope controls:');
  console.log(`  member ${'member.mp43@udf.test'.padEnd(26)} ward CPT-W043 (adjacent)`);
  console.log('  records also seeded in CPT-W009 / CPT-W025 (other metro areas)');
  console.log('\nRemoval:');
  console.log('  npm run factory:reset -- --force      # wipes every business table, KEEPS regions');
  console.log(`  psql -f ${path.relative(process.cwd(), REVERT_FILE)}   # undoes the ward rename`);
  console.log('  (validation users are removed by factory:reset; regions survive it)\n');
  console.log('──────────────────────────────────────────────────────────────\n');
  /* eslint-enable no-console */
}

async function seedValidation(): Promise<void> {
  await captureWardRevertSql();
  await ensureWardNaming();

  const users = await ensureUsers();
  const members = await ensureMembers(users);
  await ensureCouncillorIdentity(users, members);
  // Set the canonical `users.member_id` link the real onboarding flow sets, so a
  // member/councillor login resolves to its member profile (recruitment invite/
  // tree, scorecard history). See `linkMemberAccounts` for why staff are excluded.
  await linkMemberAccounts(users, members);

  const ctx: Ctx = { users, members };
  const caseIds = await ensureServiceRequests(ctx);
  await ensurePatrols(ctx);
  await ensureBulletins(ctx, caseIds);
  const projectIds = await ensureProjects(ctx);
  await ensureEvents(ctx);
  await ensurePosts(ctx);
  await ensurePetitions(ctx);
  await ensureParticipations(ctx);
  await ensureRatings(ctx, caseIds, projectIds);
  await ensureVerifications(ctx, caseIds);
  await ensureEngagementRequests(ctx);
  await ensureResidentReports(ctx);
  await ensureJobs(ctx);
  await ensureNotifications(ctx, caseIds);

  await writePiiCorpus();
  await writeIds();

  printSummary();
  logger.info("Mitchell's Plain validation seed complete");
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seedValidation()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'Validation seed failed');
      process.exit(1);
    });
}

export {
  seedValidation,
  ensureServiceRequests,
  ensurePatrols,
  ensureBulletins,
  ensureProjects,
  ensureEvents,
  ensurePosts,
  ensurePetitions,
  ensureParticipations,
  ensureRatings,
  ensureVerifications,
  ensureEngagementRequests,
  ensureResidentReports,
  ensureJobs,
  ensureNotifications,
};
