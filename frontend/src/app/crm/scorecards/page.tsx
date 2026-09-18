'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Perm, can } from '../../../lib/caps';
import {
  CrmBadge, CrmFilters, CrmModal, CrmPageHeader, CrmSmallButton, CrmStatGrid,
  CrmTable, downloadCsv, fmtDate,
} from '../../../components/crm/ui';
import type {
  ScorecardInbox, ScorecardInboxRow, ScorecardLowReasons, ScorecardSummary, ScorecardView,
} from '../../../types';

/**
 * CRM Scorecards — the councillor accountability rollups and the acknowledgement
 * workflow (PRD-growth FR-S6/S7/S8).
 *
 * Three server rollups over the caller's scope, fetched together:
 *  - `summary`     — per-category averages, the 1–5 distribution and counts.
 *  - `low-reasons` — the ≤2 queue: the compulsory 100-word complaints, which are
 *                    the actionable content a councillor/staff must respond to.
 *  - `inbox`       — each submitted card, so it can be viewed (submitted→viewed)
 *                    and acknowledged (→acknowledged), which notifies the member.
 *
 * Acknowledge is gated on `rating:acknowledge` (councillor + national only); the
 * page itself is gated on `rating:scorecard_read`, so an analyst/regional/coordinator
 * sees the rollups but not the Acknowledge control their role cannot exercise.
 *
 * HARD PRIVACY RULE (FR-S7, mirrors AC-O2): a card is attributed to a member only
 * as their PUBLIC CODE and only when they opted into `shareName`; otherwise the
 * row reads "Anonymous". No sealed name, email or phone number is ever fetched or
 * rendered here — the reasons are the point, not the author.
 */

/** The member label for a row: their public code when shared, else anonymous. */
function memberLabel(row: { shareName: boolean; memberPublicCode: string | null }): string {
  return row.shareName ? row.memberPublicCode ?? 'Shared' : 'Anonymous';
}

