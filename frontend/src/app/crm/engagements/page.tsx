'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, dataReadError } from '../../../lib/api';
import type { ServiceRequest } from '../../../types';
import {
  CrmPageHeader, CrmTable, CrmBadge, CrmFilters, CrmPagination, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Engagements — full case lifecycle management.
 * Status flow: reported → triaged → logged → submitted → in_progress →
 * resolved → verified → closed.
 */

const LIFECYCLE = ['reported', 'triaged', 'logged', 'submitted', 'in_progress', 'resolved', 'verified', 'closed'];
const CATEGORIES = ['water', 'power', 'roads', 'sanitation', 'housing', 'safety', 'health', 'education', 'other'];
const LIMIT = 50;

/**
 * `useSearchParams` needs a Suspense boundary. This app is also built with
 * `output: 'export'` for the Capacitor bundle, where a page that reads the query
 * string without one fails the build outright rather than degrading — the same
 * pattern `/join`, `/confirm`, `/register` and `/v` already use.
 */
export default function CrmEngagements() {
  return (
    <Suspense fallback={<p style={{ color: '#64748b' }}>Loading cases…</p>}>
      <CrmEngagementsInner />
    </Suspense>
  );
}

function CrmEngagementsInner() {
  const searchParams = useSearchParams();
  const [cases, setCases] = useState<ServiceRequest[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  // Seeded from the URL so the top-bar search can land here already filtered
  // (D9): a result row deep-links as `?search=<ref no>`, which pins that case.
  const [filter, setFilter] = useState({
    ward: searchParams.get('ward') ?? '',
    status: searchParams.get('status') ?? '',
    category: searchParams.get('category') ?? '',
    search: searchParams.get('search') ?? '',
  });
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ServiceRequest | null>(null);
  const [exporting, setExporting] = useState(false);

  /**
   * One query builder, used by the list fetch *and* by the post-transition
   * refresh. That refresh used to rebuild a bare `{limit, offset}`, so advancing
   * a case's lifecycle silently threw away whatever the user had filtered on and
   * dropped them back into page one of the unfiltered register.
   */
  const params = useMemo(() => {
    const p: Record<string, string> = {
      limit: LIMIT.toString(),
      offset: (page * LIMIT).toString(),
    };
    if (filter.ward) p.ward = filter.ward;
    if (filter.status) p.status = filter.status;
    if (filter.category) p.category = filter.category;
    if (filter.search) p.search = filter.search;
    return p;
  }, [filter, page]);

  const requestKey = JSON.stringify([params, attempt]);
  const current = loadedKey === requestKey;
  const ready = current && !loading && !error && total !== null;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.crmEngagements(params).then((r) => {
      if (!active) return;
      setCases(r.items); setTotal(r.total); setLoadedKey(requestKey);
    }).catch((e: unknown) => {
      if (!active) return;
      setError(dataReadError(e)); setLoadedKey(requestKey);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [params, requestKey]);

  /**
   * Keep following the URL after mount. `useState` seeds once, so arriving here
   * with a *different* `?search=` while already on this screen — exactly what
   * the top-bar search does — would otherwise leave the stale term in the box
   * and the new one in the results.
   */
  const urlSearch = searchParams.get('search') ?? '';
  useEffect(() => {
    setFilter((f) => (f.search === urlSearch ? f : { ...f, search: urlSearch }));
    setPage(0);
  }, [urlSearch]);

  const transition = async (id: string, status: string) => {
    try {
      if (status === 'closed') {
        await api.closeServiceRequest(id, { closeReason: 'Closed from CRM' });
      } else {
        await api.updateServiceRequest(id, { status });
      }
      setDetail(null);
      // refresh
      setAttempt((n) => n + 1);
    } catch {
      alert('Status transition failed.');
    }
  };

  /**
   * Export the whole filtered set, not the visible page — the same defect the
   * Members screen had (D55): 50 rows serialised under a button labelled
   * "Export CSV", with nothing to show the register was truncated. `total` is
   * the server's own count of this filter, so it is the exact bound to fetch.
   */
  const exportCsv = async () => {
    if (exporting || !ready || total === null) return;
    setExporting(true);
    try {
      const all = await api.crmEngagements({
        ...params,
        limit: String(Math.max(total, 1)),
        offset: '0',
      });
      downloadCsv(
        'cases',
        ['Ref', 'Title', 'Ward', 'Category', 'Severity', 'Status', 'Created'],
        all.items.map((c) => [c.refNo ?? '', c.title ?? '', c.wardCode ?? '', c.category ?? '', c.severity ?? '', c.status ?? '', c.createdAt ?? '']),
      );
    } catch {
      alert('Export failed — the case register could not be read.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Cases"
        subtitle="Service delivery case register — full lifecycle management."
        actions={
          <CrmSmallButton onClick={exportCsv} disabled={exporting || !ready}>
            {exporting
              ? `Exporting ${total}…`
              : ready && total !== null && total > 0
                ? `Export CSV (${total})`
                : 'Export CSV'}
          </CrmSmallButton>
        }
      />

      <CrmFilters>
        <input
          type="text"
          placeholder="Search ref, title, ward, category…"
          value={filter.search}
          onChange={(e) => { setFilter({ ...filter, search: e.target.value }); setPage(0); }}
        />
        <select value={filter.status} onChange={(e) => { setFilter({ ...filter, status: e.target.value }); setPage(0); }}>
          <option value="">All Statuses</option>
          {LIFECYCLE.map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <select value={filter.category} onChange={(e) => { setFilter({ ...filter, category: e.target.value }); setPage(0); }}>
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by ward code…"
          value={filter.ward}
          onChange={(e) => { setFilter({ ...filter, ward: e.target.value }); setPage(0); }}
        />
      </CrmFilters>

      {!current || loading ? (
        <p style={{ color: '#64748b' }} role="status">Loading cases…</p>
      ) : error ? (
        <div role="alert"><p>{error}</p><CrmSmallButton onClick={() => setAttempt((n) => n + 1)}>Retry</CrmSmallButton></div>
      ) : (
        <CrmTable
          columns={['Ref No', 'Title', 'Ward', 'Category', 'Severity', 'Status', 'Created', '']}
          rows={cases.map((c) => [
            <code key="r">{c.refNo ?? '—'}</code>,
            c.title ?? '—',
            c.wardCode ?? '—',
            c.category ?? '—',
            c.severity ?? '—',
            <CrmBadge key="s" value={c.status} />,
            fmtDateTime(c.createdAt),
            <CrmSmallButton key="v" onClick={() => setDetail(c)}>Manage</CrmSmallButton>,
          ])}
          empty="No service requests match the current filters."
        />
      )}

      {ready && total !== null && <CrmPagination page={page} totalPages={Math.ceil(total / LIMIT)} total={total} onPage={setPage} />}

      {detail && (
        <CrmModal title={`Case ${detail.refNo ?? ''}`} onClose={() => setDetail(null)} wide>
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{detail.title}</h3>
            <p style={{ color: '#64748b', fontSize: 14, margin: 0 }}>{detail.description ?? 'No description.'}</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 14, marginBottom: 20 }}>
            <div><strong>Ward:</strong> {detail.wardCode ?? '—'}</div>
            <div><strong>Category:</strong> {detail.category}</div>
            <div><strong>Severity:</strong> {detail.severity}</div>
            <div><strong>Status:</strong> <CrmBadge value={detail.status} /></div>
            <div><strong>Created:</strong> {fmtDateTime(detail.createdAt)}</div>
            <div><strong>SLA due:</strong> {fmtDateTime((detail as any).slaDueAt)}</div>
          </div>

          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Advance lifecycle</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {LIFECYCLE.map((s) => (
              <CrmButton
                key={s}
                variant={s === detail.status ? 'primary' : 'secondary'}
                disabled={s === detail.status}
                onClick={() => transition(detail.id, s)}
              >
                {s.replace('_', ' ')}
              </CrmButton>
            ))}
          </div>
        </CrmModal>
      )}
    </div>
  );
}
