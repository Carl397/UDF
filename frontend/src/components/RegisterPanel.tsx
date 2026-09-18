'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { JOIN_TIERS, REGIONS, prettyRegion, type JoinTier } from '../lib/taxonomy';
import { Icon, Toggle, useToast } from './ui';
import Autocomplete, { type AutocompleteOption } from './Autocomplete';
import type { PublicMeta, RegisterResult } from '../types';

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  suburbCode: string;
  regionCode: string;
  districtCode: string;
  ward: string;
  tier: JoinTier;
  motivation: string;
  referral: string;
  emailOptin: boolean;
  smsOptin: boolean;
  phoneOptin: boolean;
  dataShare: boolean;
  tcAccepted: boolean;
}

const blank = (regionCode: string, referral: string): FormState => ({
  fullName: '',
  email: '',
  phone: '',
  address: '',
  suburbCode: '',
  regionCode,
  districtCode: '',
  ward: '',
  tier: 'voter',
  motivation: '',
  referral,
  emailOptin: true,
  smsOptin: false,
  phoneOptin: false,
  dataShare: false,
  tcAccepted: false,
});

/**
 * The membership application form.
 *
 * Deliberately free of any app-shell dependency so the public `/register`
 * website page and the in-app "More → Member registration form" screen render
 * exactly the same thing.
 */
