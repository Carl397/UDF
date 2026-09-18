import { query } from './pool.js';
import { logger } from '../config/logger.js';
import { notify } from '../modules/notifications/service.js';
import { issueToken, newPublicCode } from '../modules/memberships/service.js';

/**
 * Seeds the engagement layer: events, communications, appointments/mandates
 * and notifications, on top of the member dataset from `seed.ts`.
 *
 * Idempotent — each block is skipped when rows already exist.
 */

const days = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dateOnly = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const EVENT_SEED = [
  {
    title: 'UDF National Rally — Service Delivery Now',
    kind: 'rally',
    region: null,
    ward: null,
    venue: 'Freedom Park Stadium',
    offset: 6,
    summary: 'Mass rally launching the ward service-delivery scorecard campaign.',
    capacity: 20000,
  },
  {
    title: 'Ward 12 Branch Meeting',
    kind: 'meeting',
    region: 'NORTH',
    ward: '12',
    venue: 'Community Hall, Ward 12',
    offset: 2,
    summary: 'Monthly branch meeting: reports, community notes and mandate nominations.',
    capacity: 200,
  },
  {
    title: 'Candidate Training — Election Law & Observers',
    kind: 'training',
    region: 'EAST',
    ward: null,
    venue: 'Regional Secretariat',
    offset: 9,
    summary: 'Certification for ward candidates and polling-station observers.',
    capacity: 120,
  },
  {
    title: 'Door-to-Door Canvass: Southern Districts',
    kind: 'canvass',
    region: 'SOUTH',
    ward: '4',
    venue: 'Meet at Taxi Rank, 07:30',
    offset: 3,
    summary: 'Membership drive and community-note collection across 6 streets.',
    capacity: 80,
  },
  {
    title: 'Youth League Debate — Jobs & Apprenticeships',
    kind: 'debate',
    region: 'WEST',
    ward: null,
    venue: 'City Library Auditorium',
    offset: 12,
    summary: 'Public debate with the youth league and local business forum.',
    capacity: 400,
  },
  {
    title: 'Branch Fundraiser — Winter Blanket Drive',
    kind: 'fundraiser',
    region: 'CENTRAL',
    ward: '2',
    venue: 'Central Civic Centre',
    offset: 16,
    summary: 'Fundraise for the winter relief programme; tables and auctions.',
    capacity: 300,
  },
  {
    title: 'Clean-Up & Clinic Queue Audit',
    kind: 'service',
    region: 'NORTH',
    ward: '7',
    venue: 'Ward 7 Clinic',
    offset: 4,
    summary: 'Volunteer clean-up plus a documented audit of clinic waiting times.',
    capacity: 60,
  },
  {
    title: 'Organisers Webinar — Using the UDF App',
    kind: 'webinar',
    region: null,
    ward: null,
    venue: 'Online',
    offset: 1,
    summary: 'How to log community notes, issue mandates and read the heat map.',
    capacity: 500,
  },
  {
    title: 'Regional Executive Committee Meeting',
    kind: 'meeting',
    region: 'EAST',
    ward: null,
    venue: 'Regional Secretariat',
    offset: -5,
    summary: 'Past meeting: approved Q3 appointments and the media plan.',
    capacity: 40,
  },
];

