'use client';

import { useState } from 'react';
import { api } from '../../lib/api';
import { Icon, Sheet, useToast } from '../ui';
import type { CreateJobOpportunityInput, JobOpportunity, WorkType } from '../../types';

interface Form {
  title: string;
  company: string;
  workTypes: string[];
  description: string;
  contactEmail: string;
  contactPhone: string;
  contactUrl: string;
  closesAt: string;
}

function defaultForm(o?: JobOpportunity | null): Form {
  return {
    title: o?.title ?? '',
    company: o?.company ?? '',
    workTypes: o?.workTypes ?? [],
    description: o?.description ?? '',
    contactEmail: o?.contactEmail ?? '',
    contactPhone: o?.contactPhone ?? '',
    contactUrl: o?.contactUrl ?? '',
    closesAt: o?.closesAt ?? '',
  };
}

/**
 * FR-M1/M5: record (or edit) a work opportunity. Publishing + the member relay
 * happen from the list, not here — this sheet only captures the advert and a
 * company contact so members can apply DIRECTLY (PRD-jobs NG1: no CV held).
 */
export default function OpportunitySheet({
  opportunity,
  wardCode,
  workTypes,
  onClose,
  onSaved,
}: {
  opportunity?: JobOpportunity | null;
  wardCode: string | null;
  workTypes: WorkType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => defaultForm(opportunity));
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toggleType = (code: string) =>
    setForm((f) => ({
      ...f,
      workTypes: f.workTypes.includes(code)
        ? f.workTypes.filter((c) => c !== code)
        : [...f.workTypes, code],
    }));

  async function save() {
    if (!form.title.trim()) return toast('A role/title is required', 'err');
    if (!form.company.trim()) return toast('A company is required', 'err');
    if (form.workTypes.length === 0) return toast('Select at least one type of work', 'err');
    if (!form.contactEmail.trim() && !form.contactPhone.trim() && !form.contactUrl.trim()) {
      return toast('Add a company contact so members can apply directly', 'err');
    }
    setBusy(true);
    try {
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
      if (!opportunity && wardCode) payload.wardCode = wardCode;

      if (opportunity) await api.updateJobOpportunity(opportunity.id, payload);
      else await api.createJobOpportunity(payload);

      toast(opportunity ? 'Opportunity updated' : 'Opportunity saved as draft', 'ok');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not save opportunity', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={opportunity ? 'Edit opportunity' : 'Post a work opportunity'}
      subtitle={
        wardCode
          ? `Ward ${wardCode} · members apply directly to the company`
          : 'Members apply directly to the company'
      }
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={busy}>
            <Icon name="check" size={16} /> {busy ? 'Saving…' : opportunity ? 'Save changes' : 'Save draft'}
          </button>
        </div>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="jo-title">Role / title</label>
          <input
            id="jo-title"
            className="input"
            value={form.title}
            maxLength={140}
            placeholder="Site labourers & catering"
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="jo-company">Company / project</label>
          <input
            id="jo-company"
            className="input"
            value={form.company}
            maxLength={140}
            placeholder="Ward upgrade consortium"
            onChange={(e) => set({ company: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Types of work needed</label>
          <div className="chip-row" style={{ marginTop: 6 }}>
            {workTypes.map((w) => (
              <button
                key={w.code}
                type="button"
                className={`chip ${form.workTypes.includes(w.code) ? 'on' : ''}`}
                onClick={() => toggleType(w.code)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="jo-desc">Details</label>
          <textarea
            id="jo-desc"
            className="input"
            rows={3}
            value={form.description}
            maxLength={600}
            placeholder="Short description shown to matched members. No CVs are held on the platform."
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="jo-email">Company contact email</label>
          <input
            id="jo-email"
            className="input"
            type="email"
            value={form.contactEmail}
            maxLength={200}
            placeholder="hr@company.example"
            onChange={(e) => set({ contactEmail: e.target.value })}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="jo-phone">Contact phone</label>
            <input
              id="jo-phone"
              className="input"
              value={form.contactPhone}
              maxLength={32}
              placeholder="+27…"
              onChange={(e) => set({ contactPhone: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="jo-closes">Closes</label>
            <input
              id="jo-closes"
              className="input"
              type="date"
              value={form.closesAt}
              onChange={(e) => set({ closesAt: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="jo-url">Application URL</label>
          <input
            id="jo-url"
            className="input"
            type="url"
            value={form.contactUrl}
            maxLength={300}
            placeholder="https://company.example/apply"
            onChange={(e) => set({ contactUrl: e.target.value })}
          />
        </div>

        <p className="hint-text">
          At least one company contact is required. Publishing relays an in-app alert and an email to
          matched members in the ward; they apply directly to the company.
        </p>
      </div>
    </Sheet>
  );
}
