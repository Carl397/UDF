'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  CrmCard, CrmTable, CrmBadge, CrmButton, CrmSmallButton, CrmField,
} from './ui';
import type { JobsAdminConfig, WorkTypeAdmin } from '../../types';

/**
 * CRM Settings ▸ Ward Jobs administration (PRD-jobs FR-N4). National-admin
 * only: the work-type taxonomy, the feature-flag kill-switches (§9.7), the
 * relay email template and the demand/duplicate windows.
 */

const FLAGS: Array<{ key: keyof JobsAdminConfig['flags']; label: string; hint: string }> = [
  { key: 'register', label: 'jobs.register', hint: 'Members may add/edit their own ward work-interest register.' },
  { key: 'relay', label: 'jobs.relay', hint: 'Publishing relays in-app + email alerts to matched members. Off = manual briefing mode.' },
  { key: 'publicCount', label: 'jobs.publicCount', hint: 'Show the anonymous "people looking for work" count on the public ward overview.' },
];

export default function JobsAdminSettings() {
  const [config, setConfig] = useState<JobsAdminConfig | null>(null);
  const [workTypes, setWorkTypes] = useState<WorkTypeAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Local, editable copy of the template + windows (committed on Save).
  const [draft, setDraft] = useState({ subject: '', body: '', staleDays: 90, guardDays: 14 });
  // Taxonomy editor state.
  const [rows, setRows] = useState<Record<string, { label: string; sort: number }>>({});
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    window.setTimeout(() => setMsg(null), 3500);
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.jobAdminConfig(), api.jobAdminWorkTypes()])
      .then(([cfg, wt]) => {
        setConfig(cfg);
        setDraft({
          subject: cfg.relayEmailSubject,
          body: cfg.relayEmailBody,
          staleDays: cfg.demandStaleDays,
          guardDays: cfg.duplicateGuardDays,
        });
        setWorkTypes(wt.items);
        setRows(Object.fromEntries(wt.items.map((w) => [w.code, { label: w.label, sort: w.sort }])));
      })
      .catch(() => flash('err', 'Could not load jobs configuration.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function toggleFlag(key: keyof JobsAdminConfig['flags'], value: boolean) {
    if (!config) return;
    setBusy(true);
    try {
      const updated = await api.jobUpdateConfig({ flags: { [key]: value } });
      setConfig(updated);
      flash('ok', `${key} ${value ? 'enabled' : 'disabled'}.`);
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not update flag.');
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    setBusy(true);
    try {
      const updated = await api.jobUpdateConfig({
        relayEmailSubject: draft.subject.trim(),
        relayEmailBody: draft.body,
        demandStaleDays: draft.staleDays,
        duplicateGuardDays: draft.guardDays,
      });
      setConfig(updated);
      flash('ok', 'Relay template and windows saved.');
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not save configuration.');
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkType(code: string) {
    const r = rows[code];
    if (!r || !r.label.trim()) return flash('err', 'A label is required.');
    setBusy(true);
    try {
      await api.jobUpsertWorkType(code, { label: r.label.trim(), sort: r.sort });
      const wt = await api.jobAdminWorkTypes();
      setWorkTypes(wt.items);
      setRows(Object.fromEntries(wt.items.map((w) => [w.code, { label: w.label, sort: w.sort }])));
      flash('ok', `Saved “${code}”.`);
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not save work type.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleWorkType(w: WorkTypeAdmin) {
    setBusy(true);
    try {
      await api.jobUpsertWorkType(w.code, { active: !w.active });
      const wt = await api.jobAdminWorkTypes();
      setWorkTypes(wt.items);
      setRows(Object.fromEntries(wt.items.map((x) => [x.code, { label: x.label, sort: x.sort }])));
      flash('ok', `“${w.code}” ${!w.active ? 'activated' : 'deactivated'}.`);
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not update work type.');
    } finally {
      setBusy(false);
    }
  }

  async function addWorkType() {
    const code = newCode.trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(code)) return flash('err', 'Code must be lowercase letters, numbers, hyphen or underscore.');
    if (!newLabel.trim()) return flash('err', 'A label is required.');
    setBusy(true);
    try {
      await api.jobUpsertWorkType(code, { label: newLabel.trim(), active: true });
      setNewCode('');
      setNewLabel('');
      const wt = await api.jobAdminWorkTypes();
      setWorkTypes(wt.items);
      setRows(Object.fromEntries(wt.items.map((w) => [w.code, { label: w.label, sort: w.sort }])));
      flash('ok', `Added “${code}”.`);
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not add work type.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <CrmCard title="Ward Jobs · Administration"><p style={{ color: '#64748b' }}>Loading jobs configuration…</p></CrmCard>;
  }

  const inputStyle = { padding: '6px 10px', border: '1px solid #ece5e1', borderRadius: 6, fontSize: 13 } as const;

  return (
    <>
      {msg && (
        <div style={{
          padding: 12, marginBottom: 20, borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: msg.tone === 'ok' ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${msg.tone === 'ok' ? '#bbf7d0' : '#fecaca'}`,
          color: msg.tone === 'ok' ? '#166534' : '#991b1b',
        }}>
          {msg.text}
        </div>
      )}

      <CrmCard title="Ward Jobs · Feature Flags (kill-switch)">
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>
          Flags take effect immediately, without a redeploy. Disabling <code>jobs.relay</code> keeps
          opportunities publishable but suppresses member notifications (manual briefing mode).
        </p>
        <CrmTable
          columns={['Flag', 'Purpose', 'State', '']}
          rows={FLAGS.map((f) => {
            const on = config?.flags[f.key] ?? false;
            return [
              <code key="k" style={{ fontSize: 13 }}>{f.label}</code>,
              <span key="h" style={{ fontSize: 13, color: '#374151' }}>{f.hint}</span>,
              <CrmBadge key="s" value={on ? 'active' : 'inactive'} />,
              <CrmSmallButton key="t" onClick={() => toggleFlag(f.key, !on)}>{on ? 'Disable' : 'Enable'}</CrmSmallButton>,
            ];
          })}
        />
      </CrmCard>

      <CrmCard title="Ward Jobs · Relay Email Template">
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>
          Placeholders: <code>{'{firstName}'}</code>, <code>{'{title}'}</code>, <code>{'{company}'}</code>,{' '}
          <code>{'{ref}'}</code>, <code>{'{contact}'}</code>. Members apply directly to the company — the
          platform never attaches a CV or a member list.
        </p>
        <CrmField label="Subject">
          <input value={draft.subject} maxLength={200} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
        </CrmField>
        <CrmField label="Body">
          <textarea rows={7} maxLength={2000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </CrmField>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <CrmField label="Demand staleness window (days)">
            <input
              type="number" min={1} max={3650} value={draft.staleDays}
              onChange={(e) => setDraft({ ...draft, staleDays: Number(e.target.value) })}
            />
          </CrmField>
          <CrmField label="Duplicate-guard window (days)">
            <input
              type="number" min={1} max={365} value={draft.guardDays}
              onChange={(e) => setDraft({ ...draft, guardDays: Number(e.target.value) })}
            />
          </CrmField>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <CrmButton onClick={saveTemplate} disabled={busy}>Save template &amp; windows</CrmButton>
        </div>
      </CrmCard>

      <CrmCard title={`Ward Jobs · Work-Type Taxonomy · ${workTypes.length} codes`}>
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>
          Deactivating a code hides it from new registrations and opportunity forms but preserves it on
          existing rows and in historical demand aggregates.
        </p>
        <CrmTable
          columns={['Code', 'Label', 'Sort', 'State', '']}
          rows={workTypes.map((w) => [
            <code key="c" style={{ fontSize: 13 }}>{w.code}</code>,
            <input
              key="l"
              style={{ ...inputStyle, width: '100%', minWidth: 160 }}
              value={rows[w.code]?.label ?? w.label}
              maxLength={60}
              onChange={(e) => setRows((r) => ({ ...r, [w.code]: { label: e.target.value, sort: r[w.code]?.sort ?? w.sort } }))}
            />,
            <input
              key="s"
              type="number" min={0} max={9999}
              style={{ ...inputStyle, width: 72 }}
              value={rows[w.code]?.sort ?? w.sort}
              onChange={(e) => setRows((r) => ({ ...r, [w.code]: { label: r[w.code]?.label ?? w.label, sort: Number(e.target.value) } }))}
            />,
            <CrmBadge key="b" value={w.active ? 'active' : 'inactive'} />,
            <span key="a" style={{ display: 'flex', gap: 4 }}>
              <CrmSmallButton onClick={() => saveWorkType(w.code)}>Save</CrmSmallButton>
              <CrmSmallButton danger={w.active} onClick={() => toggleWorkType(w)}>
                {w.active ? 'Deactivate' : 'Activate'}
              </CrmSmallButton>
            </span>,
          ])}
          empty="No work types defined."
        />

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: '#8a817b', marginBottom: 4 }}>New code</div>
            <input style={inputStyle} value={newCode} maxLength={24} placeholder="welding" onChange={(e) => setNewCode(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#8a817b', marginBottom: 4 }}>Label</div>
            <input style={inputStyle} value={newLabel} maxLength={60} placeholder="Welding / metalwork" onChange={(e) => setNewLabel(e.target.value)} />
          </div>
          <CrmButton onClick={addWorkType} disabled={busy}>+ Add work type</CrmButton>
        </div>
      </CrmCard>
    </>
  );
}