export default function CrmScorecards() {
  const { permissions } = useAuth();
  const canAck = can(permissions, Perm.RATING_ACKNOWLEDGE);

  const [summary, setSummary] = useState<ScorecardSummary | null>(null);
  const [inbox, setInbox] = useState<ScorecardInbox | null>(null);
  const [lowReasons, setLowReasons] = useState<ScorecardLowReasons | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters: period (YYYY-MM, blank = this month), ward (within scope), status.
  const [period, setPeriod] = useState('');
  const [ward, setWard] = useState('');
  const [status, setStatus] = useState('');

  // Acknowledgement modal state.
  const [selected, setSelected] = useState<ScorecardInboxRow | null>(null);
  const [detail, setDetail] = useState<ScorecardView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [ackNote, setAckNote] = useState('');
  const [ackBusy, setAckBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const base = { period: period || undefined, ward: ward || undefined };
    const withStatus = { ...base, status: status || undefined, limit: 200 };
    Promise.all([
      api.getScorecardSummary(base),
      api.getScorecardInbox(withStatus),
      api.getScorecardLowReasons(withStatus),
    ])
      .then(([s, i, l]) => {
        setSummary(s);
        setInbox(i);
        setLowReasons(l);
        setError(null);
      })
      .catch((e: { message?: string }) => {
        setSummary(null);
        setInbox(null);
        setLowReasons(null);
        setError(e?.message ?? 'Could not load the scorecards.');
      })
      .finally(() => setLoading(false));
  }, [period, ward, status]);

  useEffect(() => {
    load();
  }, [load]);

  // Opening a card marks it viewed (submitted→viewed) and loads its detail.
  function openCard(row: ScorecardInboxRow) {
    setSelected(row);
    setDetail(null);
    setAckNote('');
    setDetailLoading(true);
    api
      .viewScorecard(row.id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }

  async function acknowledge() {
    if (!selected || ackBusy) return;
    setAckBusy(true);
    try {
      const saved = await api.acknowledgeScorecard(selected.id, { note: ackNote.trim() || null });
      setDetail(saved);
      setSelected(null);
      load();
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Could not acknowledge that scorecard.');
    } finally {
      setAckBusy(false);
    }
  }

  function exportReasons() {
    if (!lowReasons) return;
    downloadCsv(
      'councillor-scorecard-reasons',
      ['Period', 'Ward', 'Category', 'Score', 'Member', 'Status', 'Reason'],
      lowReasons.rows.map((r) => [
        r.period,
        r.wardName ?? r.wardCode,
        r.label,
        r.score,
        memberLabel(r),
        r.status,
        r.reason ?? '',
      ]),
    );
  }

  const awaiting = inbox ? inbox.rows.filter((r) => r.status !== 'acknowledged').length : 0;
  const stats = summary
    ? [
        { label: 'Scorecards', value: summary.scorecards },
        { label: 'Overall average', value: summary.overallAverage ?? '—' },
        { label: 'Complaints (≤2)', value: lowReasons?.rows.length ?? 0, tone: 'warn' as const },
        { label: 'Awaiting acknowledgement', value: awaiting, tone: 'danger' as const },
      ]
    : [];

  const scope = summary?.scope ?? inbox?.scope ?? 'scoped';
  const shownPeriod = summary?.period ?? '';

  return (
    <div>
      <CrmPageHeader
        title="Scorecards"
        subtitle={`Monthly councillor performance${shownPeriod ? ` · ${shownPeriod.slice(0, 7)}` : ''} · scope: ${scope}.`}
        actions={<CrmSmallButton onClick={exportReasons} disabled={!lowReasons}>Export ≤2 reasons</CrmSmallButton>}
      />

      <CrmFilters>
        <input
          type="month"
          value={period}
          aria-label="Period (month)"
          onChange={(e) => setPeriod(e.target.value)}
        />
        <input
          type="text"
          value={ward}
          placeholder="Filter by ward code (e.g. CPT-W009)"
          onChange={(e) => setWard(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
        />
        <select value={status} aria-label="Status" onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="viewed">Viewed</option>
          <option value="acknowledged">Acknowledged</option>
        </select>
        <CrmSmallButton onClick={load}>Apply</CrmSmallButton>
        {(period || ward || status) && (
          <CrmSmallButton
            onClick={() => {
              setPeriod('');
              setWard('');
              setStatus('');
            }}
          >
            Clear
          </CrmSmallButton>
        )}
      </CrmFilters>

      {error && (
        <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#991b1b', fontWeight: 500 }}>{error}</p>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading scorecards…</p>
      ) : summary && inbox && lowReasons ? (
        <>
          <CrmStatGrid stats={stats} />

          <div style={{ padding: 16, background: '#f6f3f1', border: '1px solid #ece5e1', borderRadius: 8, marginBottom: 20 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#57534e' }}>
              <strong>Privacy note:</strong> a scorecard is attributed to a member only as their public reference and only
              when they chose to share it — otherwise it reads <strong>Anonymous</strong>. A score of 1–2 carries a
              compulsory 100-word reason; those complaints are the actionable queue below. Acknowledging a card notifies
              the member and freezes it for the month.
            </p>
          </div>

          {/* FR-S8: category rollups */}
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Category performance</h2>
          <CrmTable
            columns={['Category', 'Rated', 'Average', '★1', '★2', '★3', '★4', '★5', '≤2']}
            rows={summary.categories.map((c) => [
              <span key="c" style={{ fontWeight: 600 }}>{c.label}</span>,
              c.count,
              <strong key="a">{c.average ?? '—'}</strong>,
              c.distribution['1'] ?? 0,
              c.distribution['2'] ?? 0,
              c.distribution['3'] ?? 0,
              c.distribution['4'] ?? 0,
              c.distribution['5'] ?? 0,
              c.lowCount ? <span key="l" style={{ color: '#C8102E', fontWeight: 600 }}>{c.lowCount}</span> : 0,
            ])}
            empty="No categories rated in this period."
          />

          {/* FR-S8: the ≤2 reasons queue */}
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px' }}>Complaints requiring a response (≤2)</h2>
          <CrmTable
            columns={['Category', 'Score', 'Ward', 'Member', 'Status', 'Reason']}
            rows={lowReasons.rows.map((r, i) => [
              <span key="c" style={{ fontWeight: 600 }}>{r.label}</span>,
              <CrmBadge key="s" value={r.score <= 1 ? 'sla_breach' : 'pending'} />,
              r.wardName ?? <code key="w">{r.wardCode}</code>,
              memberLabel(r),
              <CrmBadge key="st" value={r.status} />,
              <span key="r" style={{ maxWidth: 460, display: 'inline-block', whiteSpace: 'pre-wrap' }}>{r.reason ?? '—'}</span>,
            ])}
            empty="No scores of 1–2 in this period — nothing needs a written response."
          />

          {/* FR-S6/S7: the acknowledgement inbox */}
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px' }}>Submissions</h2>
          <CrmTable
            columns={['Ward', 'Member', 'Average', '≤2', 'Status', 'Submitted', '']}
            rows={inbox.rows.map((r) => [
              r.wardName ?? <code key="w">{r.wardCode}</code>,
              memberLabel(r),
              r.average ?? '—',
              r.lowCount ? <span key="l" style={{ color: '#C8102E', fontWeight: 600 }}>{r.lowCount}</span> : 0,
              <CrmBadge key="s" value={r.status} />,
              fmtDate(r.submittedAt),
              <CrmSmallButton key="v" onClick={() => openCard(r)}>
                {r.status === 'acknowledged' ? 'View' : canAck ? 'View & acknowledge' : 'View'}
              </CrmSmallButton>,
            ])}
            empty="No scorecards submitted in this period."
          />
        </>
      ) : (
        !error && <p style={{ color: '#64748b' }}>Could not load the scorecards.</p>
      )}

      {selected && (
        <CrmModal
          wide
          title={`Scorecard · ${selected.wardName ?? selected.wardCode} · ${selected.period.slice(0, 7)}`}
          onClose={() => setSelected(null)}
        >
          {detailLoading ? (
            <p style={{ color: '#64748b' }}>Loading scorecard…</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, fontSize: 13, color: '#57534e' }}>
                <CrmBadge value={detail?.status ?? selected.status} />
                <span>Member: <strong>{memberLabel(selected)}</strong></span>
                <span>Average: <strong>{selected.average ?? '—'}</strong></span>
                <span>Complaints (≤2): <strong>{selected.lowCount}</strong></span>
                <span>Submitted: {fmtDate(selected.submittedAt)}</span>
              </div>

              <CrmTable
                columns={['Category', 'Score', 'Reason']}
                rows={(detail?.items ?? selected.items).map((it) => [
                  <span key="c" style={{ fontWeight: 600 }}>{categoryLabel(summary, it.category)}</span>,
                  <CrmBadge key="s" value={it.score <= 2 ? 'sla_breach' : 'accepted'} />,
                  <span key="r" style={{ maxWidth: 460, display: 'inline-block', whiteSpace: 'pre-wrap' }}>{it.reason ?? '—'}</span>,
                ])}
                empty="No categories on this scorecard."
              />

              {(detail?.status ?? selected.status) === 'acknowledged' ? (
                <div style={{ marginTop: 16, padding: 14, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
                  <p style={{ margin: 0, fontSize: 13, color: '#166534' }}>
                    <strong>Acknowledged</strong> {detail?.ackAt ? `on ${fmtDate(detail.ackAt)}` : ''}
                    {detail?.ackNote ? ` — “${detail.ackNote}”` : '.'} The member has been notified and this month is frozen.
                  </p>
                </div>
              ) : canAck ? (
                <div style={{ marginTop: 16 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#8a817b', marginBottom: 6 }}>
                    Acknowledgement note (optional, sent to the member)
                  </label>
                  <textarea
                    value={ackNote}
                    onChange={(e) => setAckNote(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Thank the member and say what happens next…"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #ece5e1', borderRadius: 6, fontSize: 14, fontFamily: 'inherit' }}
                  />
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    <CrmSmallButton onClick={acknowledge} disabled={ackBusy}>
                      {ackBusy ? 'Acknowledging…' : 'Acknowledge & notify member'}
                    </CrmSmallButton>
                    <CrmSmallButton onClick={() => setSelected(null)}>Close</CrmSmallButton>
                  </div>
                </div>
              ) : (
                <p style={{ marginTop: 16, fontSize: 13, color: '#8a817b' }}>
                  Your role can review scorecards but not acknowledge them — acknowledgement is reserved for the ward
                  councillor and national admin.
                </p>
              )}
            </>
          )}
        </CrmModal>
      )}
    </div>
  );
}

/** Best label for a category code, from the summary's taxonomy if present. */
function categoryLabel(summary: ScorecardSummary | null, code: string): string {
  return summary?.categories.find((c) => c.category === code)?.label ?? code.replace(/_/g, ' ');
}
