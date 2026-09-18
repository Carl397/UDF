'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, CrmFilters, downloadCsv, fmtDate, fmtDateTime,
} from '../../../components/crm/ui';
import type { CreateJobOpportunityInput, JobOpportunity, WorkType } from '../../../types';

/**
 * CRM Opportunities — the work-opportunity relay queue (PRD-jobs FR-N2).
 *
 * Staff record jobs/adverts from project companies entering a ward, publish
 * them to relay an in-app alert + email to matched members, and track delivery
 * COUNTS only. HARD RULE (NG3): no member names, emails or recipient lists are
 * ever shown — members apply DIRECTLY to the company. The platform never holds
 * a CV (NG1).
 */

interface Form {
  title: string;
  company: string;
  workTypes: string[];
  description: string;
  contactEmail: string;
  contactPhone: string;
  contactUrl: string;
  wardCode: string;
  closesAt: string;
}

const EMPTY_FORM: Form = {
  title: '',
  company: '',
  workTypes: [],
  description: '',
  contactEmail: '',
  contactPhone: '',
  contactUrl: '',
  wardCode: '',
  closesAt: '',
};

function formFrom(o: JobOpportunity): Form {
  return {
    title: o.title,
    company: o.company,
    workTypes: o.workTypes,
    description: o.description ?? '',
    contactEmail: o.contactEmail ?? '',
    contactPhone: o.contactPhone ?? '',
    contactUrl: o.contactUrl ?? '',
    wardCode: o.wardCode ?? '',
    closesAt: o.closesAt ? o.closesAt.slice(0, 10) : '',
  };
}