export default function RegisterPanel({
  defaultRegion = '',
  referralCode,
  onSuccess,
}: {
  defaultRegion?: string;
  referralCode?: string | null;
  onSuccess?: (r: RegisterResult) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => blank(defaultRegion, referralCode ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);
  /**
   * The public administrative tree. Fetched once — the register form uses it to
   * build the A-Z type-ahead lists for ward and district, and to auto-fill the
   * district when the applicant picks a ward. `null` until it lands, in which
   * case the fields fall back to plain text inputs so the form still works.
   */
  const [meta, setMeta] = useState<PublicMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .publicMeta()
      .then((m) => !cancelled && setMeta(m))
      .catch(() => !cancelled && setMeta(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Full cascade: ward → subcouncil → region.  Migration 018 re-parented the
  // 20 subcouncils under the 5 planning regions, so picking a ward now fills
  // both District and Region automatically.
  const { regionOptions, districtOptions, wardOptions, wardByCode, districtByCode, suburbOptions } = useMemo(() => {
    const rows = meta?.regions ?? [];
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const regions = rows
      .filter((r) => r.level === 'region')
      .map((r) => ({ code: r.code, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const districts: AutocompleteOption[] = rows
      .filter((r) => r.level === 'subcouncil')
      .map((r) => {
        const parent = r.parentCode ? byCode.get(r.parentCode) : null;
        return {
          value: r.code,
          label: r.name,
          hint: parent ? `${parent.name} · ${r.code}` : r.code,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const wards: AutocompleteOption[] = rows
      .filter((r) => r.level === 'ward')
      .map((r) => {
        const district = r.parentCode ? byCode.get(r.parentCode) : null;
        const region = district?.parentCode ? byCode.get(district.parentCode) : null;
        return {
          value: r.code,
          label: `Ward ${r.name}`,
          hint: [district?.name, region?.name].filter(Boolean).join(' · ') || r.code,
        };
      })
      // Natural A-Z so "Ward 2" comes before "Ward 10".
      .sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
      );
    // Suburbs: used for the address dropdown. Each suburb's parentCode is its
    // ward, so the list narrows when the applicant picks a ward.
    const suburbs: AutocompleteOption[] = rows
      .filter((r) => r.level === 'suburb')
      .map((r) => {
        const ward = r.parentCode ? byCode.get(r.parentCode) : null;
        const district = ward?.parentCode ? byCode.get(ward.parentCode) : null;
        const region = district?.parentCode ? byCode.get(district.parentCode) : null;
        return {
          value: r.code,
          label: r.name,
          hint: [ward ? `Ward ${ward.name}` : null, district?.name, region?.name]
            .filter(Boolean)
            .join(' · ') || undefined,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return {
      regionOptions: regions,
      districtOptions: districts,
      wardOptions: wards,
      wardByCode: new Map(rows.filter((r) => r.level === 'ward').map((r) => [r.code, r])),
      districtByCode: new Map(rows.filter((r) => r.level === 'subcouncil').map((r) => [r.code, r])),
      suburbOptions: suburbs,
    };
  }, [meta]);

  // Narrow the district list to the chosen region so the type-ahead stays short.
  const filteredDistrictOptions = useMemo(() => {
    if (!form.regionCode) return districtOptions;
    return districtOptions.filter((d) => {
      const row = districtByCode.get(d.value);
      return row?.parentCode === form.regionCode;
    });
  }, [districtOptions, districtByCode, form.regionCode]);

  // Narrow wards by district when one is selected; otherwise use the selected
  // region. This keeps the picker geographically correct without forcing an
  // applicant to know their district before choosing a ward.
  const filteredWardOptions = useMemo(() => {
    if (form.districtCode) {
      return wardOptions.filter((w) => wardByCode.get(w.value)?.parentCode === form.districtCode);
    }
    if (form.regionCode) {
      return wardOptions.filter((w) => {
        const districtCode = wardByCode.get(w.value)?.parentCode;
        return districtCode ? districtByCode.get(districtCode)?.parentCode === form.regionCode : false;
      });
    }
    return wardOptions;
  }, [wardOptions, wardByCode, districtByCode, form.districtCode, form.regionCode]);

  // Narrow the suburb list to the chosen ward so the address dropdown stays
  // short and relevant. Falls back to the full A-Z list while no ward is picked.
  const suburbByCode = useMemo(
    () => new Map((meta?.regions ?? []).filter((r) => r.level === 'suburb').map((r) => [r.code, r])),
    [meta],
  );
  // Group suburbs by their parent ward so the ward picker can auto-fill when a
  // ward has exactly one suburb.
  const suburbsByWard = useMemo(() => {
    const m = new Map<string, AutocompleteOption[]>();
    for (const s of suburbOptions) {
      const ward = suburbByCode.get(s.value)?.parentCode;
      if (!ward) continue;
      const list = m.get(ward);
      if (list) list.push(s);
      else m.set(ward, [s]);
    }
    return m;
  }, [suburbOptions, suburbByCode]);
  const filteredSuburbOptions = useMemo(() => {
    if (!form.ward) return suburbOptions;
    return suburbOptions.filter((s) => suburbByCode.get(s.value)?.parentCode === form.ward);
  }, [suburbOptions, suburbByCode, form.ward]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // On the public `/register` page the referral code comes from `?ref=`, which
  // the statically prerendered HTML does not know — it arrives only after mount,
  // i.e. after the form state above was seeded. Fill it in then, but never
  // overwrite something the applicant typed themselves.
  useEffect(() => {
    if (!referralCode) return;
    setForm((f) => (f.referral ? f : { ...f, referral: referralCode }));
  }, [referralCode]);

  async function submit() {
    setError(null);
    if (form.fullName.trim().length < 2) return setError('Please enter the full name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return setError('A valid email is required');
    if (!form.regionCode) return setError('Choose a region');
    if (!form.ward.trim()) return setError('Choose your ward');
    if (!form.tcAccepted) return setError('You must accept the Terms & Conditions to register');

    setBusy(true);
    try {
      const res = await api.registerMember({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.address.trim() ? { address: form.address.trim() } : {}),
        regionCode: form.regionCode,
        ...(form.districtCode.trim() ? { districtCode: form.districtCode.trim() } : {}),
        ...(form.ward.trim() ? { ward: form.ward.trim() } : {}),
        tier: form.tier,
        ...(form.motivation.trim() ? { motivation: form.motivation.trim() } : {}),
        ...(form.referral.trim() ? { referral: form.referral.trim() } : {}),
        consent: {
          emailOptin: form.emailOptin,
          smsOptin: form.smsOptin,
          phoneOptin: form.phoneOptin,
          dataShare: form.dataShare,
        },
        tcAccepted: true,
      });
      setResult(res);
      onSuccess?.(res);
      toast('Application captured — starter pack emailed', 'ok');
    } catch (e: any) {
      setError(e?.message ?? 'Could not submit the application');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Registered
        result={result}
        onAnother={() => {
          setResult(null);
          setForm(blank(defaultRegion, ''));
        }}
      />
    );
  }

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      {meta && (
        <>
          <div className="section-label">What we stand for</div>
          <div className="chip-row">
            {meta.standsFor.map((item) => (
              <span key={item} className="chip on">
                {item}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Who is joining</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="r-name">Full name *</label>
          <input
            id="r-name"
            className="input"
            value={form.fullName}
            maxLength={200}
            autoComplete="name"
            onChange={(e) => set({ fullName: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-email">Email *</label>
          <input
            id="r-email"
            className="input"
            type="email"
            value={form.email}
            maxLength={320}
            autoComplete="email"
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-phone">Phone</label>
          <input
            id="r-phone"
            className="input"
            value={form.phone}
            maxLength={32}
            placeholder="+27 82 000 0000"
            autoComplete="tel"
            onChange={(e) => set({ phone: e.target.value })}
          />
        </div>
      </div>

      <div className="section-label">Where you stand</div>
      <p className="field-hint geography-intro">
        Start with your area to fill the ward, district and region automatically, or select a ward first.
      </p>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="r-addr">Area / suburb</label>
          {meta ? (
            <Autocomplete
              id="r-addr"
              value={form.suburbCode}
              options={filteredSuburbOptions}
              placeholder="Start typing your area or suburb"
              maxLength={200}
              strict
              emptyMessage={form.ward ? 'No area matches the selected ward' : 'No area matches your search'}
              onChange={(_next, option) => {
                if (option) {
                  // Picking an area cascades UP: suburb → ward → district → region.
                  const suburbRow = suburbByCode.get(option.value);
                  const wardCode = suburbRow?.parentCode ?? '';
                  const wardRow = wardCode ? wardByCode.get(wardCode) : null;
                  const scCode = wardRow?.parentCode ?? '';
                  const scRow = scCode ? districtByCode.get(scCode) : null;
                  const regionCode = scRow?.parentCode ?? '';
                  set({
                    suburbCode: option.value,
                    address: `${option.label}, Cape Town`,
                    ...(wardCode ? { ward: wardCode } : {}),
                    ...(scCode ? { districtCode: scCode } : {}),
                    ...(regionCode ? { regionCode } : {}),
                  });
                }
              }}
            />
          ) : (
            <input
              id="r-addr"
              className="input"
              value={form.address}
              maxLength={500}
              placeholder="Enter area or suburb"
              autoComplete="address-level2"
              onChange={(e) => set({ address: e.target.value })}
            />
          )}
          <small className="field-hint">
            {form.ward
              ? 'The list is limited to the selected ward.'
              : 'Selecting an area fills its ward, district and region.'}
          </small>
        </div>
        <div className="field">
          <label htmlFor="r-region">Region *</label>
          <select
            id="r-region"
            className="input"
            value={form.regionCode}
            onChange={(e) => {
              const next = e.target.value;
              // Changing the region invalidates a district (and its ward) that
              // belonged to the previous one — clear them so the pickers show
              // the fresh A-Z lists for the new region.
              const scRow = form.districtCode ? districtByCode.get(form.districtCode) : null;
              const districtStillFits = !form.districtCode || scRow?.parentCode === next;
              set({
                regionCode: next,
                ...(districtStillFits ? {} : { districtCode: '', ward: '', suburbCode: '', address: '' }),
              });
            }}
          >
            <option value="">Select region</option>
            {/* Server-fed list (5 regions, A-Z) with a hard-coded fallback so
                the form still renders if `/public/meta` has not landed. */}
            {(regionOptions.length ? regionOptions.map((r) => r.code) : REGIONS).map((r) => (
              <option key={r} value={r}>
                {prettyRegion(r)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-ward">Ward *</label>
          {wardOptions.length ? (
            <Autocomplete
              id="r-ward"
              value={form.ward}
              options={filteredWardOptions}
              placeholder="Type ward number or subcouncil"
              maxLength={64}
              strict
              emptyMessage="No ward matches this number or subcouncil"
              onChange={(next, option) => {
                if (option) {
                  // Picking a known ward auto-fills its parent subcouncil AND
                  // the subcouncil's parent region — the full cascade.
                  const row = wardByCode.get(option.value);
                  const scCode = row?.parentCode ?? '';
                  const scRow = scCode ? districtByCode.get(scCode) : null;
                  const regionCode = scRow?.parentCode ?? '';
                  // If the ward has exactly one suburb, auto-fill the address.
                  const wardSuburbs = suburbsByWard.get(option.value) ?? [];
                  const sole = wardSuburbs.length === 1 ? wardSuburbs[0]! : null;
                  set({
                    ward: option.value,
                    ...(scCode ? { districtCode: scCode } : {}),
                    ...(regionCode ? { regionCode } : {}),
                    suburbCode: sole?.value ?? '',
                    address: sole ? `${sole.label}, Cape Town` : '',
                  });
                } else {
                  set({ ward: next, suburbCode: '', address: '' });
                }
              }}
            />
          ) : (
            <input
              id="r-ward"
              className="input"
              value={form.ward}
              maxLength={64}
              placeholder="12"
              onChange={(e) => set({ ward: e.target.value })}
            />
          )}
          <small className="field-hint">Search by ward number or subcouncil; selecting one updates Area.</small>
        </div>
        <div className="field">
          <label htmlFor="r-district">District / branch</label>
          {districtOptions.length ? (
            <Autocomplete
              id="r-district"
              value={form.districtCode}
              options={filteredDistrictOptions}
              placeholder="Select district / branch"
              maxLength={32}
              emptyMessage="No district matches this region"
              onChange={(next, option) => {
                // Changing the district invalidates a ward that belonged to the
                // previous one — clear it so the picker shows the fresh A-Z list
                // for the new district instead of a stale code the applicant
                // would have to notice and delete by hand.
                const currentWard = next ? wardByCode.get(form.ward) : null;
                const wardStillFits = !form.ward || currentWard?.parentCode === next;
                // Auto-fill region from the district's parent.
                const scRow = option ? districtByCode.get(option.value) : null;
                const regionCode = scRow?.parentCode ?? '';
                set({
                  districtCode: next,
                  ...(wardStillFits ? {} : { ward: '', suburbCode: '', address: '' }),
                  ...(regionCode ? { regionCode } : {}),
                });
              }}
            />
          ) : (
            <input
              id="r-district"
              className="input"
              value={form.districtCode}
              maxLength={32}
              placeholder="CENT-D1"
              onChange={(e) => set({ districtCode: e.target.value })}
            />
          )}
          <small className="field-hint">Optional. You can select a ward directly if you do not know it.</small>
        </div>
        <div className="field full">
          <label htmlFor="r-ref">Referred by (party code)</label>
          <input
            id="r-ref"
            className="input"
            value={form.referral}
            maxLength={64}
            placeholder="UDF-ABC-XYZ"
            onChange={(e) => set({ referral: e.target.value.toUpperCase() })}
          />
        </div>
      </div>

      <div className="section-label">How you want to serve</div>
      <div className="rows">
        {JOIN_TIERS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`row ${form.tier === t.value ? 'on' : ''}`}
            onClick={() => set({ tier: t.value })}
            aria-pressed={form.tier === t.value}
          >
            <span className="row-ico">
              <Icon name={form.tier === t.value ? 'checkCircle' : 'flag'} />
            </span>
            <span className="row-main">
              <span className="row-title">{t.label}</span>
              <span className="row-sub">{t.hint}</span>
            </span>
            {form.tier === t.value && <span className="badge ok">selected</span>}
          </button>
        ))}
      </div>

      <div className="section-label">Why you are joining</div>
      <div className="field">
        <textarea
          className="input"
          rows={3}
          value={form.motivation}
          maxLength={1000}
          placeholder="Service delivery in my ward has failed. I want to organize."
          onChange={(e) => set({ motivation: e.target.value })}
        />
      </div>

      <div className="section-label">Consent</div>
      <div className="card">
        <ConsentRow
          label="Email me news & events"
          on={form.emailOptin}
          onChange={(v) => set({ emailOptin: v })}
        />
        <ConsentRow label="SMS / WhatsApp alerts" on={form.smsOptin} onChange={(v) => set({ smsOptin: v })} />
        <ConsentRow
          label="Phone calls from organizers"
          on={form.phoneOptin}
          onChange={(v) => set({ phoneOptin: v })}
        />
        <ConsentRow
          label="Print my contact on my party card"
          hint="Off means the QR page shows membership and ward only"
          on={form.dataShare}
          onChange={(v) => set({ dataShare: v })}
        />
      </div>

      <label className="tc-check" htmlFor="r-tc">
        <input
          id="r-tc"
          type="checkbox"
          checked={form.tcAccepted}
          onChange={(e) => set({ tcAccepted: e.target.checked })}
        />
        <span>
          I have read and accept the{' '}
          <a href="/terms" target="_blank" rel="noreferrer">
            Terms &amp; Conditions
          </a>{' '}
          and the privacy notice.
          <span className="tc-req">Required</span>
        </span>
      </label>

      <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={submit} disabled={busy}>
        <Icon name="send" size={17} /> {busy ? 'Submitting…' : 'Submit application'}
      </button>

      <p className="hint-text" style={{ marginTop: 10 }}>
        Submitting creates a pending membership, seals your contact details with field-level
        encryption, and emails a starter pack containing a one-time sign-in code. Signing in
        and setting a password activates the membership and issues the QR party card code.
      </p>
    </>
  );
}

function ConsentRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="consent-row">
      <span className="consent-main">
        <span className="consent-label">{label}</span>
        {hint && <span className="consent-hint">{hint}</span>}
      </span>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/** Shown after a successful registration: the links an organizer hands over. */
function Registered({
  result,
  onAnother,
}: {
  result: RegisterResult;
  onAnother: () => void;
}) {
  return (
    <>
      <div className="banner ok" style={{ marginTop: 10 }}>
        <Icon name="checkCircle" size={17} />
        <span>
          <strong>Application captured.</strong> Membership {result.membershipNo} —{' '}
          a starter pack with sign-in details has been emailed.
        </span>
      </div>

      <div className="card" style={{ marginTop: 12, textAlign: 'center' }}>
        <div className="mini-label">Party code</div>
        <div className="code-line" style={{ marginTop: 2 }}>{result.publicCode}</div>
      </div>

      <div className="banner" style={{ marginTop: 12 }}>
        <Icon name="send" size={15} />
        <span>A starter pack with sign-in details has been emailed to the member.</span>
      </div>

      <button className="btn btn-ghost btn-block" style={{ marginTop: 14 }} onClick={onAnother}>
        <Icon name="plus" size={16} /> Register another member
      </button>
    </>
  );
}
