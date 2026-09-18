'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { moduleOn, ModuleKey } from '../../lib/modules';
import { Icon, Sheet, Toggle, memberLabel, useToast } from '../ui';
import IdCardSheet from '../IdCardSheet';
import { REGIONS, STATUSES, TIERS } from './FilterBar';
import type { Member, MemberPii, MemberStatus, MemberTier } from '../../types';

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  tier: MemberTier;
  status: MemberStatus;
  regionCode: string;
  districtCode: string;
  ward: string;
  lat: string;
  lng: string;
  heatWeight: string;
  tags: string;
  emailOptin: boolean;
  smsOptin: boolean;
  phoneOptin: boolean;
  dataShare: boolean;
}

const BLANK: FormState = {
  fullName: '',
  email: '',
  phone: '',
  address: '',
  tier: 'voter',
  status: 'pending',
  regionCode: 'CENTRAL',
  districtCode: '',
  ward: '',
  lat: '39.0',
  lng: '-98.5',
  heatWeight: '1',
  tags: '',
  emailOptin: true,
  smsOptin: false,
  phoneOptin: false,
  dataShare: false,
};

function toForm(m: Member, pii?: MemberPii | null): FormState {
  return {
    fullName: pii?.fullName ?? m.pii?.fullName ?? '',
    email: pii?.email ?? m.pii?.email ?? '',
    phone: pii?.phone ?? m.pii?.phone ?? '',
    address: pii?.address ?? m.pii?.address ?? '',
    tier: m.tier,
    status: m.status,
    regionCode: m.regionCode ?? 'CENTRAL',
    districtCode: m.districtCode ?? '',
    ward: m.ward ?? '',
    lat: m.lat?.toString() ?? '',
    lng: m.lng?.toString() ?? '',
    heatWeight: m.heatWeight.toString(),
    tags: m.tags.join(', '),
    emailOptin: m.consent?.emailOptin ?? false,
    smsOptin: m.consent?.smsOptin ?? false,
    phoneOptin: m.consent?.phoneOptin ?? false,
    dataShare: m.consent?.dataShare ?? false,
  };
}

