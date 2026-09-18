'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { useShell } from './AppShell';
import { Icon, Sheet, useToast } from './ui';
import type { CardDesign, PartyCard } from '../types';
import { DEFAULT_CARD_DESIGN, loadImage, renderCard, type CardAssets } from '../lib/cardRender';

/**
 * Ward Candidate / Party ID card.
 *
 * The card face is drawn by `lib/cardRender` — the SAME painter powers the
 * on-screen preview and the downloadable PNG, so whatever a national
 * administrator designs (size, palette, wording, which fields show, border,
 * logo, member photo, QR) is exactly what prints, at up to 1000% export scale.
 *
 * The QR encodes the member's public verify link (`/v/<code>`). Scanning it
 * shows the card's public face — membership number, ward, offices held, status
 * — plus the party's contact details and a "Join the party" button. Personal
 * contact details only appear there if the member consented to data sharing;
 * printing them on the card requires the PII permission and is audited.
 */
export default function IdCardSheet({
  memberId,
  onClose,
}: {
  memberId: string;
  onClose: () => void;
}) {
  const { caps } = useShell();
  const toast = useToast();
  const [card, setCard] = useState<PartyCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [assets, setAssets] = useState<CardAssets>({ logo: null, photo: null, qr: null });
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const load = useCallback(
    async (withPii: boolean) => {
      setError(null);
      try {
        const c = await api.partyCard(memberId, withPii);
        setCard(c);
        setQr(
          await QRCode.toDataURL(c.verifyUrl, {
            margin: 1,
            width: 640,
            errorCorrectionLevel: 'M',
            color: { dark: '#141414', light: '#ffffff' },
          }),
        );
      } catch (e: any) {
        setError(e?.message ?? 'Could not load the party card');
      }
    },
    [memberId],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // Resolve the design's images. The logo and the member photo are authenticated
  // media (`<img>` cannot send a bearer header), so they are fetched as blobs and
  // turned into object URLs; the QR is already a local data-url.
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      if (!card) {
        setAssets({ logo: null, photo: null, qr: null });
        return;
      }
      const design: CardDesign = card.design ?? DEFAULT_CARD_DESIGN;
      const qrImg = await loadImage(qr);
      let logoImg: HTMLImageElement | null = null;
      if (design.logo.show && design.logo.mediaId) {
        const blob = await api.cardMediaBlob(design.logo.mediaId);
        if (blob) {
          const u = URL.createObjectURL(blob);
          urls.push(u);
          logoImg = await loadImage(u);
        }
      }
      let photoImg: HTMLImageElement | null = null;
      if (design.photo.show && card.photo?.mediaId) {
        const blob = await api.cardMediaBlob(card.photo.mediaId);
        if (blob) {
          const u = URL.createObjectURL(blob);
          urls.push(u);
          photoImg = await loadImage(u);
        }
      }
      if (!cancelled) setAssets({ logo: logoImg, photo: photoImg, qr: qrImg });
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [card, qr]);

  // Paint the preview whenever the card or its images change.
  useEffect(() => {
    if (!card || !previewRef.current) return;
    renderCard(previewRef.current, card, card.design ?? DEFAULT_CARD_DESIGN, assets, { widthPx: 900 });
  }, [card, assets]);

  async function reveal() {
    setBusy(true);
    try {
      await load(true);
      setRevealed(true);
      toast('Identity revealed — this access is audited', 'ok');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'ok');
    } catch {
      toast('Clipboard blocked by the browser', 'err');
    }
  }

  async function resend() {
    setBusy(true);
    try {
      const r = await api.resendConfirmLink(memberId);
      setConfirmUrl(r.confirmUrl);
      toast('Confirmation link created', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not create link', 'err');
    } finally {
      setBusy(false);
    }
  }

  /** Export the printable card as a PNG at the design's dpi × scale (up to 1000%). */
  async function download() {
    if (!card) return;
    setBusy(true);
    try {
      const design: CardDesign = card.design ?? DEFAULT_CARD_DESIGN;
      const canvas = document.createElement('canvas');
      const { w, h, clamped } = renderCard(canvas, card, design, assets);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not export the card');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${card.publicCode}-${design.text.orgName.toLowerCase().replace(/\s+/g, '-')}-card-${w}x${h}.png`;
      a.click();
      URL.revokeObjectURL(url);
      toast(
        clamped
          ? `Card downloaded (${w}×${h}px — reduced to the browser's canvas limit)`
          : `Card downloaded (${w}×${h}px)`,
        'ok',
      );
    } catch (e: any) {
      toast(e?.message ?? 'Could not export the card', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Party ID card"
      subtitle={card ? `${card.publicCode} · scan to verify & join` : 'Loading card…'}
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-gold" style={{ flex: 2 }} onClick={download} disabled={busy || !card}>
            <Icon name="download" size={16} /> Download card
          </button>
          <button
            className="btn btn-ghost"
            style={{ flex: 1 }}
            onClick={() => card && copy(card.verifyUrl, 'Verify link')}
            disabled={!card}
          >
            <Icon name="link" size={16} /> Copy link
          </button>
        </div>
      }
    >
      {error && <div className="banner err">{error}</div>}

      {card && (
        <>
          <div className="id-card-preview">
            <canvas ref={previewRef} style={{ display: 'block', width: '100%', height: 'auto' }} />
          </div>

          <div className="rows" style={{ marginTop: 14 }}>
            {card.roles.map((r, i) => (
              <div className="row" key={`${r.name}-${i}`}>
                <span className="row-ico"><Icon name="shield" /></span>
                <span className="row-main">
                  <span className="row-title">{r.title ?? r.name}</span>
                  <span className="row-sub">
                    {r.ward ? `Ward ${r.ward} · ` : ''}
                    {r.status}
                  </span>
                </span>
                <span className={`badge ${r.status === 'confirmed' ? 'ok' : 'warn'}`}>{r.status}</span>
              </div>
            ))}

            <button className="row" onClick={() => copy(card.verifyUrl, 'Verify link')}>
              <span className="row-ico"><Icon name="qr" /></span>
              <span className="row-main">
                <span className="row-title">Verify link (QR target)</span>
                <span className="row-sub truncate">{card.verifyUrl}</span>
              </span>
              <Icon name="chev" size={16} />
            </button>

            <button className="row" onClick={() => copy(card.joinUrl, 'Join link')}>
              <span className="row-ico"><Icon name="flag" /></span>
              <span className="row-main">
                <span className="row-title">Join-the-party link</span>
                <span className="row-sub truncate">{card.joinUrl}</span>
              </span>
              <Icon name="chev" size={16} />
            </button>

            <a className="row" href={card.vcardUrl} download style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="row-ico"><Icon name="download" /></span>
              <span className="row-main">
                <span className="row-title">Contact card (.vcf)</span>
                <span className="row-sub">Shared details only — respects consent</span>
              </span>
              <Icon name="chev" size={16} />
            </a>

            {caps.pii && !revealed && (
              <button className="row" onClick={reveal} disabled={busy}>
                <span className="row-ico"><Icon name="eye" /></span>
                <span className="row-main">
                  <span className="row-title">Print name & contact on card</span>
                  <span className="row-sub">Decrypts sealed PII — recorded in the audit log</span>
                </span>
                <Icon name="chev" size={16} />
              </button>
            )}

            {caps.memberWrite && (
              <button className="row" onClick={resend} disabled={busy}>
                <span className="row-ico"><Icon name="send" /></span>
                <span className="row-main">
                  <span className="row-title">Create membership confirmation link</span>
                  <span className="row-sub">
                    {card.status === 'pending' ? 'Needed to activate a pending member' : 'Re-send for this member'}
                  </span>
                </span>
                <Icon name="chev" size={16} />
              </button>
            )}
          </div>

          {revealed && card.identity && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="kv"><span className="k">Name</span><span className="v">{card.identity.fullName ?? '—'}</span></div>
              <div className="kv"><span className="k">Phone</span><span className="v">{card.identity.phone ?? '—'}</span></div>
              <div className="kv"><span className="k">Email</span><span className="v">{card.identity.email ?? '—'}</span></div>
            </div>
          )}

          {confirmUrl && (
            <div className="link-box" style={{ marginTop: 12 }}>
              <div className="link-title"><Icon name="link" size={15} /> Membership confirmation link</div>
              <code>{confirmUrl}</code>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => copy(confirmUrl, 'Confirmation link')}>
                  Copy
                </button>
                <a className="btn btn-primary btn-sm" href={confirmUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
            </div>
          )}

          <p className="hint-text" style={{ marginTop: 12 }}>
            Scanning the card opens the public verification page: it confirms the membership number,
            ward and offices, lists party contact details, and offers a one-tap “Join the party”
            form that attributes the new member to this card.
          </p>
        </>
      )}
    </Sheet>
  );
}
