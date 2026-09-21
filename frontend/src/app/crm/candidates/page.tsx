'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { CandidatePhotoEditor } from '../../../components/crm/CandidatePhotoEditor';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmFilters, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv,
} from '../../../components/crm/ui';
import type { WardCandidate, WardCandidateInput } from '../../../types';

/**
 * CRM Ward Candidates — the roster behind the public homepage's "Meet our ward
 * councillors" grid.
 *
 * Owned by whoever holds content:manage (the same gate as /crm/website), because
 * these rows are published editorial content rather than territory-scoped
 * records: order decides who appears first, `isActive` decides who appears at
 * all, and the photo is the one asset each card needs.
 */

const EMPTY: WardCandidateInput & { bio: string } = {
  fullName: '',
  roleLabel: '',
  wardsLabel: '',
  bio: '',
  sortOrder: 0,
  isActive: true,
};

export default function CrmCandidates() {
  const [items, setItems] = useState<WardCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'hidden'>('all');
  const [showEdit, setShowEdit] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [photoFor, setPhotoFor] = useState<{ id: string; name: string; hasPhoto: boolean } | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listCandidates()
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const visible = items.filter((c) => {
    if (filter === 'active' && !c.isActive) return false;
    if (filter === 'hidden' && c.isActive) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${c.fullName} ${c.roleLabel} ${c.wardsLabel}`.toLowerCase().includes(q);
  });

  const openCreate = () => {
    setEditingId(null);
    // New people land at the end of the editorial order unless the editor moves them.
    setForm({ ...EMPTY, sortOrder: items.reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1 });
    setShowEdit(true);
  };

  const openEdit = (c: WardCandidate) => {
    setEditingId(c.id);
    setForm({
      fullName: c.fullName,
      roleLabel: c.roleLabel,
      wardsLabel: c.wardsLabel,
      bio: c.bio,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
    });
    setShowEdit(true);
  };

  const save = async () => {
    const payload: WardCandidateInput = {
      fullName: form.fullName.trim(),
      roleLabel: form.roleLabel?.trim() ?? '',
      wardsLabel: form.wardsLabel?.trim() ?? '',
      bio: form.bio.trim(),
      sortOrder: Number.isFinite(form.sortOrder) ? form.sortOrder : 0,
      isActive: form.isActive,
    };
    try {
      if (editingId) await api.updateCandidate(editingId, payload);
      else await api.createCandidate(payload);
      setShowEdit(false);
      load();
    } catch {
      alert(editingId ? 'Failed to save changes.' : 'Failed to add candidate.');
    }
  };

  const toggleActive = async (c: WardCandidate) => {
    try {
      await api.updateCandidate(c.id, { isActive: !c.isActive });
      load();
    } catch {
      alert('Failed to update candidate.');
    }
  };

  const remove = async (c: WardCandidate) => {
    if (!window.confirm(`Delete "${c.fullName}" from the public roster? This cannot be undone.`)) return;
    try {
      await api.deleteCandidate(c.id);
      load();
    } catch {
      alert('Failed to delete candidate.');
    }
  };

  const move = async (c: WardCandidate, delta: number) => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, visible.indexOf(c) + delta))];
    if (!target || target.id === c.id) return;
    // Swap editorial slots rather than renumbering the whole roster.
    try {
      await api.updateCandidate(c.id, { sortOrder: target.sortOrder });
      await api.updateCandidate(target.id, { sortOrder: c.sortOrder });
      load();
    } catch {
      alert('Failed to reorder.');
    }
  };

  const active = items.filter((c) => c.isActive).length;

  return (
    <div>
      <CrmPageHeader
        title="Ward Councillors"
        subtitle="The roster published to the public homepage. Order, visibility, bio and photo are all edited here."
        actions={<CrmButton onClick={openCreate}>+ Add Councillor</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'On Roster', value: items.length },
          { label: 'Public', value: active, tone: 'success' },
          { label: 'Hidden', value: items.length - active },
          { label: 'Missing Photo', value: items.filter((c) => !c.hasPhoto).length, tone: 'warn' },
        ]}
      />

      <CrmFilters>
        <input
          type="text"
          placeholder="Search name or ward…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">Everyone</option>
          <option value="active">Public only</option>
          <option value="hidden">Hidden only</option>
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'ward-councillors',
              ['Order', 'Name', 'Role', 'Wards', 'Bio', 'Public', 'Photo'],
              items.map((c) => [
                c.sortOrder,
                c.fullName,
                c.roleLabel,
                c.wardsLabel,
                c.bio,
                c.isActive ? 'yes' : 'no',
                c.hasPhoto ? 'yes' : 'no',
              ]),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading roster…</p>
      ) : (
        <CrmTable
          columns={['#', 'Name', 'Role', 'Wards', 'Bio', 'Photo', 'Status', 'Actions']}
          rows={visible.map((c, i) => [
            c.sortOrder,
            c.fullName,
            c.roleLabel || '—',
            c.wardsLabel || '—',
            c.bio ? (
              <span key="b" title={c.bio}>
                {c.bio.length > 60 ? `${c.bio.slice(0, 60)}…` : c.bio}
              </span>
            ) : (
              <em key="b" style={{ color: '#94a3b8' }}>empty</em>
            ),
            c.hasPhoto ? (
              <span key="p" style={{ color: '#166534', fontWeight: 600 }}>yes</span>
            ) : (
              <span key="p" style={{ color: '#92400e' }}>none</span>
            ),
            <CrmBadge key="s" value={c.isActive ? 'active' : 'inactive'} />,
            <span key="a">
              <CrmSmallButton onClick={() => openEdit(c)}>Edit</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setPhotoFor({ id: c.id, name: c.fullName, hasPhoto: c.hasPhoto })}>
                {c.hasPhoto ? 'Replace' : 'Photo'}
              </CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => move(c, -1)} disabled={i === 0}>↑</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => move(c, 1)} disabled={i === visible.length - 1}>↓</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => toggleActive(c)}>{c.isActive ? 'Hide' : 'Publish'}</CrmSmallButton>{' '}
              <CrmSmallButton danger onClick={() => remove(c)}>Delete</CrmSmallButton>
            </span>,
          ])}
          empty="No councillors match this filter."
        />
      )}

      {showEdit && (
        <CrmModal title={editingId ? 'Edit councillor' : 'Add councillor'} onClose={() => setShowEdit(false)}>
          <CrmField label="Full name">
            <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </CrmField>
          <CrmField label="Role label (optional)">
            <input value={form.roleLabel ?? ''} onChange={(e) => setForm({ ...form, roleLabel: e.target.value })} />
          </CrmField>
          <CrmField label="Wards covered (e.g. 39 wards)">
            <input value={form.wardsLabel ?? ''} onChange={(e) => setForm({ ...form, wardsLabel: e.target.value })} />
          </CrmField>
          <CrmField label="Bio (shown under the name on the public card)">
            <textarea
              rows={5}
              maxLength={2000}
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
            />
          </CrmField>
          <CrmField label="Display order">
            <input
              type="number"
              min={0}
              value={form.sortOrder ?? 0}
              onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
            />
          </CrmField>
          <CrmField label="Public">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              Show on the public homepage
            </label>
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowEdit(false)}>Cancel</CrmButton>
            <CrmButton onClick={save} disabled={!form.fullName.trim()}>{editingId ? 'Save changes' : 'Add'}</CrmButton>
          </div>
        </CrmModal>
      )}

      {photoFor && (
        <CandidatePhotoEditor
          candidateId={photoFor.id}
          candidateName={photoFor.name}
          hasPhoto={photoFor.hasPhoto}
          onClose={() => setPhotoFor(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
