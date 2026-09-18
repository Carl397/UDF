'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { Project, Milestone } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, CrmFilters, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Projects — infrastructure/service project tracking with milestones,
 * budget, stage and progress. Admins can create projects and add milestones.
 */

const SCOPES = ['ward', 'regional', 'national'];
const STAGES = ['proposed', 'approved', 'in_progress', 'on_hold', 'completed'];

export default function CrmProjects() {
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<(Project & { milestones: Milestone[] }) | null>(null);
  const [msForm, setMsForm] = useState({ title: '', dueDate: '' });
  const [form, setForm] = useState({
    title: '', description: '', scope: 'ward', wardCode: '', stage: 'proposed', budget: '', owner: '',
  });

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: '200' };
    if (scope) params.scope = scope;
    api
      .listProjects(params)
      .then((r: { items: Project[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [scope]);

  const inProgress = items.filter((i) => i.stage === 'in_progress').length;
  const completed = items.filter((i) => i.stage === 'completed').length;
  const totalBudget = items.reduce((sum, i) => sum + (i.budget ?? 0), 0);

  const create = async () => {
    try {
      await api.createProject({
        title: form.title,
        description: form.description || undefined,
        scope: form.scope,
        wardCode: form.wardCode || undefined,
        stage: form.stage,
        budget: form.budget ? Number(form.budget) : undefined,
        owner: form.owner || undefined,
      });
      setShowCreate(false);
      setForm({ title: '', description: '', scope: 'ward', wardCode: '', stage: 'proposed', budget: '', owner: '' });
      load();
    } catch {
      alert('Failed to create project.');
    }
  };

  const openDetail = async (p: Project) => {
    try {
      const full = await api.getProject(p.id);
      setDetail(full);
    } catch {
      setDetail({ ...p, milestones: [] });
    }
  };

  const addMilestone = async () => {
    if (!detail || !msForm.title.trim()) return;
    try {
      await api.addMilestone(detail.id, {
        title: msForm.title.trim(),
        dueDate: msForm.dueDate ? new Date(msForm.dueDate).toISOString() : undefined,
      });
      setMsForm({ title: '', dueDate: '' });
      const full = await api.getProject(detail.id);
      setDetail(full);
    } catch {
      alert('Failed to add milestone.');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Projects"
        subtitle="Infrastructure and service-delivery projects with milestone tracking."
        actions={<CrmButton onClick={() => setShowCreate(true)}>+ New Project</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Projects', value: items.length },
          { label: 'In Progress', value: inProgress, tone: 'warn' },
          { label: 'Completed', value: completed, tone: 'success' },
          { label: 'Total Budget', value: `R${(totalBudget / 1_000_000).toFixed(1)}m` },
        ]}
      />

      <CrmFilters>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All scopes</option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'projects',
              ['Title', 'Scope', 'Ward', 'Stage', 'Progress %', 'Budget', 'Owner'],
              items.map((i) => [i.title, i.scope, i.wardCode ?? '', i.stage, i.progressPct ?? '', i.budget ?? '', i.owner ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading projects…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Scope', 'Ward', 'Stage', 'Progress', 'Budget', '']}
          rows={items.map((p) => [
            <span key="t"><strong>{p.title}</strong>{p.owner && <><br /><span style={{ color: '#64748b', fontSize: 13 }}>{p.owner}</span></>}</span>,
            <CrmBadge key="s" value={p.scope} />,
            p.wardCode ?? '—',
            <CrmBadge key="st" value={p.stage} />,
            <span key="pr" style={{ fontSize: 13 }}>
              {p.progressPct ?? 0}%
              <span style={{ display: 'block', width: 80, height: 6, background: '#eee', borderRadius: 3, marginTop: 4 }}>
                <span style={{ display: 'block', width: `${p.progressPct ?? 0}%`, height: 6, background: '#c8102e', borderRadius: 3 }} />
              </span>
            </span>,
            p.budget ? `R${p.budget.toLocaleString()}` : '—',
            <CrmSmallButton key="v" onClick={() => openDetail(p)}>View</CrmSmallButton>,
          ])}
          empty="No projects found."
        />
      )}

      {showCreate && (
        <CrmModal title="New Project" onClose={() => setShowCreate(false)}>
          <CrmField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </CrmField>
          <CrmField label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </CrmField>
          <CrmField label="Scope">
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Ward Code">
            <input value={form.wardCode} onChange={(e) => setForm({ ...form, wardCode: e.target.value })} placeholder="e.g. NORTH-W09" />
          </CrmField>
          <CrmField label="Stage">
            <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              {STAGES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Budget (R)">
            <input type="number" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </CrmField>
          <CrmField label="Owner">
            <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Responsible party" />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowCreate(false)}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.title}>Create</CrmButton>
          </div>
        </CrmModal>
      )}

      {detail && (
        <CrmModal title={detail.title} onClose={() => setDetail(null)} wide>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
            <div><strong>Stage:</strong> <CrmBadge value={detail.stage} /></div>
            <div><strong>Scope:</strong> <CrmBadge value={detail.scope} /></div>
            <div><strong>Ward:</strong> {detail.wardCode ?? '—'}</div>
            <div><strong>Progress:</strong> {detail.progressPct ?? 0}%</div>
            <div><strong>Budget:</strong> {detail.budget ? `R${detail.budget.toLocaleString()}` : '—'}</div>
            <div><strong>Owner:</strong> {detail.owner ?? '—'}</div>
          </div>
          {detail.description && <p style={{ color: '#374151' }}>{detail.description}</p>}

          <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>Milestones</h3>
          {detail.milestones?.length ? (
            <ul style={{ paddingLeft: 20, margin: '0 0 16px' }}>
              {detail.milestones.map((m) => (
                <li key={m.id} style={{ marginBottom: 6 }}>
                  <strong>{m.title}</strong> — <CrmBadge value={m.status} />
                  {m.dueDate && <span style={{ color: '#64748b' }}> · due {fmtDate(m.dueDate)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: '#64748b' }}>No milestones yet.</p>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <CrmField label="Add milestone">
                <input value={msForm.title} onChange={(e) => setMsForm({ ...msForm, title: e.target.value })} placeholder="Milestone title" />
              </CrmField>
            </div>
            <div style={{ flex: 1 }}>
              <CrmField label="Due date">
                <input type="date" value={msForm.dueDate} onChange={(e) => setMsForm({ ...msForm, dueDate: e.target.value })} />
              </CrmField>
            </div>
            <CrmButton onClick={addMilestone} disabled={!msForm.title.trim()}>Add</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
