'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { api } from '../../lib/api';
import { CrmCard, CrmButton, CrmSmallButton } from './ui';
import {
  DEFAULT_CARD_DESIGN,
  cardPixelSize,
  loadImage,
  renderCard,
  type CardAssets,
} from '../../lib/cardRender';
import { shrinkImage } from '../../lib/image';
import { CARD_LOGO_UPLOAD_MAX, formatBytes } from '../../lib/uploadLimits';
import type { CardDesign, CardDesignView, FieldKey, PartyCard, SizePreset } from '../../types';

/**
 * CRM Settings ▸ ID Card Studio. National-admin only (mounted behind a
 * `role === 'national_admin'` guard; the API is gated on `module:manage`).
 *
 * One global template drives every party ID card in the app: physical size +
 * export scale (up to 1000%), palette, border, the editable branding wording,
 * the party logo, which identity fields show (and their order/labels), the
 * member-photo slot and the QR. The preview below is drawn by the SAME renderer
 * (`lib/cardRender`) that paints the downloadable card and the batch print sheet,
 * so what you see is exactly what prints. Saving takes effect immediately for
 * every card, with no redeploy.
 */

// ── Sample data for the live preview ─────────────────────────────────────────
const SAMPLE_CARD: PartyCard = {
  memberId: '00000000-0000-0000-0000-000000000000',
  membershipNo: 'UDF-000123',
  publicCode: 'UDF-DEMO-0001',
  tier: 'candidate',
  status: 'active',
  regionCode: 'WC-001',
  districtCode: 'DC-001',
  ward: '12',
  joinedAt: '2024-01-15T00:00:00.000Z',
  mandateAcceptedAt: '2024-01-16T00:00:00.000Z',
  roles: [{ name: 'ward_councillor', title: 'Ward Councillor', ward: '12', status: 'confirmed' }],
  identity: { fullName: 'Jane Demo' },
  party: {
    name: 'UDF',
    fullName: 'United Democratic Front',
    tagline: 'One flag · One movement',
    slogan: 'Service before self',
    colors: { red: '#E0271E', black: '#141414', gold: '#F7C31D' },
    contacts: {
      phone: '+27 21 000 0000',
      whatsapp: '+27 21 000 0000',
      email: 'info@udf.org.za',
      press: 'press@udf.org.za',
      website: 'udf.org.za',
      address: 'Cape Town, South Africa',
    },
    officeHours: 'Mon–Fri 08:00–17:00',
    joinUrl: '/register',
  },
  verifyUrl: 'https://udf.org.za/v/UDF-DEMO-0001',
  joinUrl: 'https://udf.org.za/register',
  vcardUrl: 'https://udf.org.za/v/UDF-DEMO-0001.vcf',
  design: DEFAULT_CARD_DESIGN,
  photo: null,
};

const FIELD_LABEL: Record<FieldKey, string> = {
  membershipNo: 'Membership',
  office: 'Office',
  ward: 'Ward',
  region: 'Region',
  status: 'Status',
  tier: 'Tier',
  joinedYear: 'Joined',
  publicCode: 'Public code',
};

const LOGO_POS = [
  { value: 'flagTop', label: 'Flag · top' },
  { value: 'flagBottom', label: 'Flag · bottom' },
  { value: 'bodyTop', label: 'Body · top' },
  { value: 'topRight', label: 'Top right' },
  { value: 'bottomLeft', label: 'Bottom left' },
];
const PHOTO_SHAPE = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'circle', label: 'Circle' },
];
const PHOTO_POS = [
  { value: 'left', label: 'Left of body' },
  { value: 'right', label: 'Right of body' },
  { value: 'flagTop', label: 'Flag · top' },
];
const QR_POS = [
  { value: 'bottomRight', label: 'Bottom right' },
  { value: 'bottomLeft', label: 'Bottom left' },
  { value: 'right', label: 'Right' },
  { value: 'bottomCenter', label: 'Bottom centre' },
];
const BORDER_STYLE = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'double', label: 'Double' },
  { value: 'dashed', label: 'Dashed' },
];
const PAPER = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'US Letter' },
  { value: 'a3', label: 'A3' },
  { value: 'a6', label: 'A6' },
];
const ORIENTATION = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A neutral portrait so the photo slot is visible in the preview before any upload. */
function placeholderPhoto(): string {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 500;
  const x = c.getContext('2d');
  if (!x) return '';
  const g = x.createLinearGradient(0, 0, 0, 500);
  g.addColorStop(0, '#e7e5e4');
  g.addColorStop(1, '#d6d3d1');
  x.fillStyle = g;
  x.fillRect(0, 0, 400, 500);
  x.fillStyle = '#a8a29e';
  x.beginPath();
  x.arc(200, 185, 78, 0, Math.PI * 2);
  x.fill();
  x.beginPath();
  x.ellipse(200, 430, 145, 125, 0, Math.PI, 0);
  x.fill();
  return c.toDataURL('image/png');
}

