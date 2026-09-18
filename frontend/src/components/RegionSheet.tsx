'use client';

import { useEffect, useState } from 'react';
import { api, API_BASE } from '../lib/api';
import { TIER_COLORS, regionColor, wardColorForIndex } from '../lib/taxonomy';
import { srStatusHex, srStatusLabel } from '../lib/caseStatus';
import { Icon, Sheet } from './ui';
import type { RegionChild, RegionSummary } from '../types';

/**
 * The map's tap-a-shape sheet: one region, everything worth knowing about it.
 *
 * A subcouncil shows its wards (each with a councillor indicator, so an
 * organiser can see at a glance which wards are covered and which are vacant);
 * a ward shows the councillor's public profile and that ward's service-delivery
 * position. Both show member counts broken down by tier, and both offer a
 * `Back to <parent>` row that zooms out one level — the drill-down is a
 * hierarchy, so it has to be climbable in both directions.
 *
 * Everything here is the same PII-free aggregate the public transparency pages
 * publish. The councillor's photo comes from `GET /api/public/media/:id`, which
 * only answers for media attached to an `is_public` leader row, so no bearer
 * token is involved and nothing sealed can leak through this sheet.
 */

interface Props {
  code: string;
  geography?: string;
  /** The tier/status filters the map is drawing with, so the counts agree. */
  params?: Record<string, unknown>;
  /**
   * A summary the caller already holds, so this sheet renders it instead of
   * fetching `GET /api/geo/region-summary` (which a member would be refused —
   * they lack `geo:read`). The restricted member map passes the summary its own
   * `/api/geo/my-ward` call returned; when present, no fetch is made.
   */
  prefetched?: RegionSummary | null;
  /**
   * Member restricted mode (Wave 4): show ONLY the ward councillor and the
   * ward's service-delivery progress. Hides the parent "Back to" row, the
   * member/sub-area stat grid, the tier and status chips and the child drill
   * rows — a member's ward is the leaf, and member-count/tier analytics are not
   * theirs to see. Implies `prefetched` (there is nothing to fetch with).
   */
  restricted?: boolean;
  onClose: () => void;
  /** Zoom out to the parent and open its sheet. */
  onBack: (parentCode: string) => void;
  /** Zoom into a child and open its sheet. */
  onDrill: (code: string) => void;
}

const LEVEL_LABEL: Record<string, string> = {
  municipality: 'Municipality',
  region: 'Region',
  subcouncil: 'Subcouncil',
  ward: 'Ward',
  suburb: 'Suburb',
};

const CHILD_LEVEL: Record<string, string> = {
  municipality: 'region', region: 'subcouncil', subcouncil: 'ward', ward: 'suburb',
};
const CHILD_LABEL: Record<string, string> = {
  municipality: 'Municipalities', region: 'Regions', subcouncil: 'Subcouncils', ward: 'Wards', suburb: 'Suburbs',
};

const CONTACT_LABEL: Record<string, string> = {
  officePhone: 'Office',
  officeEmail: 'Email',
  clinicDay: 'Clinic day',
  wardOffice: 'Ward office',
};