export default function CrmOpportunities() {
  const { wardCode } = useAuth();
  const [items, setItems] = useState<JobOpportunity[]>([]);
  const [workTypes, setWorkTypes] = useState<WorkType[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [ward, setWard] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobOpportunity | null>(null);
  const [editing, setEditing] = useState<JobOpportunity | null | undefined>(undefined); // undefined = closed, null = new
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const label = useCallback(
    (code: string) => workTypes.find((w) => w.code === code)?.label ?? code,
    [workTypes],
  );

  const load = useCallback(() => {
    setLoading(true);
    api
      .listJobOpportunities({ ward: ward || undefined, status: status || undefined, limit: 200 })
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [ward, status]);

  useEffect(() => {
    api.jobWorkTypes().then((r) => setWorkTypes(r.items)).catch(() => setWorkTypes([]));
  }, []);
  useEffect(load, [load]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggleType = (code: string) =>
    setForm((f) => ({
      ...f,
      workTypes: f.workTypes.includes(code)
        ? f.workTypes.filter((c) => c !== code)
        : [...f.workTypes, code],
    }));

  function openCreate() {
    setForm({ ...EMPTY_FORM, wardCode: wardCode ?? ward ?? '' });
    setError(null);
    setEditing(null);
  }

  function openEdit(o: JobOpportunity) {
    setForm(formFrom(o));
    setError(null);
    setEditing(o);
  }

  async function save() {
    if (!form.title.trim()) return setError('A role/title is required.');
    if (!form.company.trim()) return setError('A company is required.');
    if (form.workTypes.length === 0) return setError('Select at least one type of work.');
    if (!form.contactEmail.trim() && !form.contactPhone.trim() && !form.contactUrl.trim()) {
      return setError('Add a company contact so members can apply directly.');
    }
    const payload: CreateJobOpportunityInput = {
      title: form.title.trim(),
      company: form.company.trim(),
      workTypes: form.workTypes,
    };
    if (form.description.trim()) payload.description = form.description.trim();
    if (form.contactEmail.trim()) payload.contactEmail = form.contactEmail.trim();
    if (form.contactPhone.trim()) payload.contactPhone = form.contactPhone.trim();
    if (form.contactUrl.trim()) payload.contactUrl = form.contactUrl.trim();
    if (form.closesAt) payload.closesAt = form.closesAt;
    if (!editing && form.wardCode.trim()) payload.wardCode = form.wardCode.trim();

    setBusyId(editing?.id ?? 'save');
    setError(null);
    try {
      if (editing) await api.updateJobOpportunity(editing.id, payload);
      else await api.createJobOpportunity(payload);
      setEditing(undefined);
      load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not save opportunity.');
    } finally {
      setBusyId(null);
    }
  }

  async function publish(o: JobOpportunity) {
    setBusyId(o.id);
    try {
      const r = await api.publishJobOpportunity(o.id);
      const m = r.opportunity.stats?.matched ?? 0;
      setDetail(r.opportunity);
      load();
      window.alert(
        r.duplicateWarning
          ? `Published (possible duplicate) — relayed to ${m} member${m === 1 ? '' : 's'}.`
          : `Published — relayed to ${m} member${m === 1 ? '' : 's'}.`,
      );
    } catch (e: any) {
      window.alert(e?.message ?? 'Could not publish.');
    } finally {
      setBusyId(null);
    }
  }

  async function close(o: JobOpportunity) {
    setBusyId(o.id);
    try {
      await api.closeJobOpportunity(o.id);
      setDetail(null);
      load();
    } catch (e: any) {
      window.alert(e?.message ?? 'Could not close.');
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    downloadCsv(
      'opportunities',
      ['Reference', 'Title', 'Company', 'Ward', 'Work Types', 'Status', 'Closes', 'Matched', 'In-app', 'Emailed'],
      items.map((o) => [
        o.refNo,
        o.title,
        o.company,
        o.wardCode ?? '',
        o.workTypes.map(label).join('; '),
        o.status,
        o.closesAt ?? '',
        o.stats?.matched ?? '',
        o.stats?.notifiedInapp ?? '',
        o.stats?.emailed ?? '',
      ]),
    );
  }

  const published = items.filter((o) => o.status === 'published');
  const drafts = items.filter((o) => o.status === 'draft');
  const totalRelayed = items.reduce((sum, o) => sum + (o.stats?.matched ?? 0), 0);

  return (
    <div>
      <CrmPageHeader
        title="Opportunities"
        subtitle="Work opportunities relayed to matched members — delivery counts only, never a recipient list."
        actions={<CrmButton onClick={openCreate}>+ New Opportunity</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total', value: items.length },
          { label: 'Published', value: published.length, tone: published.length > 0 ? 'success' : 'default' },
          { label: 'Drafts', value: drafts.length, tone: drafts.length > 0 ? 'warn' : 'default' },
          { label: 'Members Relayed', value: totalRelayed },
        ]}
      />

      <CrmFilters>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="closed">Closed</option>
          <option value="expired">Expired</option>
        </select>
        <input
          type="text"
          value={ward}
          placeholder="Filter by ward code…"
          onChange={(e) => setWard(e.target.value)}
        />
        <CrmSmallButton onClick={exportCsv}>Export CSV</CrmSmallButton>
      </CrmFilters>

      <div style={{ padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 20 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#991b1b', fontWeight: 500 }}>
          <strong>Privacy note:</strong> Publishing relays an in-app alert and email to matched members
          in the ward. Members apply <strong>directly to the company</strong>. No CV is ever held and no
          member list is exposed here — only aggregate delivery counts.
        </p>
      </div>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading opportunities…</p>
      ) : (
        <CrmTable
          columns={['Opportunity', 'Reference', 'Ward', 'Work Types', 'Status', 'Relay', 'Closes', '']}
          rows={items.map((o) => [
            <span key="t">
              <strong>{o.title}</strong>
              <br />
              <span style={{ color: '#64748b', fontSize: 13 }}>{o.company}</span>
            </span>,
            <span key="r" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{o.refNo}</span>,
            o.wardCode ?? '—',
            <span key="w" style={{ fontSize: 13 }}>{o.workTypes.map(label).join(', ')}</span>,
            <CrmBadge key="s" value={o.status} />,
            <span key="d" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {o.stats ? `${o.stats.matched} matched · ${o.stats.emailed} emailed` : '—'}
            </span>,
            fmtDate(o.closesAt),
            <span key="a" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <CrmSmallButton onClick={() => setDetail(o)}>View</CrmSmallButton>
              {(o.status === 'draft' || o.status === 'published') && (
                <CrmSmallButton onClick={() => openEdit(o)}>Edit</CrmSmallButton>
              )}
              {o.status === 'draft' && (
                <CrmSmallButton onClick={() => publish(o)}>
                  {busyId === o.id ? '…' : 'Publish'}
                </CrmSmallButton>
              )}
              {o.status === 'published' && (
                <CrmSmallButton danger onClick={() => close(o)}>
                  {busyId === o.id ? '…' : 'Close'}
                </CrmSmallButton>
              )}
            </span>,
          ])}
          empty="No opportunities recorded in your scope."
        />
      )}

      {detail && (
        <CrmModal title={detail.title} onClose={() => setDetail(null)} wide>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div><strong>Status:</strong> <CrmBadge value={detail.status} /></div>
            <div><strong>Reference:</strong> {detail.refNo}</div>
            <div><strong>Company:</strong> {detail.company}</div>
            <div><strong>Ward:</strong> {detail.wardCode ?? '—'}</div>
            <div><strong>Work types:</strong> {detail.workTypes.map(label).join(', ')}</div>
            <div><strong>Closes:</strong> {fmtDate(detail.closesAt)}</div>
            <div><strong>Published:</strong> {fmtDateTime(detail.publishedAt)}</div>
          </div>

          {detail.description && (
            <p style={{ whiteSpace: 'pre-wrap', color: '#374151' }}>{detail.description}</p>
          )}

          <div style={{ marginBottom: 16, padding: 14, background: '#faf7f5', border: '1px solid #ece5e1', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Company contact (members apply directly)</div>
            {detail.contactEmail && <div style={{ fontSize: 13 }}>Email: {detail.contactEmail}</div>}
            {detail.contactPhone && <div style={{ fontSize: 13 }}>Phone: {detail.contactPhone}</div>}
            {detail.contactUrl && <div style={{ fontSize: 13 }}>URL: {detail.contactUrl}</div>}
            {!detail.contactEmail && !detail.contactPhone && !detail.contactUrl && (
              <div style={{ fontSize: 13, color: '#8a817b' }}>No contact recorded.</div>
            )}
          </div>

          {detail.stats && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Delivery (counts only)</div>
              <CrmStatGrid
                stats={[
                  { label: 'Matched', value: detail.stats.matched },
                  { label: 'In-app', value: detail.stats.notifiedInapp },
                  { label: 'Emailed', value: detail.stats.emailed },
                  { label: 'Email failed', value: detail.stats.emailFailed, tone: detail.stats.emailFailed > 0 ? 'danger' : 'default' },
                ]}
              />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {detail.status === 'draft' && (
              <CrmButton onClick={() => publish(detail)} disabled={busyId === detail.id}>Publish &amp; relay</CrmButton>
            )}
            {detail.status === 'published' && (
              <CrmButton variant="danger" onClick={() => close(detail)} disabled={busyId === detail.id}>Close</CrmButton>
            )}
            <CrmButton variant="secondary" onClick={() => setDetail(null)}>Done</CrmButton>
          </div>
        </CrmModal>
      )}

      {editing !== undefined && (
        <CrmModal title={editing ? 'Edit opportunity' : 'New opportunity'} onClose={() => setEditing(undefined)} wide>
          {error && (
            <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16, color: '#991b1b', fontSize: 13 }}>
              {error}
            </div>
          )}
          <CrmField label="Role / title">
            <input value={form.title} maxLength={140} placeholder="Site labourers & catering" onChange={(e) => set({ title: e.target.value })} />
          </CrmField>
          <CrmField label="Company / project">
            <input value={form.company} maxLength={140} placeholder="Ward upgrade consortium" onChange={(e) => set({ company: e.target.value })} />
          </CrmField>
          <CrmField label="Ward code">
            <input value={form.wardCode} disabled={!!editing} placeholder="e.g. NORTH-W09" onChange={(e) => set({ wardCode: e.target.value })} />
          </CrmField>
          <CrmField label="Types of work needed">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {workTypes.map((w) => (
                <button
                  key={w.code}
                  type="button"
                  onClick={() => toggleType(w.code)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 16,
                    fontSize: 13,
                    cursor: 'pointer',
                    border: `1px solid ${form.workTypes.includes(w.code) ? '#c8102e' : '#ece5e1'}`,
                    background: form.workTypes.includes(w.code) ? '#c8102e' : '#fff',
                    color: form.workTypes.includes(w.code) ? '#fff' : '#57534e',
                  }}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </CrmField>
          <CrmField label="Details">
            <textarea rows={3} value={form.description} maxLength={600} placeholder="Short description shown to matched members. No CVs are held on the platform." onChange={(e) => set({ description: e.target.value })} />
          </CrmField>
          <CrmField label="Company contact email">
            <input type="email" value={form.contactEmail} maxLength={200} placeholder="hr@company.example" onChange={(e) => set({ contactEmail: e.target.value })} />
          </CrmField>
          <CrmField label="Contact phone">
            <input value={form.contactPhone} maxLength={32} placeholder="+27…" onChange={(e) => set({ contactPhone: e.target.value })} />
          </CrmField>
          <CrmField label="Application URL">
            <input type="url" value={form.contactUrl} maxLength={300} placeholder="https://company.example/apply" onChange={(e) => set({ contactUrl: e.target.value })} />
          </CrmField>
          <CrmField label="Closes">
            <input type="date" value={form.closesAt} onChange={(e) => set({ closesAt: e.target.value })} />
          </CrmField>
          <p style={{ fontSize: 12, color: '#8a817b', margin: '4px 0 16px' }}>
            At least one company contact is required. Saving creates a draft; publishing relays the alert.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setEditing(undefined)}>Cancel</CrmButton>
            <CrmButton onClick={save} disabled={busyId !== null}>
              {editing ? 'Save changes' : 'Save draft'}
            </CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