// ── Small form controls (inline-styled to match the CRM surface) ─────────────
const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  border: '1px solid #e7e5e4',
  borderRadius: 8,
  background: '#fff',
  color: '#1c1917',
  boxSizing: 'border-box',
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#78716c' }}>
        {label}
      </span>
      {children}
      {hint && <span style={{ fontSize: 11, color: '#a8a29e' }}>{hint}</span>}
    </label>
  );
}

function Grid({ cols = 2, children }: { cols?: number; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12 }}>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: 'none', padding: 0, position: 'relative',
        cursor: 'pointer', background: on ? '#16a34a' : '#d6d3d1', transition: 'background .15s', flex: 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s',
      }} />
    </button>
  );
}

function ToggleRow({ label, on, onChange, hint }: { label: string; on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Toggle on={on} onChange={onChange} label={label} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1c1917' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: '#a8a29e' }}>{hint}</div>}
      </div>
    </div>
  );
}

function Select<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} style={inputStyle}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function NumInput({ value, onChange, min, max, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange(clamp(n, min, max)); }}
        style={inputStyle}
      />
      {suffix && <span style={{ fontSize: 12, color: '#78716c', whiteSpace: 'nowrap' }}>{suffix}</span>}
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // <input type=color> only speaks 6-digit hex; keep the text box so 8-digit
  // (alpha) values like the muted/border colours survive editing.
  const swatch = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value.slice(0, 7) : '#000000';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="color" value={swatch}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 40, height: 34, padding: 0, border: '1px solid #e7e5e4', borderRadius: 8, background: '#fff', cursor: 'pointer', flex: 'none' }}
      />
      <input
        type="text" value={value} maxLength={9}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
    </div>
  );
}