const POST_SEED = [
  {
    kind: 'press_release',
    title: 'UDF demands published response times for water outages',
    excerpt:
      'The party has written to all five regional municipalities demanding a public register of outages and restoration times.',
    body:
      'FOR IMMEDIATE RELEASE\n\nThe UDF today called on every regional municipality to publish a live register of water ' +
      'outages together with the time each fault was reported, the time crews arrived and the time supply was restored.\n\n' +
      '"Residents already know when the water stops. What they are denied is the record that would hold someone answerable," ' +
      'said the National Spokesperson. "A published register turns a private frustration into an auditable fact."\n\n' +
      'The party will table the demand at each regional executive committee this month and will report ward-by-ward ' +
      'compliance in its quarterly service-delivery scorecard.\n\nENDS',
    region: null,
    author: 'Office of the National Spokesperson',
    severity: null,
    service_area: null,
  },
  {
    kind: 'news',
    title: 'Membership passes 60 registered organisers in five regions',
    excerpt: 'New branches opened in the Northern and Eastern regions this quarter.',
    body:
      'The membership desk has confirmed registrations across all five regions, with the strongest growth in the ' +
      'Northern and Eastern regions. New ward branches will elect chairs before the end of the quarter, and every ' +
      'new member receives a confirmation link and a QR party card.',
    region: null,
    author: 'Membership Desk',
    severity: null,
    service_area: null,
  },
  {
    kind: 'highlight',
    title: 'Ward 7 repairs the broken pump in 36 hours',
    excerpt: 'A community note logged on the app reached the ward engineer the same morning.',
    body:
      'Logged at 06:40 by a branch volunteer, the Ward 7 pump failure was assigned to the district engineer by 09:15 ' +
      'and restored the following afternoon. This is what a tracked note looks like: a report, an owner, a deadline and ' +
      'a published result.',
    region: 'NORTH',
    ward: '7',
    author: 'Northern Region Communications',
    severity: 'info',
    service_area: 'water',
  },
  {
    kind: 'statement',
    title: 'Statement on election-day conduct',
    excerpt: 'UDF observers will report, not retaliate.',
    body:
      'The UDF instructs all observers and candidates to record irregularities on the official form, submit them to the ' +
      'district coordinator, and refrain from any confrontation at a polling station. No member may campaign within the ' +
      'prescribed perimeter, and no member may accept any inducement.',
    region: null,
    author: 'Office of the Secretary General',
    severity: null,
    service_area: null,
  },
  {
    kind: 'community_note',
    title: 'Street lights out on 4th Avenue for three weeks',
    excerpt: 'Residents report total darkness between the clinic and the school gate.',
    body:
      'Twelve poles along 4th Avenue are unlit. Two have been reported before with reference numbers but no attendance. ' +
      'The branch has photographed each pole number and will attach the register to the ward scorecard.',
    region: 'SOUTH',
    ward: '4',
    author: 'Ward 4 Branch',
    severity: 'urgent',
    service_area: 'power',
  },
  {
    kind: 'community_note',
    title: 'Refuse not collected in Ward 12 for two cycles',
    excerpt: 'Bags are being burned by residents — a health risk.',
    body:
      'Collection missed twice running. The branch requests a published route schedule and a contact number for the ' +
      'depot supervisor.',
    region: 'NORTH',
    ward: '12',
    author: 'Ward 12 Branch',
    severity: 'report',
    service_area: 'sanitation',
  },
  {
    kind: 'service_delivery',
    title: 'Q3 service-delivery scorecard: Eastern Region',
    excerpt: 'Water 71% · Power 64% · Roads 48% · Health 55% · Education 62%.',
    body:
      'The Eastern Region scorecard measures reported faults against published restoration times. Roads remain the ' +
      'weakest line item, driven by pothole backlogs in three districts. The full ward-level table is attached to the ' +
      'regional executive pack.',
    region: 'EAST',
    ward: null,
    author: 'Regional Monitoring Unit',
    severity: 'info',
    service_area: 'roads',
  },
  {
    kind: 'community_note',
    title: 'Unverified claim about a tender award',
    excerpt: 'Withdrawn pending verification.',
    body:
      'This note alleged irregularity in a municipal tender. The branch could not produce the tender number or the ' +
      'award document, and the claim has been taken down pending verification. Members are reminded that community ' +
      'notes must carry a reference number or a photograph.',
    region: 'WEST',
    ward: null,
    author: 'Ward 9 Branch',
    severity: 'report',
    service_area: 'other',
    takenDown: true,
  },
];

interface MemberLite {
  id: string;
  region_code: string | null;
  tier: string;
  membership_no: string | null;
}