/** `officePhone` → `Office phone`, for a contact key the map does not know. */
function prettyKey(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default function RegionSheet({
  code,
  geography,
  params,
  prefetched,
  restricted = false,
  onClose,
  onBack,
  onDrill,
}: Props) {
  const [fetched, setFetched] = useState<RegionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A prefetched summary (the restricted member map) is rendered as-is: the
  // caller already holds it and could not fetch `region-summary` anyway.
  const data = prefetched ?? fetched;

  useEffect(() => {
    if (prefetched) return;
    if (restricted) { setFetched(null); setError('Your ward summary is unavailable. Reopen the map to retry.'); return; }
    let cancelled = false;
    setFetched(null);
    setError(null);
    api
      .geoRegionSummary(code, params ?? {})
      .then((r) => !cancelled && setFetched(r))
      .catch((e: any) => !cancelled && setError(e?.message ?? 'Could not load this region'));
    return () => {
      cancelled = true;
    };
    // `params` is rebuilt on every render of the parent, so it is spread into
    // the key rather than depended on directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, prefetched, restricted, JSON.stringify(params ?? {})]);

  const tierRows = data ? Object.entries(data.counts.byTier).filter(([, n]) => n > 0) : [];
  const statusRows = data ? Object.entries(data.counts.byStatus).filter(([, n]) => n > 0) : [];
  const childLevel = data?.children[0]?.level ?? CHILD_LEVEL[data?.level ?? ''] ?? '';
  const childLabel = CHILD_LABEL[childLevel] ?? 'Sub-areas';

  /**
   * Legend colours (FR-R3): reproduce the map's per-area colour so each swatch
   * matches the shape it stands for. Wards are indexed within THIS subcouncil by
   * sorted code — the same order the map (`UdfStaticMap` / `taxonomy`) colours
   * them — so a swatch and its polygon cannot drift apart; subcouncils use the
   * same code hash the map does.
   */
  const wardColorByCode = new Map<string, string>();
  if (data) {
    data.children
      .filter((c) => c.level === 'ward')
      .map((c) => c.code)
      .sort()
      .forEach((code, i) => wardColorByCode.set(code, wardColorForIndex(i)));
  }
  const swatchOf = (c: RegionChild): string =>
    c.level === 'ward' ? wardColorByCode.get(c.code) ?? regionColor(c.code) : regionColor(c.code);

  return (
    <Sheet
      title={data?.name ?? LEVEL_LABEL[data?.level ?? ''] ?? 'Region'}
      subtitle={geography ?? (data ? `${LEVEL_LABEL[data.level] ?? data.level} · ${data.code}` : 'Loading…')}
      onClose={onClose}
    >
      {error && (
        <div className="banner err" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}

      {!data && !error && <div className="skeleton" style={{ height: 120 }} />}

      {data && (
        <>
          {/* Up one level. First in the body because a ward list can be long
              and the way out should never be below the fold. Hidden in
              restricted mode: a member's ward is the leaf, there is no parent
              to climb to. */}
          {!restricted && data.parentCode && (
            <div className="rows" style={{ marginBottom: 12 }}>
              <button className="row" onClick={() => onBack(data.parentCode!)}>
                <span className="row-ico">
                  <span className="flip-x">
                    <Icon name="chev" />
                  </span>
                </span>
                <span className="row-main">
                  <span className="row-title">Back to {data.parentName ?? data.parentCode}</span>
                  <span className="row-sub tiny">Zoom out one level</span>
                </span>
              </button>
            </div>
          )}

          {/* Member/sub-area counts are analytics a member does not get; the
              ward's own service-delivery grid (below, inside the ward block)
              is what the restricted sheet shows instead. */}
          {!restricted && (
            <div className="stat-grid">
              <div className="stat accent">
                <div className="num">{data.counts.total}</div>
                <div className="lbl">Members</div>
              </div>
              <div className="stat">
                <div className="num">{data.children.length}</div>
                <div className="lbl">{childLabel}</div>
              </div>
              {data.serviceDelivery && (
                <>
                  <div className="stat">
                    <div className="num">{data.serviceDelivery.open + data.serviceDelivery.inProgress}</div>
                    <div className="lbl">Open cases</div>
                  </div>
                  <div className={`stat ${data.serviceDelivery.slaBreached > 0 ? 'accent' : ''}`}>
                    <div className="num">{data.serviceDelivery.slaBreached}</div>
                    <div className="lbl">SLA breached</div>
                  </div>
                </>
              )}
            </div>
          )}

          {!restricted && tierRows.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 14 }}>Members by tier</div>
              <div className="chip-row">
                {tierRows.map(([tier, n]) => (
                  <span key={tier} className="chip" style={{ cursor: 'default' }}>
                    <span
                      className="swatch-dot"
                      style={{ background: TIER_COLORS[tier] ?? 'var(--line-strong)' }}
                    />
                    {tier} · {n}
                  </span>
                ))}
              </div>
            </>
          )}

          {!restricted && statusRows.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 12 }}>By status</div>
              <div className="chip-row">
                {statusRows.map(([status, n]) => (
                  <span key={status} className="chip" style={{ cursor: 'default' }}>
                    <span
                      className="swatch-dot"
                      style={{ background: srStatusHex(status) }}
                    />
                    {srStatusLabel(status)} · {n}
                  </span>
                ))}
              </div>
            </>
          )}

          {/* Ward: the councillor, then delivery. Subcouncils list their wards
              instead — the councillor belongs to the ward, not to the group. */}
          {data.ward && (
            <>
              <div className="section-label" style={{ marginTop: 14 }}>Ward councillor</div>
              {data.ward.vacant || !data.ward.councillor ? (
                <div className="banner">
                  <Icon name="flag" size={16} />
                  <span>This seat is currently vacant. Watch ward bulletins for updates.</span>
                </div>
              ) : (
                <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {data.ward.councillor.photoId && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="leader-photo"
                      src={`${API_BASE}/public/media/${data.ward.councillor.photoId}`}
                      alt={`${data.ward.councillor.fullName}, ward councillor`}
                    />
                  )}
                  <div className="leader-main">
                    <div className="leader-name">{data.ward.councillor.fullName}</div>
                    {!data.ward.councillor.bio && <p className="hint-text">Biography not published yet.</p>}
                    {data.ward.councillor.bio && (
                      <p className="hint-text" style={{ margin: '4px 0 0' }}>
                        {data.ward.councillor.bio}
                      </p>
                    )}
                    {Object.entries(data.ward.councillor.contactPublic ?? {}).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {Object.entries(data.ward.councillor.contactPublic).map(([k, v]) => (
                          <div className="kv" key={k}>
                            <span className="k">{CONTACT_LABEL[k] ?? prettyKey(k)}</span>
                            <span className="v">
                              {k.toLowerCase().includes('phone') ? (
                                <a href={`tel:${String(v)}`}>{String(v)}</a>
                              ) : k.toLowerCase().includes('email') ? (
                                <a href={`mailto:${String(v)}`}>{String(v)}</a>
                              ) : (
                                String(v)
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {data.serviceDelivery && (
                <>
                  <div className="section-label" style={{ marginTop: 14 }}>Service delivery</div>
                  <div className="stat-grid">
                    <div className="stat">
                      <div className="num">{data.serviceDelivery.open}</div>
                      <div className="lbl">Awaiting action</div>
                    </div>
                    <div className="stat">
                      <div className="num">{data.serviceDelivery.inProgress}</div>
                      <div className="lbl">In progress</div>
                    </div>
                    <div className="stat">
                      <div className="num">{data.serviceDelivery.resolved}</div>
                      <div className="lbl">Resolved</div>
                    </div>
                    <div className={`stat ${data.serviceDelivery.slaBreached > 0 ? 'accent' : ''}`}>
                      <div className="num">{data.serviceDelivery.slaBreached}</div>
                      <div className="lbl">Past SLA</div>
                    </div>
                  </div>
                  <Meter
                    value={data.serviceDelivery.resolved}
                    total={
                      data.serviceDelivery.resolved +
                      data.serviceDelivery.open +
                      data.serviceDelivery.inProgress
                    }
                    label="Resolved"
                  />
                </>
              )}

              {data.projects.length > 0 && (
                <>
                  <div className="section-label" style={{ marginTop: 14 }}>Projects</div>
                  <div className="rows">
                    {data.projects.map((p) => (
                      <div key={p.id} className="row" style={{ cursor: 'default' }}>
                        <span className="row-main">
                          <span className="row-title">{p.title}</span>
                          <span className="row-sub">{p.stage.replace(/_/g, ' ')}</span>
                          {p.progressPct !== null && (
                            <span className="meter">
                              <span className="meter-fill" style={{ width: `${p.progressPct}%` }} />
                            </span>
                          )}
                        </span>
                        <span className="badge">{p.progressPct !== null ? `${p.progressPct}%` : '—'}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {data.ward.patrols30d + data.ward.bulletins > 0 && (
                <div className="hint-text" style={{ marginTop: 10, textAlign: 'center' }}>
                  {data.ward.patrols30d} patrol{data.ward.patrols30d === 1 ? '' : 's'} in the last 30
                  days · {data.ward.bulletins} bulletin{data.ward.bulletins === 1 ? '' : 's'}
                  {data.ward.ratingMean !== null && ` · rated ${data.ward.ratingMean}/5`}
                </div>
              )}
            </>
          )}

          {/* Child drill rows: a member's ward is the leaf, so restricted mode
              never lists sub-areas to tap into. */}
          {!restricted && data.children.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 14 }}>
                {childLabel} — {childLevel === 'suburb' ? 'tap to view details' : 'colour matches the map · tap to drill in'}
              </div>
              <div className="rows">
                {data.children.map((c) => (
                  <button key={c.code} className="row" onClick={() => onDrill(c.code)}>
                    <span
                      className="row-ico"
                      style={{
                        background: c.members > 0 ? 'var(--red-tint)' : 'var(--paper)',
                        fontWeight: 900,
                        fontSize: 12,
                      }}
                    >
                      {c.members}
                    </span>
                    <span className="row-main">
                      <span className="row-title">
                        {/* Legend swatch: the exact colour this area is drawn in
                            on the map (FR-R3), so the list reads as a key. */}
                        <span
                          className="swatch-dot"
                          style={{ background: swatchOf(c), verticalAlign: 'middle', marginRight: 7 }}
                        />
                        {c.name}
                      </span>
                      <span className="row-sub tiny">
                        {c.councillor ? c.councillor.fullName : c.level === 'ward' ? 'Seat vacant' : c.code}
                      </span>
                    </span>
                    <Icon name="chev" size={16} />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

/** A resolved-share bar: one number, drawn, so it can be compared at a glance. */
function Meter({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="meter-head">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <span className="meter">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