function Range({ value, onChange, min, max, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
        style={{ flex: 1 }}
      />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#1c1917', minWidth: 58, textAlign: 'right' }}>
        {value}{suffix}
      </span>
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────
export default function IdCardStudio() {
  const [view, setView] = useState<CardDesignView | null>(null);
  const [design, setDesign] = useState<CardDesign>(DEFAULT_CARD_DESIGN);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  const [photoImg, setPhotoImg] = useState<HTMLImageElement | null>(null);
  const [qrImg, setQrImg] = useState<HTMLImageElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const logoUrlRef = useRef<string | null>(null);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    window.setTimeout(() => setMsg(null), 4500);
  };

  const update = useCallback((mut: (d: CardDesign) => void) => {
    setDesign((prev) => {
      const next: CardDesign = JSON.parse(JSON.stringify(prev));
      mut(next);
      return next;
    });
  }, []);

  const loadLogo = useCallback(async (mediaId: string | null) => {
    if (logoUrlRef.current) {
      URL.revokeObjectURL(logoUrlRef.current);
      logoUrlRef.current = null;
    }
    if (!mediaId) { setLogoImg(null); return; }
    const blob = await api.cardMediaBlob(mediaId);
    if (blob) {
      const u = URL.createObjectURL(blob);
      logoUrlRef.current = u;
      setLogoImg(await loadImage(u));
    } else {
      setLogoImg(null);
    }
  }, []);

  // Bootstrap: the design + studio metadata, plus the fixed preview assets (QR +
  // the neutral placeholder portrait).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const v = await api.cardDesign();
        if (!live) return;
        setView(v);
        setDesign(v.design);
        await loadLogo(v.design.logo.mediaId);
      } catch {
        if (live) flash('err', 'Could not load the card studio. It needs national-admin rights.');
      } finally {
        if (live) setLoading(false);
      }
      const qrUrl = await QRCode.toDataURL(SAMPLE_CARD.verifyUrl, {
        margin: 1, width: 640, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#ffffff' },
      });
      if (live) setQrImg(await loadImage(qrUrl));
      if (live) setPhotoImg(await loadImage(placeholderPhoto()));
    })();
    return () => { live = false; };
  }, [loadLogo]);

  useEffect(() => () => { if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current); }, []);

  // Live preview: repaint on any design or asset change.
  const assets: CardAssets = { logo: logoImg, photo: photoImg, qr: qrImg };
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !qrImg) return;
    renderCard(cv, SAMPLE_CARD, design, assets, { widthPx: 720 });
  }, [design, logoImg, photoImg, qrImg, assets]);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.saveCardDesign(design);
      setDesign(res.design);
      await loadLogo(res.design.logo.mediaId);
      flash('ok', 'Card design saved — every ID card now uses it.');
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not save the design.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDesign(JSON.parse(JSON.stringify(DEFAULT_CARD_DESIGN)));
    flash('ok', 'Reset to the classic design — press Save to apply.');
  }

  async function downloadSample() {
    if (busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      const { w, h, clamped } = renderCard(canvas, SAMPLE_CARD, design, assets);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not export the sample');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `udf-card-sample-${w}x${h}.png`;
      a.click();
      URL.revokeObjectURL(url);
      flash('ok', clamped ? `Sample exported (${w}×${h}px — reduced to the canvas limit).` : `Sample exported (${w}×${h}px).`);
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not export the sample.');
    } finally {
      setBusy(false);
    }
  }

  async function onLogoFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await shrinkImage(file, { mime: 'image/png', budget: CARD_LOGO_UPLOAD_MAX, steps: [[1024, 1], [768, 1], [512, 1]] });
      if (dataUrl.length > CARD_LOGO_UPLOAD_MAX) throw new Error(`Logo exceeds ${formatBytes(CARD_LOGO_UPLOAD_MAX)} after compression. Choose a smaller image.`);
      const { mediaId } = await api.uploadCardLogo(dataUrl);
      update((d) => { d.logo.mediaId = mediaId; d.logo.show = true; });
      await loadLogo(mediaId);
      flash('ok', 'Logo uploaded — press Save to apply it to every card.');
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not upload the logo.');
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(key: SizePreset) {
    update((d) => {
      d.size.preset = key;
      const meta = view?.presets[key];
      if (meta && key !== 'custom') {
        d.size.widthMm = meta.widthMm;
        d.size.heightMm = meta.heightMm;
        d.size.orientation = meta.orientation;
      }
    });
  }

  function addField(key: FieldKey) {
    update((d) => { d.fields.push({ key, label: FIELD_LABEL[key], show: true }); });
  }
  function moveField(i: number, dir: -1 | 1) {
    update((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.fields.length) return;
      const a = d.fields[i];
      const b = d.fields[j];
      if (!a || !b) return;
      d.fields[i] = b;
      d.fields[j] = a;
    });
  }

  if (loading) {
    return <CrmCard title="ID Card Studio"><p style={{ color: '#64748b' }}>Loading card studio…</p></CrmCard>;
  }

  const usedKeys = new Set(design.fields.map((f) => f.key));
  const availableKeys = (view?.fieldKeys ?? []).filter((k) => !usedKeys.has(k));
  const px = cardPixelSize(design);

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

      {view && !view.flags.designer && (
        <CrmCard title="ID Card Studio">
          <p style={{ color: '#64748b', fontSize: 13 }}>
            The card designer is switched off (<code>id_cards.designer</code> flag). Cards still render
            with the current template.
          </p>
        </CrmCard>
      )}

      <CrmCard
        title="ID Card Studio · design the party ID card"
        footer={
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <CrmButton onClick={save} disabled={busy || !(view?.flags.designer ?? true)}>Save design</CrmButton>
            <CrmButton variant="secondary" onClick={downloadSample} disabled={busy}>Download sample PNG</CrmButton>
            <CrmButton variant="secondary" onClick={reset} disabled={busy}>Reset to classic</CrmButton>
          </div>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
          {/* Sticky live preview */}
          <div style={{ position: 'sticky', top: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#78716c', marginBottom: 8 }}>
              Live preview
            </div>
            <div style={{ background: '#f5f5f4', borderRadius: 12, padding: 12 }}>
              <canvas ref={previewRef} style={{ display: 'block', width: '100%', height: 'auto' }} />
            </div>
            <div style={{ fontSize: 12, color: '#78716c', marginTop: 10, lineHeight: 1.6 }}>
              <div><strong>{design.size.widthMm} × {design.size.heightMm} mm</strong> · {design.size.orientation}</div>
              <div>Export {px.w} × {px.h} px @ {design.size.dpi} dpi · {design.size.scalePct}%{px.clamped ? ' (clamped)' : ''}</div>
              <div style={{ color: '#a8a29e' }}>Sample member — real cards pull each member&apos;s own details.</div>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <section>
              <SectionTitle>Size & export scale</SectionTitle>
              <Grid cols={2}>
                <Field label="Preset">
                  <Select<SizePreset>
                    value={design.size.preset}
                    onChange={applyPreset}
                    options={(view?.presets
                      ? (Object.keys(view.presets) as SizePreset[]).map((k) => ({ value: k, label: view.presets[k].label }))
                      : [])}
                  />
                </Field>
                <Field label="Orientation">
                  <Select<'landscape' | 'portrait'>
                    value={design.size.orientation}
                    onChange={(o) => update((d) => {
                      d.size.orientation = o;
                      const w = d.size.widthMm; const h = d.size.heightMm;
                      if (o === 'landscape' && h > w) { d.size.widthMm = h; d.size.heightMm = w; }
                      if (o === 'portrait' && w > h) { d.size.widthMm = h; d.size.heightMm = w; }
                    })}
                    options={ORIENTATION}
                  />
                </Field>
                <Field label="Width"><NumInput value={design.size.widthMm} min={20} max={600} step={0.1} suffix="mm" onChange={(v) => update((d) => { d.size.widthMm = v; d.size.preset = 'custom'; })} /></Field>
                <Field label="Height"><NumInput value={design.size.heightMm} min={20} max={600} step={0.1} suffix="mm" onChange={(v) => update((d) => { d.size.heightMm = v; d.size.preset = 'custom'; })} /></Field>
                <Field label="Print resolution"><NumInput value={design.size.dpi} min={72} max={1200} step={1} suffix="dpi" onChange={(v) => update((d) => { d.size.dpi = v; })} /></Field>
                <Field label="Export scale" hint="Up to 1000% for large-format prints.">
                  <Range value={design.size.scalePct} min={100} max={1000} step={25} suffix="%" onChange={(v) => update((d) => { d.size.scalePct = v; })} />
                </Field>
              </Grid>
            </section>

            <section>
              <SectionTitle>Wording</SectionTitle>
              <Grid cols={2}>
                <Field label="Organisation" hint="The big wordmark."><input style={inputStyle} maxLength={24} value={design.text.orgName} onChange={(e) => update((d) => { d.text.orgName = e.target.value; })} /></Field>
                <Field label="Party word"><input style={inputStyle} maxLength={24} value={design.text.partyWord} onChange={(e) => update((d) => { d.text.partyWord = e.target.value; })} /></Field>
                <Field label="Tagline" hint="Flag foot."><input style={inputStyle} maxLength={80} value={design.text.tagline} onChange={(e) => update((d) => { d.text.tagline = e.target.value; })} /></Field>
                <Field label="Slogan" hint="Body footer."><input style={inputStyle} maxLength={80} value={design.text.slogan} onChange={(e) => update((d) => { d.text.slogan = e.target.value; })} /></Field>
              </Grid>
              <div style={{ marginTop: 12 }}>
                <Field label="Footer line" hint="Blank derives “Verify: <code> · website” from the member's public code.">
                  <input style={inputStyle} maxLength={140} value={design.text.footer} placeholder="Leave blank for the auto verify line" onChange={(e) => update((d) => { d.text.footer = e.target.value; })} />
                </Field>
              </div>
            </section>

            <section>
              <SectionTitle>Colours</SectionTitle>
              <Grid cols={2}>
                <Field label="Background from"><ColorInput value={design.colors.bgFrom} onChange={(v) => update((d) => { d.colors.bgFrom = v; })} /></Field>
                <Field label="Background to"><ColorInput value={design.colors.bgTo} onChange={(v) => update((d) => { d.colors.bgTo = v; })} /></Field>
                <Field label="Flag panel"><ColorInput value={design.colors.flagPanel} onChange={(v) => update((d) => { d.colors.flagPanel = v; })} /></Field>
                <Field label="Accent"><ColorInput value={design.colors.accent} onChange={(v) => update((d) => { d.colors.accent = v; })} /></Field>
                <Field label="Text"><ColorInput value={design.colors.text} onChange={(v) => update((d) => { d.colors.text = v; })} /></Field>
                <Field label="Muted text" hint="8-digit hex = alpha."><ColorInput value={design.colors.muted} onChange={(v) => update((d) => { d.colors.muted = v; })} /></Field>
                <Field label="Border colour"><ColorInput value={design.colors.border} onChange={(v) => update((d) => { d.colors.border = v; })} /></Field>
              </Grid>
            </section>

            <section>
              <SectionTitle>Border</SectionTitle>
              <Grid cols={3}>
                <Field label="Style"><Select<'solid' | 'double' | 'dashed' | 'none'> value={design.border.style} onChange={(v) => update((d) => { d.border.style = v; })} options={BORDER_STYLE} /></Field>
                <Field label="Width"><Range value={design.border.widthPx} min={0} max={80} step={1} suffix="px" onChange={(v) => update((d) => { d.border.widthPx = v; })} /></Field>
                <Field label="Corner radius"><Range value={design.border.radiusPx} min={0} max={160} step={1} suffix="px" onChange={(v) => update((d) => { d.border.radiusPx = v; })} /></Field>
              </Grid>
            </section>

            <section>
              <SectionTitle>Party logo</SectionTitle>
              <p className="upload-limit">Logo: max {formatBytes(CARD_LOGO_UPLOAD_MAX)} encoded after automatic compression.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ToggleRow label="Show logo" on={design.logo.show} onChange={(v) => update((d) => { d.logo.show = v; })} />
                <Grid cols={2}>
                  <Field label="Position"><Select value={design.logo.position} onChange={(v) => update((d) => { d.logo.position = v as CardDesign['logo']['position']; })} options={LOGO_POS} /></Field>
                  <Field label="Width (% of card)"><Range value={design.logo.widthPct} min={2} max={100} step={1} suffix="%" onChange={(v) => update((d) => { d.logo.widthPct = v; })} /></Field>
                </Grid>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => onLogoFile(e.target.files?.[0])} />
                    <span className="crm-btn-secondary" style={btnLike}>{logoImg ? 'Replace logo' : 'Upload logo'}</span>
                  </label>
                  {logoImg && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrlRef.current ?? undefined} alt="Logo preview" style={{ height: 40, maxWidth: 120, objectFit: 'contain', background: '#fff', border: '1px solid #e7e5e4', borderRadius: 8, padding: 4 }} />
                  )}
                  {design.logo.mediaId && (
                    <CrmSmallButton danger disabled={busy} onClick={() => { update((d) => { d.logo.mediaId = null; d.logo.show = false; }); void loadLogo(null); }}>
                      Remove
                    </CrmSmallButton>
                  )}
                </div>
              </div>
            </section>

            <section>
              <SectionTitle>Member photo slot</SectionTitle>
              <p style={{ fontSize: 12, color: '#a8a29e', margin: '0 0 10px' }}>
                Configures the slot; each member&apos;s own photo and its crop/zoom are set from their card or the Members list.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ToggleRow label="Show photo slot" on={design.photo.show} onChange={(v) => update((d) => { d.photo.show = v; })} />
                <Grid cols={3}>
                  <Field label="Shape"><Select value={design.photo.shape} onChange={(v) => update((d) => { d.photo.shape = v as CardDesign['photo']['shape']; })} options={PHOTO_SHAPE} /></Field>
                  <Field label="Position"><Select value={design.photo.position} onChange={(v) => update((d) => { d.photo.position = v as CardDesign['photo']['position']; })} options={PHOTO_POS} /></Field>
                  <Field label="Width (% of card)"><Range value={design.photo.widthPct} min={5} max={60} step={1} suffix="%" onChange={(v) => update((d) => { d.photo.widthPct = v; })} /></Field>
                </Grid>
              </div>
            </section>

            <section>
              <SectionTitle>QR code</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ToggleRow label="Show verify QR" on={design.qr.show} onChange={(v) => update((d) => { d.qr.show = v; })} />
                <Grid cols={2}>
                  <Field label="Position"><Select value={design.qr.position} onChange={(v) => update((d) => { d.qr.position = v as CardDesign['qr']['position']; })} options={QR_POS} /></Field>
                  <Field label="Size (% of width)"><Range value={design.qr.sizePct} min={8} max={50} step={1} suffix="%" onChange={(v) => update((d) => { d.qr.sizePct = v; })} /></Field>
                </Grid>
              </div>
            </section>

            <section>
              <SectionTitle>Identity fields</SectionTitle>
              <p style={{ fontSize: 12, color: '#a8a29e', margin: '0 0 10px' }}>
                The member&apos;s name is always the header. Choose which rows show, their order and their labels.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {design.fields.map((f, i) => (
                  <div key={`${f.key}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Toggle on={f.show} onChange={(v) => update((d) => { const t = d.fields[i]; if (t) t.show = v; })} label={`Show ${f.label}`} />
                    <input style={{ ...inputStyle, flex: 1 }} maxLength={40} value={f.label} onChange={(e) => update((d) => { const t = d.fields[i]; if (t) t.label = e.target.value; })} />
                    <code style={{ fontSize: 11, color: '#a8a29e', minWidth: 84 }}>{f.key}</code>
                    <CrmSmallButton disabled={i === 0} onClick={() => moveField(i, -1)}>↑</CrmSmallButton>
                    <CrmSmallButton disabled={i === design.fields.length - 1} onClick={() => moveField(i, 1)}>↓</CrmSmallButton>
                    <CrmSmallButton danger onClick={() => update((d) => { d.fields.splice(i, 1); })}>✕</CrmSmallButton>
                  </div>
                ))}
                {availableKeys.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <select id="add-field" style={{ ...inputStyle, flex: 1 }}>
                      {availableKeys.map((k) => <option key={k} value={k}>{FIELD_LABEL[k]} ({k})</option>)}
                    </select>
                    <CrmButton
                      variant="secondary"
                      onClick={() => {
                        const el = document.getElementById('add-field') as HTMLSelectElement | null;
                        const key = el?.value as FieldKey | undefined;
                        if (key) addField(key);
                      }}
                    >
                      Add field
                    </CrmButton>
                  </div>
                )}
              </div>
            </section>

            <section>
              <SectionTitle>Batch print sheet</SectionTitle>
              <p style={{ fontSize: 12, color: '#a8a29e', margin: '0 0 10px' }}>
                Used by the Members multi-select → Print cards sheet.
              </p>
              <Grid cols={2}>
                <Field label="Paper"><Select value={design.print.paper} onChange={(v) => update((d) => { d.print.paper = v as CardDesign['print']['paper']; })} options={PAPER} /></Field>
                <Field label="Cards per sheet"><NumInput value={design.print.perSheet} min={1} max={64} step={1} onChange={(v) => update((d) => { d.print.perSheet = v; })} /></Field>
                <Field label="Gutter"><NumInput value={design.print.gutterMm} min={0} max={40} step={0.5} suffix="mm" onChange={(v) => update((d) => { d.print.gutterMm = v; })} /></Field>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <ToggleRow label="Cut marks" on={design.print.cutMarks} onChange={(v) => update((d) => { d.print.cutMarks = v; })} />
                </div>
              </Grid>
            </section>
          </div>
        </div>
      </CrmCard>
    </>
  );
}

const btnLike: CSSProperties = {
  display: 'inline-block', padding: '8px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8,
  border: '1px solid #e7e5e4', background: '#fff', color: '#1c1917', cursor: 'pointer',
};

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 800, color: '#1c1917', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f0efee' }}>
      {children}
    </div>
  );
}
