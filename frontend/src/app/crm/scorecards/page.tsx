'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Perm, can } from '../../../lib/caps';
import {
  CrmBadge, CrmCard, CrmFilters, CrmModal, CrmPageHeader, CrmSmallButton, CrmStatGrid,
  CrmTable, downloadCsv, fmtDate,
} from '../../../components/crm/ui';
import type {
  ScorecardInboxRow, ScorecardPageMeta, ScorecardStatus, ScorecardSummary, ScorecardView,
} from '../../../types';

const LIMIT = 100;

/** The member label never reveals an identity without the saved opt-in. */
function memberLabel(row: { shareName: boolean; memberPublicCode: string | null }): string {
  return row.shareName ? row.memberPublicCode ?? 'Shared' : 'Anonymous';
}

/** Each panel owns its request, retry and generation. A changed key hides old data immediately. */
function usePanel<T>(key: string | null, read: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string | null; attempt: number; data: T | null; error: string | null; loading: boolean }>({
    key: null, attempt: 0, data: null, error: null, loading: true,
  });
  useEffect(() => {
    let active = true;
    setState({ key, attempt, data: null, error: null, loading: true });
    if (key !== null) {
      read().then((data) => {
        if (active) setState({ key, attempt, data, error: null, loading: false });
      }).catch((error: unknown) => {
        if (active) setState({ key, attempt, data: null, error: dataReadError(error), loading: false });
      });
    }
    return () => { active = false; };
  }, [key, attempt, read]);
  const current = state.key === key && state.attempt === attempt;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !current || state.loading,
    retry: () => setAttempt((n) => n + 1),
  };
}

function PanelStatus({ loading, error, asOf, retry }: { loading: boolean; error: string | null; asOf?: string; retry: () => void }) {
  return <div style={{ marginBottom: 12, fontSize: 13 }} aria-live="polite">
    {loading ? <p>Loading…</p> : error ? <p role="alert">{error}</p> : asOf ?
      <p>Last successful fetch · database as of <time dateTime={asOf}>{asOf}</time></p> : null}
    <CrmSmallButton onClick={retry} disabled={loading}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
  </div>;
}

function PageControls({ data, onOffset }: { data: ScorecardPageMeta; onOffset: (offset: number) => void }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
    <span>{data.total.toLocaleString()} matching records · page {Math.floor(data.offset / data.limit) + 1}</span>
    <CrmSmallButton disabled={data.offset === 0} onClick={() => onOffset(Math.max(0, data.offset - data.limit))}>Previous</CrmSmallButton>
    <CrmSmallButton disabled={!data.hasMore} onClick={() => onOffset(data.offset + data.limit)}>Next</CrmSmallButton>
  </div>;
}

