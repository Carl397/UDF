'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import type { ActivityModuleStats, Patrol, PatrolStop } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal,
  CrmSmallButton, CrmButton, CrmField, CrmFilters, CrmMediaThumb,
  downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Patrols — oversight of councillor ward patrols (walkabouts,
 * site inspections). Full CRUD: create a patrol, view its report (summary,
 * call log and attachments), edit its details/status, and delete it.
 */

const PATROL_STATUSES = ['planned', 'active', 'completed', 'cancelled'];
const TRANSITIONS: Record<string, string[]> = { planned: ['active', 'cancelled'], active: ['completed', 'cancelled'], completed: [], cancelled: [] };
const PAGE_SIZE = 50;

export default function CrmPatrols() {
  const { permissions } = useAuth();
  const canWrite = can(permissions, Perm.PATROL_WRITE);
  const [items, setItems] = useState<Patrol[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<Patrol | null>(null);
  const [editing, setEditing] = useState<Patrol | null>(null);
  const [creating, setCreating] = useState(false);

  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<ActivityModuleStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [reload, setReload] = useState(0);
  const load = () => setReload((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.listPatrols({ limit: String(PAGE_SIZE), offset: String(offset), status })
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setTotal(r.total);
        if (offset > 0 && offset >= r.total) setOffset(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1) * PAGE_SIZE);
      })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Could not load patrols.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [offset, status, reload]);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setStatsError('');
    api.patrolStats()
      .then((r) => { if (!cancelled) setStats(r); })
      .catch(() => { if (!cancelled) setStatsError('Could not load patrol totals.'); });
    return () => { cancelled = true; };
  }, [reload]);

  const remove = async (p: Patrol) => {
    if (!window.confirm(`Delete this patrol${p.wardCode ? ` in ${p.wardCode}` : ''}? This also removes its GPS track, call log and attachments.`)) {
      return;
    }
    try {
      await api.deletePatrol(p.id);
      load();
      if (detail?.id === p.id) setDetail(null);
    } catch {
      alert('Could not delete that patrol.');
    }
  };

  const statusCount = (name: string) => stats ? stats.byStatus.find((s) => s.label === name)?.value ?? 0 : '—';

  return (
    <div>
      <CrmPageHeader
        title="Councillor Patrols"
        subtitle="Ward walkabouts and site inspections logged by councillors."
        actions={canWrite ? <CrmButton onClick={() => setCreating(true)}>New patrol</CrmButton> : undefined}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Patrols', value: stats?.total ?? '—' },
          { label: 'Active', value: statusCount('active'), tone: 'success' },
          { label: 'Completed', value: statusCount('completed') },
          { label: 'Recorded distance (30 days)', value: stats?.distanceM30d == null ? '—' : `${(stats.distanceM30d / 1000).toFixed(2)} km` },
        ]}
      />

      {statsError && <p role="alert">{statsError} <CrmSmallButton onClick={load}>Retry</CrmSmallButton></p>}
      {stats && <p style={{ color: '#64748b', fontSize: 13 }}>Totals cover your full authorized scope. Completed patrols with unknown distance (30 days): {stats.unknownDistance30d ?? 0}. Outstanding calls: {stats.outstandingStops ?? 0}.</p>}
      <CrmFilters>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All statuses</option>
          {PATROL_STATUSES.map((s) => (
            <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <CrmSmallButton
          disabled={loading || !!error || !items.length}
          onClick={() =>
            downloadCsv(
              'patrols',
              ['Ward', 'Mode', 'Purpose', 'Status', 'Started', 'Ended', 'Distance (m)'],
              items.map((i) => [i.wardCode ?? '', i.mode ?? '', i.purpose ?? '', i.status, i.startedAt ?? '', i.endedAt ?? '', i.distanceM ?? '']),
            )
          }
        >
          Export this page
        </CrmSmallButton>
      </CrmFilters>

      {error && <p role="alert">{error} <CrmSmallButton onClick={load}>Retry</CrmSmallButton></p>}
      {loading ? (
        <p style={{ color: '#64748b' }}>Loading patrols…</p>
      ) : error ? null : (
        <CrmTable
          columns={['Ward', 'Mode', 'Purpose', 'Distance', 'Started', 'Status', 'Files', '']}
          rows={items.map((p) => [
            p.wardCode ?? '—',
            <CrmBadge key="m" value={p.mode ?? '—'} />,
            <span key="pu" style={{ fontSize: 13 }}>{(p.purpose ?? '—').slice(0, 50)}</span>,
            p.distanceM != null ? `${(p.distanceM / 1000).toFixed(2)} km` : 'Unknown',
            <span key="st" style={{ fontSize: 13 }}>{fmtDateTime(p.startedAt)}</span>,
            p.status === 'active'
              ? <span key="s" style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, color: '#15803d', background: '#15803d18' }}>● Live</span>
              : <CrmBadge key="s" value={p.status} />,
            p.mediaCount ? `${p.mediaCount}` : '—',
            <span key="v" style={{ display: 'inline-flex', gap: 6 }}>
              <CrmSmallButton onClick={() => setDetail(p)}>View</CrmSmallButton>
              {canWrite && <CrmSmallButton onClick={() => setEditing(p)}>Edit</CrmSmallButton>}
              {canWrite && <CrmSmallButton danger onClick={() => remove(p)}>Delete</CrmSmallButton>}
            </span>,
          ])}
          empty="No patrols logged."
        />
      )}

      {!error && <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <CrmSmallButton disabled={loading || offset === 0} onClick={() => setOffset((n) => Math.max(0, n - PAGE_SIZE))}>Previous</CrmSmallButton>
        <span>{loading ? 'Loading…' : `${total ? offset + 1 : 0}–${Math.min(offset + items.length, total)} of ${total}`}</span>
        <CrmSmallButton disabled={loading || offset + items.length >= total} onClick={() => setOffset((n) => n + PAGE_SIZE)}>Next</CrmSmallButton>
      </div>}
      {detail && (
        <PatrolDetailModal
          patrol={detail}
          onClose={() => setDetail(null)}
          onEdit={canWrite ? (p) => { setEditing(p); setDetail(null); } : undefined}
          canWrite={canWrite}
          onUpdated={load}
        />
      )}
      {editing && (
        <PatrolFormModal
          patrol={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {creating && (
        <PatrolFormModal
          patrol={null}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

const CALL_STATUS_LABELS: Record<string, string> = {
  call_logged: 'Call Logged',
  in_progress: 'In Progress',
  waiting_on_feedback: 'Waiting on Feedback',
  completed: 'Completed',
};

function PatrolDetailModal({ patrol, onClose, onEdit, canWrite, onUpdated }: { patrol: Patrol; onClose: () => void; onEdit?: (p: Patrol) => void; canWrite: boolean; onUpdated: () => void }) {
  const [full, setFull] = useState<Patrol>(patrol);
  const [stops, setStops] = useState<PatrolStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // Refetch the single patrol so we get its report attachments (`media`),
    // which the list projection omits.
    let cancelled = false;
    setStopsLoading(true);
    setError('');
    Promise.all([api.getPatrol(patrol.id), api.listPatrolStops(patrol.id)])
      .then(([detail, r]) => { if (!cancelled) { setFull(detail); setStops(r.items); } })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Could not load patrol details.'); })
      .finally(() => { if (!cancelled) setStopsLoading(false); });
    return () => { cancelled = true; };
  }, [patrol.id, reload]);

  const media = full.media ?? [];

  return (
    <CrmModal title="Patrol Detail" onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <div><strong>Status:</strong> <CrmBadge value={full.status} /></div>
        <div><strong>Mode:</strong> <CrmBadge value={full.mode ?? '—'} /></div>
        <div><strong>Ward:</strong> {full.wardCode ?? '—'}</div>
        <div><strong>Distance:</strong> {full.distanceM != null ? `${(full.distanceM / 1000).toFixed(2)} km (${full.distanceSource ?? 'source unknown'})` : 'Unknown'}</div>
        <div><strong>Started:</strong> {fmtDateTime(full.startedAt)}</div>
        <div><strong>Ended:</strong> {fmtDateTime(full.endedAt)}</div>
      </div>
      {full.purpose && <p><strong>Purpose:</strong> {full.purpose}</p>}
      {full.summary && <p style={{ whiteSpace: 'pre-wrap', color: '#374151' }}><strong>Summary:</strong><br />{full.summary}</p>}

      {full.wardEntries && full.wardEntries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Wards walked ({full.wardEntries.length})</strong>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {full.wardEntries.map((w) => (
              <span
                key={w.wardCode}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                  borderRadius: 10, fontSize: 12,
                  color: w.crossing ? '#b45309' : '#15803d',
                  background: w.crossing ? '#b4530918' : '#15803d18',
                }}
                title={`First ${fmtDateTime(w.firstSeenAt)} · last ${fmtDateTime(w.lastSeenAt)} · ${w.pointCount} fixes`}
              >
                {w.wardName ? `${w.wardName} · ${w.wardCode}` : w.wardCode}
                {w.crossing ? ' · crossed in' : ''}
              </span>
            ))}
          </div>
          {full.wardEntries.some((w) => w.crossing) && (
            <p style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
              The tracked route moved into a neighbouring ward (crossed in); it stays
              filed to {full.wardCode ?? 'its own ward'}.
            </p>
          )}
        </div>
      )}

      {media.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Attachments ({media.length})</strong>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {media.map((m) => (
              <CrmMediaThumb key={m.mediaId} mediaId={m.mediaId} contentType={m.contentType} captureMode={m.captureMode} />
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {error && <p role="alert">{error} <CrmSmallButton onClick={() => setReload((n) => n + 1)}>Retry</CrmSmallButton></p>}
        <strong>Call Log ({error || stopsLoading ? '—' : stops.length})</strong>
        {stopsLoading ? (
          <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
        ) : error ? null : stops.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: 13 }}>No calls logged.</p>
        ) : (
          <CrmTable
            columns={['Title', 'Note', 'Status', 'Contact', 'Follow-up', 'Completed', 'Time', '']}
            rows={stops.map((s) => [
              s.title || '(Untitled)',
              <span key="n" style={{ fontSize: 13 }}>{(s.note ?? '—').slice(0, 80)}</span>,
              <CrmBadge key="cs" value={CALL_STATUS_LABELS[s.callStatus] ?? s.callStatus} />,
              s.contactMethod?.replace(/_/g, ' ') ?? '—',
              fmtDateTime(s.followUpAt),
              fmtDateTime(s.completedAt),
              <span key="t" style={{ fontSize: 13 }}>{fmtDateTime(s.arrivedAt)}</span>,
              canWrite ? <PatrolStopEditor key={s.id} stop={s} onSaved={(updated) => { setStops((rows) => rows.map((row) => row.id === updated.id ? updated : row)); onUpdated(); }} /> : null,
            ])}
            empty="No calls."
          />
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        {onEdit && <CrmSmallButton disabled={stopsLoading || !!error} onClick={() => onEdit(full)}>Edit</CrmSmallButton>}
        <CrmSmallButton onClick={onClose}>Close</CrmSmallButton>
      </div>
    </CrmModal>
  );
}

function PatrolStopEditor({ stop, onSaved }: { stop: PatrolStop; onSaved: (s: PatrolStop) => void }) {
  const [status, setStatus] = useState<string>(stop.callStatus);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  async function save() {
    if (saving.current) return;
    if (!note.trim()) { setError('Record an outcome for this update.'); return; }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      onSaved(await api.updatePatrolStop(stop.patrolId, stop.id, {
        callStatus: status, note: note.trim(),
        ...(method ? { contactMethod: method } : {}),
        ...(due && status !== 'completed' ? { followUpAt: new Date(due).toISOString() } : {}),
      }));
      setNote('');
      setDue('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update call.'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <details>
    <summary>Update / follow up</summary>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 180 }}>
      <CrmField label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(CALL_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></CrmField>
      <CrmField label="Contact method"><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="">No new contact</option>{['phone', 'email', 'sms', 'whatsapp', 'in_person', 'service_portal', 'other'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></CrmField>
      <CrmField label="Outcome"><textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></CrmField>
      {status !== 'completed' && <CrmField label="Next follow-up"><input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></CrmField>}
      {error && <p role="alert">{error}</p>}
      <CrmSmallButton onClick={save}>Save update</CrmSmallButton>
    </fieldset>
  </details>;
}

/** Create (patrol=null) or edit a patrol record. */
function PatrolFormModal({
  patrol,
  onClose,
  onSaved,
}: {
  patrol: Patrol | null;
  onClose: () => void;
  onSaved: (p: Patrol) => void;
}) {
  const isEdit = !!patrol;
  const [wardCode, setWardCode] = useState(patrol?.wardCode ?? '');
  const [mode, setMode] = useState(patrol?.mode ?? 'walk');
  const [purpose, setPurpose] = useState(patrol?.purpose ?? '');
  const [summary, setSummary] = useState(patrol?.summary ?? '');
  const [status, setStatus] = useState(patrol?.status ?? 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    if (!isEdit && !wardCode.trim()) {
      setError('A ward code is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: Patrol;
      if (isEdit) {
        saved = await api.updatePatrol(patrol!.id, {
          wardCode: wardCode.trim() || undefined,
          mode,
          purpose: purpose.trim() === '' ? null : purpose.trim(),
          summary: summary.trim() === '' ? null : summary.trim(),
          status,
        });
      } else {
        saved = await api.createPatrol({
          wardCode: wardCode.trim(),
          mode,
          purpose: purpose.trim() || undefined,
        });
      }
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the patrol.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrmModal title={isEdit ? 'Edit Patrol' : 'New Patrol'} onClose={onClose}>
      <CrmField label="Ward code">
        <input value={wardCode} onChange={(e) => setWardCode(e.target.value)} placeholder="e.g. CPT-W043" />
      </CrmField>
      <CrmField label="Mode">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="walk">Walk</option>
          <option value="drive">Drive</option>
        </select>
      </CrmField>
      <CrmField label="Purpose">
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Oversight, fault visit, canvass…" />
      </CrmField>
      {isEdit && (
        <>
          <CrmField label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {[patrol!.status, ...(TRANSITIONS[patrol!.status] ?? [])].map((s) => (
                <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Summary / report">
            <textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Report notes for this patrol." />
          </CrmField>
        </>
      )}
      {error && <p style={{ color: '#c8102e', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
        <CrmButton onClick={save} disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create patrol'}</CrmButton>
      </div>
    </CrmModal>
  );
}
