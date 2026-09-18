'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmSmallButton, CrmCard,
  downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';
import type { ResidentReport } from '../../../types';
import ReportWorkflowPanel from '../../../components/ReportWorkflowPanel';

/** The lifecycle a report can be moved through, in order. */
const AWAITING_CONFIRMATION = 'resolved';

/**
 * CRM Resident Reports — the staff inbox of reports residents/members send to
 * their ward councillor (transparency module `resident_reports`).
 *
 * This is the desktop counterpart of the mobile Engage → Report tile. The list
 * is `?scope=inbox`, which the server scopes to the caller's territory: a
 * national_admin sees every report, a regional_organizer/local_coordinator the
 * wards under their regions, a ward_councillor exactly their ward. Gated on
 * `report:read` (the `reports` module), so a role without it never sees the nav
 * entry and a direct URL 403s rather than rendering an empty inbox.
 */
export default function CrmResidentReports() {
  const [items, setItems] = useState<ResidentReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<ResidentReport | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError('');
    api
      .allResidentReports('inbox')
      .then((r) => setItems(r.items ?? []))
      .catch(() => setLoadError('Could not load report data. Totals are unavailable.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const open = async (id: string) => {
    if (selected?.id === id) {
      setSelected(null);
      return;
    }
    setOpeningId(id);
    try {
      setSelected(await api.residentReport(id));
    } catch {
      setSelected(null);
      alert('Could not open that report.');
    } finally {
      setOpeningId(null);
    }
  };

  // Merge a freshly-saved report back into both the open card and the list row.
  const applyUpdate = (updated: ResidentReport) => {
    setSelected(updated);
    setItems((prev) => prev.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)));
  };

  const counts = {
    open: items.filter((i) => i.status !== 'resolved' && i.status !== 'closed').length,
    inProgress: items.filter((i) => i.status === 'in_progress').length,
    closed: items.filter((i) => i.status === 'closed').length,
    awaiting: items.filter((i) => i.status === AWAITING_CONFIRMATION).length,
    withMedia: items.filter((i) => i.media.length > 0).length,
  };

  const truncate = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

  return (
    <div>
      <CrmPageHeader
        title="Resident Reports"
        subtitle="Reports residents and members send to their ward councillor. Scoped to your territory — a national view shows every ward."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'resident-reports',
                ['Ref No', 'Category', 'Ward', 'Status', 'Message', 'Attachments', 'Received'],
                items.map((i) => [
                  i.refNo ?? '',
                  i.category ?? '',
                  i.wardCode ?? '',
                  i.status ?? '',
                  i.message ?? '',
                  String(i.media.length),
                  i.createdAt ?? '',
                ]),
              )
            }
          >
            Export CSV
          </CrmSmallButton>
        }
      />

      {loadError && <p role="alert">{loadError} <button onClick={load}>Retry</button></p>}
      {!loadError && !loading && <CrmStatGrid
        stats={[
          { label: 'Open', value: counts.open, tone: 'warn' },
          { label: 'In Progress', value: counts.inProgress },
          { label: 'Awaiting confirmation', value: counts.awaiting },
          { label: 'Completed', value: counts.closed, tone: 'success' },
          { label: 'With Attachments', value: counts.withMedia },
        ]}
      />}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading resident reports…</p>
      ) : (
        <CrmTable
          columns={['Ref No', 'Category', 'Ward', 'Message', 'Attached', 'Status', 'Received', '']}
          rows={items.map((i) => [
            <code key="r">{i.refNo ?? '—'}</code>,
            i.category ?? '—',
            i.wardCode ?? '—',
            <span key="m" title={i.message}>{truncate(i.message)}</span>,
            i.media.length ? `${i.media.length}` : '—',
            <CrmBadge key="s" value={i.status} />,
            fmtDateTime(i.createdAt),
            <span key="a">
              <CrmSmallButton onClick={() => open(i.id)} disabled={openingId === i.id}>
                {selected?.id === i.id ? 'Hide' : openingId === i.id ? '…' : 'View'}
              </CrmSmallButton>
            </span>,
          ])}
          empty="No resident reports in your territory yet."
        />
      )}

      {selected && <CrmCard title={`${selected.category} · ${selected.refNo}`}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{selected.message}</p>
        <ReportWorkflowPanel key={selected.id} report={selected} onUpdated={applyUpdate} />
      </CrmCard>}
    </div>
  );
}

/**
 * The staff working view of one report: the resident's message + attachments,
 * a status selector, and a feedback box that writes follow-up back to the
 * resident (they see it in their own "my reports" view and get notified).
 */
// Desktop and mobile use the same permission-aware workflow panel.
