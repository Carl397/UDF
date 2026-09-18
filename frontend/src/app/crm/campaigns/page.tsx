'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, CrmFilters, CrmPagination, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Campaigns — marketing/outreach campaign management backed by the
 * marketing_campaigns table. Target audiences by ward/tier/region, schedule
 * windows, track engagement (clicks/shares/conversions) and move through
 * draft → active → completed.
 */

interface Campaign {
  id: string;
  title: string;
  description: string | null;
  target_audience: { wards?: string[]; tiers?: string[]; regions?: string[] };
  start_date: string | null;
  end_date: string | null;
  status: string;
  engagement_metrics: { clicks?: number; shares?: number; conversions?: number };
  created_at: string;
  updated_at: string;
}

const STATUSES = ['draft', 'active', 'completed'];
const TIERS = ['member', 'activist', 'steward'];

const emptyForm = {
  title: '', description: '', status: 'draft',
  startDate: '', endDate: '', wards: '', tiers: '', regions: '',
};

export default function CrmCampaigns() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const limit = 20;

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: limit.toString(), offset: (page * limit).toString() };
    if (status) params.status = status;
    if (search) params.search = search;
    api
      .crmListCampaigns(params)
      .then((r: { items: Campaign[]; total: number }) => {
        setItems(r.items ?? []);
        setTotal(r.total ?? 0);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, status]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (c: Campaign) => {
    setEditing(c);
    setForm({
      title: c.title,
      description: c.description ?? '',
      status: c.status,
      startDate: c.start_date ? c.start_date.slice(0, 10) : '',
      endDate: c.end_date ? c.end_date.slice(0, 10) : '',
      wards: (c.target_audience?.wards ?? []).join(', '),
      tiers: (c.target_audience?.tiers ?? []).join(', '),
      regions: (c.target_audience?.regions ?? []).join(', '),
    });
    setShowForm(true);
  };

  const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    const payload = {
      title: form.title,
      description: form.description || undefined,
      status: form.status,
      start_date: form.startDate || undefined,
      end_date: form.endDate || undefined,
      target_audience: {
        wards: splitList(form.wards),
        tiers: splitList(form.tiers),
        regions: splitList(form.regions),
      },
    };
    try {
      if (editing) await api.crmUpdateCampaign(editing.id, payload);
      else await api.crmCreateCampaign(payload);
      setShowForm(false);
      load();
    } catch {
      alert('Failed to save campaign.');
    }
  };

  const remove = async (c: Campaign) => {
    if (!confirm(`Delete campaign "${c.title}"?`)) return;
    try {
      await api.crmDeleteCampaign(c.id);
      load();
    } catch {
      alert('Failed to delete campaign.');
    }
  };

  const setStatusOnly = async (c: Campaign, next: string) => {
    try {
      await api.crmUpdateCampaign(c.id, { status: next });
      load();
    } catch {
      alert('Failed to update status.');
    }
  };

  const active = items.filter((i) => i.status === 'active').length;
  const drafts = items.filter((i) => i.status === 'draft').length;
  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <CrmPageHeader
        title="Marketing Campaigns"
        subtitle="Outreach drives targeted by ward, tier and region, with engagement tracking."
        actions={<CrmButton onClick={openCreate}>+ New Campaign</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Campaigns', value: total },
          { label: 'Active', value: active, tone: 'success' },
          { label: 'Drafts', value: drafts, tone: 'warn' },
        ]}
      />

      <CrmFilters>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search campaigns…" onKeyDown={(e) => { if (e.key === 'Enter') { setPage(0); load(); } }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'campaigns',
              ['Title', 'Status', 'Start', 'End', 'Wards', 'Tiers', 'Regions', 'Clicks', 'Shares', 'Conversions'],
              items.map((c) => [
                c.title, c.status, c.start_date ?? '', c.end_date ?? '',
                (c.target_audience?.wards ?? []).join('|'),
                (c.target_audience?.tiers ?? []).join('|'),
                (c.target_audience?.regions ?? []).join('|'),
                c.engagement_metrics?.clicks ?? 0,
                c.engagement_metrics?.shares ?? 0,
                c.engagement_metrics?.conversions ?? 0,
              ]),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading campaigns…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Audience', 'Window', 'Engagement', 'Status', '']}
          rows={items.map((c) => {
            const aud = c.target_audience ?? {};
            const audLabel = [
              aud.wards?.length ? `${aud.wards.length} wards` : '',
              aud.tiers?.length ? aud.tiers.join('/') : '',
              aud.regions?.length ? `${aud.regions.length} regions` : '',
            ].filter(Boolean).join(' · ') || 'Everyone';
            const m = c.engagement_metrics ?? {};
            return [
              <span key="t"><strong>{c.title}</strong>{c.description && <><br /><span style={{ color: '#64748b', fontSize: 13 }}>{c.description.slice(0, 70)}{c.description.length > 70 ? '…' : ''}</span></>}</span>,
              <span key="a" style={{ fontSize: 13 }}>{audLabel}</span>,
              <span key="w" style={{ fontSize: 13 }}>{fmtDate(c.start_date)} → {fmtDate(c.end_date)}</span>,
              <span key="e" style={{ fontSize: 13 }}>
                {(m.clicks ?? 0)} clicks · {(m.shares ?? 0)} shares · {(m.conversions ?? 0)} conv.
              </span>,
              <CrmBadge key="s" value={c.status} />,
              <span key="ac" style={{ whiteSpace: 'nowrap' }}>
                <CrmSmallButton onClick={() => openEdit(c)}>Edit</CrmSmallButton>
                {c.status === 'draft' && <CrmSmallButton onClick={() => setStatusOnly(c, 'active')}>Activate</CrmSmallButton>}
                {c.status === 'active' && <CrmSmallButton onClick={() => setStatusOnly(c, 'completed')}>Complete</CrmSmallButton>}
                <CrmSmallButton danger onClick={() => remove(c)}>Delete</CrmSmallButton>
              </span>,
            ];
          })}
          empty="No campaigns yet. Create your first outreach drive."
        />
      )}

      <CrmPagination page={page} totalPages={totalPages} total={total} onPage={setPage} />

      {showForm && (
        <CrmModal title={editing ? 'Edit Campaign' : 'New Campaign'} onClose={() => setShowForm(false)} wide>
          <CrmField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </CrmField>
          <CrmField label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </CrmField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <CrmField label="Status">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </CrmField>
            <CrmField label="Tiers (comma-separated)">
              <input value={form.tiers} onChange={(e) => setForm({ ...form, tiers: e.target.value })} placeholder={TIERS.join(', ')} />
            </CrmField>
            <CrmField label="Start Date">
              <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </CrmField>
            <CrmField label="End Date">
              <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </CrmField>
          </div>
          <CrmField label="Target Wards (comma-separated codes)">
            <input value={form.wards} onChange={(e) => setForm({ ...form, wards: e.target.value })} placeholder="CPT-W054, CPT-W055" />
          </CrmField>
          <CrmField label="Target Regions (comma-separated codes)">
            <input value={form.regions} onChange={(e) => setForm({ ...form, regions: e.target.value })} placeholder="CPT-SC4, CPT-SC2" />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowForm(false)}>Cancel</CrmButton>
            <CrmButton onClick={save} disabled={!form.title}>{editing ? 'Save Changes' : 'Create Campaign'}</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