export default function CrmScorecards() {
  const { permissions } = useAuth();
  const canAck = can(permissions, Perm.RATING_ACKNOWLEDGE);
  const [serverPeriod, setServerPeriod] = useState<string | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [periodAttempt, setPeriodAttempt] = useState(0);
  const [period, setPeriod] = useState('');
  const [ward, setWard] = useState('');
  const [status, setStatus] = useState<ScorecardStatus | ''>('');
  const [inboxOffset, setInboxOffset] = useState(0);
  const [reasonOffset, setReasonOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const refreshPanels = useCallback(() => setRefresh((n) => n + 1), []);

  // Resolve the database's current month once, never the browser's clock. Every
  // displayed panel then requests the same explicit month, even across midnight.
  useEffect(() => {
    let active = true;
    setPeriodError(null);
    api.getScorecardSummary().then((data) => {
      if (active) setServerPeriod(data.period.slice(0, 7));
    }).catch((error: unknown) => { if (active) setPeriodError(dataReadError(error)); });
    return () => { active = false; };
  }, [periodAttempt]);

  const resolvedPeriod = period || serverPeriod;
  const filterKey = resolvedPeriod ? JSON.stringify([resolvedPeriod, ward.trim(), status, refresh]) : null;
  const readSummary = useCallback(() => api.getScorecardSummary({
    period: resolvedPeriod!, ward: ward.trim() || undefined, status: status || undefined,
  }), [resolvedPeriod, ward, status]);
  const readInbox = useCallback(() => api.getScorecardInbox({
    period: resolvedPeriod!, ward: ward.trim() || undefined, status: status || undefined, limit: LIMIT, offset: inboxOffset,
  }), [resolvedPeriod, ward, status, inboxOffset]);
  const readReasons = useCallback(() => api.getScorecardLowReasons({
    period: resolvedPeriod!, ward: ward.trim() || undefined, status: status || undefined, limit: LIMIT, offset: reasonOffset,
  }), [resolvedPeriod, ward, status, reasonOffset]);
  const summaryPanel = usePanel(filterKey, readSummary);
  const inboxPanel = usePanel(filterKey === null ? null : `${filterKey}:${inboxOffset}`, readInbox);
  const reasonsPanel = usePanel(filterKey === null ? null : `${filterKey}:${reasonOffset}`, readReasons);
  const summary = summaryPanel.data;
  const inbox = inboxPanel.data;
  const lowReasons = reasonsPanel.data;

  const [selected, setSelected] = useState<ScorecardInboxRow | null>(null);
  const [detail, setDetail] = useState<ScorecardView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState('');
  const [ackBusy, setAckBusy] = useState(false);
  const detailGeneration = useRef(0);
  useEffect(() => () => { detailGeneration.current++; }, []);

  function closeCard() { detailGeneration.current++; setSelected(null); setDetail(null); }
  function filtersChanged() { setInboxOffset(0); setReasonOffset(0); closeCard(); }
  async function openCard(row: ScorecardInboxRow) {
    const generation = ++detailGeneration.current;
    setSelected(row); setDetail(null); setDetailError(null); setAckNote(''); setDetailLoading(true);
    try {
      const value = await api.viewScorecard(row.id);
      if (generation === detailGeneration.current) setDetail(value);
    } catch (error) {
      if (generation === detailGeneration.current) setDetailError(dataReadError(error));
    } finally {
      // A lost response can still have marked the card viewed on the server.
      refreshPanels();
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }
  async function acknowledge() {
    if (!selected || !detail || detail.status === 'acknowledged' || ackBusy) return;
    const generation = detailGeneration.current;
    setAckBusy(true); setDetailError(null);
    try {
      await api.acknowledgeScorecard(selected.id, { note: ackNote.trim() || null });
      if (generation === detailGeneration.current) closeCard();
    } catch (error) {
      if (generation === detailGeneration.current) { setDetail(null); setDetailError(dataReadError(error)); }
    } finally {
      setAckBusy(false); refreshPanels();
    }
  }
  function exportReasons() {
    if (!lowReasons) return;
    downloadCsv('councillor-scorecard-reasons-current-page',
      ['Period', 'Ward', 'Category', 'Score', 'Member', 'Status', 'Reason'],
      lowReasons.rows.map((r) => [r.period, r.wardName ?? r.wardCode, r.label, r.score, memberLabel(r), r.status, r.reason ?? '']));
  }

  return <div>
    <CrmPageHeader title="Scorecards"
      subtitle={`Private monthly councillor feedback${resolvedPeriod ? ` · ${resolvedPeriod}` : ''}. Separate from legacy ratings and service-case performance.`}
      actions={<CrmSmallButton onClick={exportReasons} disabled={!lowReasons}>Export ≤2 reasons · current page</CrmSmallButton>} />
    <CrmFilters>
      <input type="month" value={period} aria-label="Period (month)" onChange={(e) => { setPeriod(e.target.value); filtersChanged(); }} />
      <input type="text" value={ward} maxLength={32} aria-label="Ward code" placeholder="Ward code (e.g. CPT-W009)"
        onChange={(e) => { setWard(e.target.value); filtersChanged(); }} />
      <select value={status} aria-label="Status" onChange={(e) => {
        const next = e.target.value;
        setStatus(next === 'submitted' || next === 'viewed' || next === 'acknowledged' ? next : ''); filtersChanged();
      }}>
        <option value="">All statuses</option><option value="submitted">Submitted</option>
        <option value="viewed">Viewed</option><option value="acknowledged">Acknowledged</option>
      </select>
      <CrmSmallButton onClick={refreshPanels}>Refresh all</CrmSmallButton>
      <CrmSmallButton onClick={() => { setPeriod(''); setWard(''); setStatus(''); filtersChanged(); }}>Clear filters</CrmSmallButton>
    </CrmFilters>
    <p style={{ fontSize: 13, color: '#57534e' }}>Only an opted-in public membership reference is shown; otherwise feedback is anonymous.
      Acknowledgement notifies the member and freezes the card for the month. Each panel has its own database snapshot.</p>
    {!resolvedPeriod ? <CrmCard title="Resolve current month">
      <p role={periodError ? 'alert' : 'status'}>{periodError ?? 'Loading the server’s current month…'}</p>
      {periodError && <CrmSmallButton onClick={() => setPeriodAttempt((n) => n + 1)}>Retry</CrmSmallButton>}
    </CrmCard> : <>
      <CrmCard title="Monthly summary · all matching cards">
        <PanelStatus {...summaryPanel} asOf={summary?.asOf} />
        {summary && <>
          <CrmStatGrid stats={[
            { label: 'Scorecards', value: summary.scorecards },
            { label: 'Scored items', value: summary.itemCount },
            { label: 'Overall average / 5', value: summary.overallAverage ?? 'Unrated' },
            { label: 'Low-score items (≤2)', value: summary.lowScoreItems, tone: 'warn' },
            { label: 'Cards with a low score', value: summary.lowScorecards },
            { label: 'Awaiting acknowledgement', value: summary.awaitingAcknowledgement },
          ]} />
          {summary.scorecards === 0 && <p>No scorecards match these filters.</p>}
          <p style={{ fontSize: 12 }}>Current category labels and order; inactive categories remain when represented in submissions.</p>
          <CrmTable columns={['Category', 'Rated', 'Average / 5', '1', '2', '3', '4', '5', '≤2']}
            rows={summary.categories.map((c) => [
              `${c.label}${c.active ? '' : ' (inactive)'}`, c.count, c.average ?? 'Unrated',
              c.distribution['1'], c.distribution['2'], c.distribution['3'], c.distribution['4'], c.distribution['5'], c.lowCount,
            ])} empty="No categories in this period." />
        </>}
      </CrmCard>
      <CrmCard title="Low-score reasons · individual category items (≤2)">
        <PanelStatus {...reasonsPanel} asOf={lowReasons?.asOf} />
        {lowReasons && <>
          <CrmTable columns={['Category', 'Score / 5', 'Ward', 'Member', 'Status', 'Reason']}
            rows={lowReasons.rows.map((r) => [r.label,
              <strong key="score" style={{ color: '#991b1b', fontVariantNumeric: 'tabular-nums' }}>{r.score} / 5</strong>,
              r.wardName ?? r.wardCode, memberLabel(r), <CrmBadge key="status" value={r.status} />,
              <span key="reason" style={{ maxWidth: 460, display: 'inline-block', whiteSpace: 'pre-wrap' }}>{r.reason ?? '—'}</span>,
            ])} empty={lowReasons.total === 0 ? 'No scores of 1–2 match these filters.' : 'No items on this page. Return to the previous page or refresh.'} />
          <PageControls data={lowReasons} onOffset={setReasonOffset} />
        </>}
      </CrmCard>
      <CrmCard title="Submissions · distinct scorecards">
        <PanelStatus {...inboxPanel} asOf={inbox?.asOf} />
        {inbox && <>
          <CrmTable columns={['Ward', 'Member', 'Average / 5', '≤2 items', 'Status', 'Submitted', 'Action']}
            rows={inbox.rows.map((r) => [r.wardName ?? r.wardCode, memberLabel(r), r.average ?? 'Unrated', r.lowCount,
              <CrmBadge key="status" value={r.status} />, fmtDate(r.submittedAt),
              <CrmSmallButton key="view" onClick={() => openCard(r)}>{r.status === 'acknowledged' || !canAck ? 'View' : 'View & acknowledge'}</CrmSmallButton>,
            ])} empty={inbox.total === 0 ? 'No scorecards match these filters.' : 'No cards on this page. Return to the previous page or refresh.'} />
          <PageControls data={inbox} onOffset={setInboxOffset} />
        </>}
      </CrmCard>
    </>}
    {selected && <CrmModal wide title={`Scorecard · ${selected.wardName ?? selected.wardCode} · ${selected.period.slice(0, 7)}`}
      onClose={() => { if (!ackBusy) closeCard(); }}>
      {detailLoading ? <p>Loading scorecard…</p> : detailError ? <div role="alert">
        <p>{detailError}</p><CrmSmallButton onClick={() => openCard(selected)}>Retry detail</CrmSmallButton>
      </div> : detail && <>
        <p><CrmBadge value={detail.status} /> · Member: {memberLabel({ shareName: detail.shareName, memberPublicCode: selected.shareName ? selected.memberPublicCode : null })}</p>
        <CrmTable columns={['Category', 'Score / 5', 'Reason']} rows={detail.items.map((item) => [
          categoryLabel(summary, item.category),
          <strong key="score" style={{ fontVariantNumeric: 'tabular-nums', color: item.score <= 2 ? '#991b1b' : '#166534' }}>{item.score} / 5</strong>,
          <span key="reason" style={{ whiteSpace: 'pre-wrap' }}>{item.reason ?? '—'}</span>,
        ])} empty="No scored categories on this card." />
        {detail.status === 'acknowledged' ? <p>Acknowledged {detail.ackAt ? fmtDate(detail.ackAt) : ''}.
          {detail.ackNote && ` ${detail.ackNote}`} This month is frozen.</p> : canAck ? <div style={{ marginTop: 16 }}>
          <label htmlFor="scorecard-ack-note">Acknowledgement note (optional, sent to the member)</label>
          <textarea id="scorecard-ack-note" value={ackNote} onChange={(e) => setAckNote(e.target.value)} rows={3} maxLength={1000}
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', fontFamily: 'inherit' }} />
          <CrmSmallButton onClick={acknowledge} disabled={ackBusy}>{ackBusy ? 'Acknowledging…' : 'Acknowledge & notify member'}</CrmSmallButton>
        </div> : <p>Your account can review these scorecards but cannot acknowledge them.</p>}
      </>}
    </CrmModal>}
  </div>;
}

function categoryLabel(summary: ScorecardSummary | null, code: string): string {
  return summary?.categories.find((c) => c.category === code)?.label ?? code;
}