export default function MemberSheet({
  member,
  onClose,
  onSaved,
}: {
  member: Member | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { canDecryptPii, modules } = useShell();
  const toast = useToast();
  const [editing, setEditing] = useState(member === null);
  const [form, setForm] = useState<FormState>(() => (member ? toForm(member) : BLANK));
  const [pii, setPii] = useState<MemberPii | null>(member?.pii ?? null);
  const [revealed, setRevealed] = useState(Boolean(member?.pii));
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  const set = (patch: Partial<FormState>) => setForm((p) => ({ ...p, ...patch }));

  async function revealPii() {
    if (!member) return;
    setRevealing(true);
    try {
      const full = await api.getMember(member.id, true);
      setPii(full.pii ?? null);
      setRevealed(true);
      setForm((p) => ({ ...p, ...toForm(full, full.pii) }));
      toast('PII decrypted · action audited', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Cannot decrypt PII', 'err');
    } finally {
      setRevealing(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const piiPayload = {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.address.trim() ? { address: form.address.trim() } : {}),
      };
      const base = {
        tier: form.tier,
        status: form.status,
        regionCode: form.regionCode,
        districtCode: form.districtCode.trim() || undefined,
        lat: Number(form.lat),
        lng: Number(form.lng),
        heatWeight: Number(form.heatWeight),
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        consent: {
          emailOptin: form.emailOptin,
          smsOptin: form.smsOptin,
          phoneOptin: form.phoneOptin,
          dataShare: form.dataShare,
        },
      };
      if (member) {
        await api.updateMember(member.id, {
          ...base,
          pii: piiPayload,
          ward: form.ward.trim() || null,
        });
        toast('Member updated', 'ok');
      } else {
        const ward = form.ward.trim();
        await api.createMember({
          ...base,
          pii: piiPayload,
          ...(ward ? { ward } : {}),
        });
        toast('Member added · QR party code issued', 'ok');
      }
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Save failed', 'err');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!member) return;
    setSaving(true);
    try {
      await api.deleteMember(member.id);
      toast('Member removed (soft delete)', 'ok');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Delete failed', 'err');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (member && !editing && !revealed) setPii(null);
  }, [member, editing, revealed]);

  const title = member ? (editing ? 'Edit member' : 'Member profile') : 'New member';

  return (
    <Sheet
      title={title}
      subtitle={member ? `${memberLabel(member)} · ${member.tier}` : 'Add someone to the movement'}
      onClose={onClose}
      footer={
        editing ? (
          <>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => (member ? setEditing(false) : onClose())}>
              Cancel
            </button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : member ? 'Save changes' : 'Add member'}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-danger"
              style={{ flex: 1 }}
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
              disabled={saving}
            >
              <Icon name="trash" size={16} /> {confirmDelete ? 'Confirm?' : 'Delete'}
            </button>
            <button className="btn btn-gold" style={{ flex: 1.2 }} onClick={() => setCardOpen(true)}>
              <Icon name="qr" size={16} /> Party card
            </button>
            <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={() => setEditing(true)}>
              <Icon name="edit" size={16} /> Edit
            </button>
          </>
        )
      }
    >
      {editing ? (
        <div className="form-grid">
          <div className="full field">
            <label>Full name *</label>
            <input className="input" value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} />
          </div>
          <div className="full field">
            <label>Email *</label>
            <input className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </div>
          <div className="field">
            <label>Phone</label>
            <input className="input" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+1 555 0100" />
          </div>
          <div className="field">
            <label>Membership #</label>
            <input className="input" value={member?.membershipNo ?? ''} disabled placeholder="auto" />
          </div>
          <div className="full field">
            <label>Address</label>
            <input className="input" value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder="Street, city" />
          </div>
          <div className="field">
            <label>Tier</label>
            <select className="select" value={form.tier} onChange={(e) => set({ tier: e.target.value as MemberTier })}>
              {TIERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={form.status} onChange={(e) => set({ status: e.target.value as MemberStatus })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Region *</label>
            <select className="select" value={form.regionCode} onChange={(e) => set({ regionCode: e.target.value })}>
              {REGIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>District</label>
            <input className="input" value={form.districtCode} onChange={(e) => set({ districtCode: e.target.value })} placeholder="CENT-D1" />
          </div>
          <div className="field">
            <label>Ward</label>
            <input className="input" value={form.ward} maxLength={64} onChange={(e) => set({ ward: e.target.value })} placeholder="12" />
          </div>
          <div className="field">
            <label>Latitude *</label>
            <input className="input" inputMode="decimal" value={form.lat} onChange={(e) => set({ lat: e.target.value })} />
          </div>
          <div className="field">
            <label>Longitude *</label>
            <input className="input" inputMode="decimal" value={form.lng} onChange={(e) => set({ lng: e.target.value })} />
          </div>
          <div className="field">
            <label>Heat weight</label>
            <input className="input" inputMode="decimal" value={form.heatWeight} onChange={(e) => set({ heatWeight: e.target.value })} />
          </div>
          <div className="full field">
            <label>Tags (comma separated)</label>
            <input className="input" value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="canvass, donor-2026" />
          </div>

          <div className="full card" style={{ boxShadow: 'none', padding: 12 }}>
            <div className="card-title" style={{ marginBottom: 8 }}>Consent</div>
            <ConsentRow label="Email outreach" on={form.emailOptin} onChange={(v) => set({ emailOptin: v })} />
            <ConsentRow label="SMS outreach" on={form.smsOptin} onChange={(v) => set({ smsOptin: v })} />
            <ConsentRow label="Phone calls" on={form.phoneOptin} onChange={(v) => set({ phoneOptin: v })} />
            <ConsentRow label="Coalition data-share" on={form.dataShare} onChange={(v) => set({ dataShare: v })} />
          </div>
        </div>
      ) : (
        <>
          {/* identity */}
          <div className="card" style={{ boxShadow: 'none', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className={`member-avatar t-${member?.tier}`}>
              {(pii?.fullName ?? member?.pii?.fullName ?? '??')
                .split(/\s+/)
                .slice(0, 2)
                .map((p) => p[0]?.toUpperCase())
                .join('')}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="member-name">
                {pii?.fullName ?? member?.pii?.fullName ?? 'Sealed member'}
              </div>
              <div className="member-meta">
                {pii?.email ?? member?.pii?.email ?? 'contact sealed (encrypted)'}
              </div>
            </div>
            <span className="badge tier">{member?.tier}</span>
          </div>

          {/* status kv */}
          <div className="card" style={{ boxShadow: 'none', marginTop: 10 }}>
            <div className="kv"><span className="k">Status</span><span className="v">{member?.status}</span></div>
            <div className="kv"><span className="k">Region</span><span className="v">{member?.regionCode ?? '—'}</span></div>
            <div className="kv"><span className="k">District</span><span className="v">{member?.districtCode ?? '—'}</span></div>
            <div className="kv"><span className="k">Ward</span><span className="v">{member?.ward ?? '—'}</span></div>
            <div className="kv"><span className="k">Party code</span><span className="v">{member?.publicCode ?? 'issued on first card'}</span></div>
            <div className="kv"><span className="k">Coordinates</span><span className="v">{member?.lat?.toFixed(3)}, {member?.lng?.toFixed(3)}</span></div>
            <div className="kv"><span className="k">Heat weight</span><span className="v">{member?.heatWeight}</span></div>
            <div className="kv"><span className="k">Tags</span><span className="v">{member?.tags.join(', ') || '—'}</span></div>
            <div className="kv"><span className="k">Joined</span><span className="v">{member?.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : 'not confirmed'}</span></div>
            <div className="kv"><span className="k">Record created</span><span className="v">{member ? new Date(member.createdAt).toLocaleDateString() : ''}</span></div>
          </div>

          {/* PII */}
          <div className="card" style={{ boxShadow: 'none', marginTop: 10 }}>
            <div className="card-title">
              Contact (PII) <span className="muted">field-level encrypted</span>
            </div>
            {canDecryptPii ? (
              revealed && pii ? (
                <>
                  <div className="kv"><span className="k">Name</span><span className="v">{pii.fullName}</span></div>
                  <div className="kv"><span className="k">Email</span><span className="v">{pii.email}</span></div>
                  <div className="kv"><span className="k">Phone</span><span className="v">{pii.phone ?? '—'}</span></div>
                  <div className="kv"><span className="k">Address</span><span className="v">{pii.address ?? '—'}</span></div>
                </>
              ) : (
                <button className="btn btn-ghost btn-block btn-sm" onClick={revealPii} disabled={revealing}>
                  <Icon name={revealing ? 'refresh' : 'eye'} size={16} />
                  {revealing ? 'Decrypting…' : 'Reveal contact (audited)'}
                </button>
              )
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
                <Icon name="lock" size={16} /> Your role cannot decrypt PII. Sealed at rest.
              </div>
            )}
          </div>

          {/* consent */}
          <div className="card" style={{ boxShadow: 'none', marginTop: 10 }}>
            <div className="card-title">Consent</div>
            <ConsentRow label="Email outreach" on={member?.consent?.emailOptin ?? false} readOnly />
            <ConsentRow label="SMS outreach" on={member?.consent?.smsOptin ?? false} readOnly />
            <ConsentRow label="Phone calls" on={member?.consent?.phoneOptin ?? false} readOnly />
            <ConsentRow label="Coalition data-share" on={member?.consent?.dataShare ?? false} readOnly />
          </div>

          {/*
            QR party card. Gated on the `id_cards` module: the card is that
            module's only surface and it owns no permission (it rides on
            member:read), so `caps` cannot hide it — ask `moduleOn` directly.
            When the module is off the button hides, matching the server, which
            403s `GET /public/card/:id` via requireModule('id_cards').
          */}
          {moduleOn(modules, ModuleKey.ID_CARDS) && (
            <button className="btn btn-gold btn-block" style={{ marginTop: 12 }} onClick={() => setCardOpen(true)}>
              <Icon name="qr" size={17} /> Party ID card & QR
            </button>
          )}
        </>
      )}

      {cardOpen && member && <IdCardSheet memberId={member.id} onClose={() => setCardOpen(false)} />}
    </Sheet>
  );
}

function ConsentRow({
  label,
  on,
  onChange,
  readOnly,
}: {
  label: string;
  on: boolean;
  onChange?: (v: boolean) => void;
  readOnly?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>{label}</span>
      {readOnly ? (
        <span className={`badge ${on ? 'ok' : ''}`}>{on ? 'granted' : 'off'}</span>
      ) : (
        <Toggle on={on} onChange={(v) => onChange?.(v)} />
      )}
    </div>
  );
}