async function seedEngage(): Promise<void> {
  // Every member gets a ward and a public QR code (needed by ID cards).
  await query(
    `UPDATE members
        SET ward = COALESCE(ward, (1 + (abs(hashtext(id::text)) % 20))::text),
            joined_at = COALESCE(joined_at, created_at)`,
  );
  const missing = await query<{ id: string }>(
    'SELECT id FROM members WHERE public_code IS NULL AND deleted_at IS NULL LIMIT 200',
  );
  for (const row of missing.rows) {
    let code = newPublicCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await query('UPDATE members SET public_code = $1 WHERE id = $2', [code, row.id]);
        break;
      } catch {
        code = newPublicCode();
      }
    }
  }
  if (missing.rowCount) logger.info({ count: missing.rowCount }, 'Assigned public QR codes');

  // ── Events ────────────────────────────────────────────────────
  const evCount = await query<{ c: string }>('SELECT count(*)::text AS c FROM events');
  if (Number(evCount.rows[0]?.c ?? 0) === 0) {
    for (const e of EVENT_SEED) {
      await query(
        `INSERT INTO events (title, kind, summary, region_code, ward, venue, starts_at, capacity, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          e.title,
          e.kind,
          e.summary,
          e.region,
          e.ward,
          e.venue,
          days(e.offset, e.kind === 'canvass' ? 7 : 10),
          e.capacity,
          e.offset < 0 ? 'done' : 'scheduled',
        ],
      );
    }
    logger.info({ count: EVENT_SEED.length }, 'Seeded events');
  }

  // ── Communications ────────────────────────────────────────────
  const postCount = await query<{ c: string }>('SELECT count(*)::text AS c FROM posts');
  if (Number(postCount.rows[0]?.c ?? 0) === 0) {
    for (const p of POST_SEED) {
      await query(
        `INSERT INTO posts (kind, title, excerpt, body, region_code, ward, author,
                            service_area, severity, status, take_down_reason, taken_down_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ${p.takenDown ? 'now()' : 'NULL'})`,
        [
          p.kind,
          p.title,
          p.excerpt,
          p.body,
          p.region,
          p.ward ?? null,
          p.author,
          p.service_area,
          p.severity,
          p.takenDown ? 'taken_down' : 'published',
          p.takenDown ? 'Claim could not be verified — no tender reference supplied' : null,
        ],
      );
    }
    logger.info({ count: POST_SEED.length }, 'Seeded communications');
  }

  // ── Appointments & mandates ───────────────────────────────────
  const apptCount = await query<{ c: string }>('SELECT count(*)::text AS c FROM appointments');
  const members = await query<MemberLite>(
    `SELECT id, region_code, tier, membership_no FROM members
      WHERE deleted_at IS NULL AND status = 'active'
      ORDER BY created_at LIMIT 12`,
  );
  const roster = members.rows;

  if (Number(apptCount.rows[0]?.c ?? 0) === 0 && roster.length >= 6) {
    const plan = [
      { idx: 0, position: 'WARD_CANDIDATE', ward: '12', status: 'confirmed' as const, by: 'Regional Executive Committee' },
      { idx: 1, position: 'WARD_CHAIR', ward: '7', status: 'confirmed' as const, by: 'Ward 7 Branch' },
      { idx: 2, position: 'MOBILIZER', ward: '4', status: 'proposed' as const, by: 'District Coordinator' },
      { idx: 3, position: 'COMMS_OFFICER', ward: null, status: 'confirmed' as const, by: 'Regional Secretariat' },
      { idx: 4, position: 'OBSERVER', ward: '9', status: 'proposed' as const, by: 'Election Task Team' },
      { idx: 5, position: 'BRANCH_SECRETARY', ward: '2', status: 'confirmed' as const, by: 'Ward 2 Branch' },
    ];

    for (const item of plan) {
      const m = roster[item.idx]!;
      const r = await query<{ id: string }>(
        `INSERT INTO appointments
           (member_id, position_code, title, region_code, ward, appointed_by,
            term_start, term_end, status, mandate_accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${item.status === 'confirmed' ? 'now()' : 'NULL'})
         RETURNING id`,
        [
          m.id,
          item.position,
          null,
          m.region_code,
          item.ward,
          item.by,
          dateOnly(-30),
          dateOnly(365 * 2),
          item.status,
        ],
      );
      // Every appointment carries a live mandate link so the flow is demoable.
      await issueToken({
        memberId: m.id,
        appointmentId: r.rows[0]!.id,
        kind: 'mandate',
        ttlDays: 30,
      });
    }
    logger.info({ count: plan.length }, 'Seeded appointments + mandate links');
  }

  // ── Notifications ─────────────────────────────────────────────
  const nCount = await query<{ c: string }>('SELECT count(*)::text AS c FROM notifications');
  if (Number(nCount.rows[0]?.c ?? 0) === 0) {
    await notify({
      kind: 'event',
      title: 'Organisers Webinar — Using the UDF App',
      body: 'Tomorrow 10:00 · Online',
      link: 'tab:engage#events',
    });
    await notify({
      kind: 'alert',
      title: 'Urgent community note: Ward 4 street lights',
      body: 'Twelve poles unlit for three weeks — escalate to the district engineer',
      link: 'tab:more#posts',
      regionCode: 'SOUTH',
    });
    await notify({
      kind: 'post',
      title: 'Press release issued',
      body: 'UDF demands published response times for water outages',
      link: 'tab:more#posts',
    });
    await notify({
      kind: 'appointment',
      title: 'Two mandates awaiting acceptance',
      body: 'Mobilizer (Ward 4) and Polling Station Observer (Ward 9)',
      link: 'tab:engage#appointments',
    });
    await notify({
      kind: 'member',
      title: 'New membership applications pending confirmation',
      body: 'Confirmation links were sent automatically on registration',
      link: 'tab:members',
    });
    logger.info('Seeded notifications');
  }
}

export { seedEngage };
