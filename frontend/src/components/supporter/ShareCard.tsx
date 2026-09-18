'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureImage, saveImage, shareImage } from '../../lib/device';
import { MEDIA_DATAURL_MAX, formatBytes } from '../../lib/uploadLimits';
import { Icon, useToast } from '../ui';

/**
 * Supporter share card.
 *
 * A supporter adds a portrait; the card is composed entirely on-device on a
 * <canvas> (UDF banner + circular portrait + the supporter message + footer)
 * and can be shared to WhatsApp / Facebook via the OS share sheet, or saved to
 * the device. POPIA-first: the portrait is never uploaded or stored by the UDF
 * — it leaves the phone only if the supporter chooses to share or save.
 */

const CARD_W = 1080;
const CARD_H = 1350;

/** The fixed supporter message (per the campaign brief). */
export const SUPPORTER_MESSAGE =
  'I support the UDF — with this mobile app I\u2019m in contact with my ward councillor at all times.';

const RED = '#C8102E';
const RED_DARK = '#8f0b20';
const GOLD = '#E0A800';
const INK = '#16161a';
const MUTED = '#5c5c66';
const PAPER = '#ffffff';
const FOOT = '#141414';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

let brandPromise: Promise<HTMLImageElement> | null = null;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load an image for the card'));
    img.src = src;
  });
}

/** The UDF protest-art mark, cached across recompositions. */
function loadBrand(): Promise<HTMLImageElement> {
  if (!brandPromise) {
    brandPromise = loadImage('/brand/udf-illustration.png').catch((e) => {
      brandPromise = null;
      throw e;
    });
  }
  return brandPromise;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function initialsOf(name?: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** Draw the finished supporter card and return it as a PNG data URL. */
async function composeCard(portrait: string | null, name?: string): Promise<string> {
  if (typeof document === 'undefined') throw new Error('Canvas is not available here');
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available on this device');

  const cx = CARD_W / 2;

  // Background.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // ── Top banner ────────────────────────────────────────────
  const bannerH = 240;
  const grad = ctx.createLinearGradient(0, 0, 0, bannerH);
  grad.addColorStop(0, RED);
  grad.addColorStop(1, RED_DARK);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, bannerH);
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, bannerH, CARD_W, 10);

  const size = 128;
  const bx = 60;
  const by = (bannerH - size) / 2;
  try {
    const brand = await loadBrand();
    ctx.save();
    roundRect(ctx, bx, by, size, size, 26);
    ctx.clip();
    ctx.drawImage(brand, bx, by, size, size);
    ctx.restore();
  } catch {
    // If the mark can't load, fall back to a solid badge so the card still works.
    ctx.save();
    roundRect(ctx, bx, by, size, size, 26);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.fillStyle = RED;
    ctx.font = `900 56px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('UDF', bx + size / 2, by + size / 2 + 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
  ctx.fillStyle = PAPER;
  ctx.font = `900 96px ${FONT}`;
  ctx.fillText('UDF', bx + size + 34, by + 78);
  ctx.font = `600 34px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText('United Democratic Front', bx + size + 38, by + 122);

  // ── Portrait (circular, cover-fit, gold ring) ─────────────
  const cy = 585;
  const r = 210;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 11, 0, Math.PI * 2);
  ctx.fillStyle = GOLD;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (portrait) {
    const img = await loadImage(portrait);
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = '#eceaf0';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = RED;
    ctx.font = `900 150px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initialsOf(name) || 'UDF', cx, cy + 8);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  // ── Divider + message ─────────────────────────────────────
  ctx.fillStyle = RED;
  roundRect(ctx, cx - 75, 852, 150, 7, 4);
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.font = `800 54px ${FONT}`;
  ctx.textAlign = 'center';
  const lines = wrapText(ctx, SUPPORTER_MESSAGE, 880);
  let y = 922;
  const lh = 70;
  for (const ln of lines) {
    ctx.fillText(ln, cx, y);
    y += lh;
  }

  if (name) {
    ctx.fillStyle = MUTED;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(`\u2014 ${name}`, cx, y + 26);
  }
  ctx.textAlign = 'left';

  // ── Footer ────────────────────────────────────────────────
  const footH = 120;
  const fy = CARD_H - footH;
  ctx.fillStyle = FOOT;
  ctx.fillRect(0, fy, CARD_W, footH);
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, fy, CARD_W, 6);
  ctx.textBaseline = 'middle';
  ctx.font = `700 34px ${FONT}`;
  ctx.fillStyle = PAPER;
  ctx.fillText('UDF Mobile App', 60, fy + footH / 2 + 3);
  ctx.textAlign = 'right';
  ctx.fillStyle = GOLD;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText('#ISupportUDF', CARD_W - 60, fy + footH / 2 + 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  return canvas.toDataURL('image/png');
}

interface ShareCardProps {
  /** Optional supporter name — signs the card and seeds the placeholder initials. */
  name?: string;
  /** Compact variant: drops the heading/intro (used inside other screens). */
  compact?: boolean;
}

export default function ShareCard({ name, compact = false }: ShareCardProps) {
  const toast = useToast();
  const [portrait, setPortrait] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [composing, setComposing] = useState(true);
  const [busy, setBusy] = useState<'' | 'share' | 'save'>('');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Recompose whenever the portrait or the signature name changes.
  useEffect(() => {
    let cancelled = false;
    setComposing(true);
    composeCard(portrait, name)
      .then((url) => {
        if (cancelled || !alive.current) return;
        setCard(url);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || !alive.current) return;
        setError(e instanceof Error ? e.message : 'Could not compose the card');
      })
      .finally(() => {
        if (!cancelled && alive.current) setComposing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [portrait, name]);

  const capture = useCallback(
    async (source: 'camera' | 'gallery') => {
      try {
        const m = await captureImage(source);
        if (m.dataUrl.length > MEDIA_DATAURL_MAX) throw new Error(`Photo exceeds ${formatBytes(MEDIA_DATAURL_MAX)} encoded. Choose a smaller image.`);
        setPortrait(m.dataUrl);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        if (!/cancel/i.test(msg)) toast(msg || 'Could not open the camera', 'err');
      }
    },
    [toast],
  );

  const onSave = useCallback(async () => {
    if (!card) return;
    setBusy('save');
    try {
      const ok = await saveImage(card, `udf-supporter-${Date.now()}.png`);
      toast(ok ? 'Card saved to your device' : 'Saving is not available here', ok ? 'ok' : 'err');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Could not save the card', 'err');
    } finally {
      setBusy('');
    }
  }, [card, toast]);

  const onShare = useCallback(async () => {
    if (!card || !portrait) return;
    setBusy('share');
    try {
      const ok = await shareImage(card, SUPPORTER_MESSAGE, 'I support the UDF');
      if (ok) {
        toast('Thanks for spreading the word', 'ok');
      } else {
        // No share sheet on this platform — fall back to saving the card.
        await onSave();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (!/cancel/i.test(msg)) toast(msg || 'Could not open the share sheet', 'err');
    } finally {
      setBusy('');
    }
  }, [card, portrait, onSave, toast]);

  return (
    <>
      {!compact && (
        <div className="section-label" style={{ marginTop: 12 }}>
          Supporter share card
        </div>
      )}

      <div className="card">
        {!compact && (
          <p className="hint-text" style={{ marginTop: 0 }}>
            Add your photo, then share a supporter card with your contacts — WhatsApp status,
            Facebook, or anywhere else. Everything is composed on this device.
          </p>
        )}

        <div className="sharecard-preview">
          {card ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card} alt="Your UDF supporter card preview" className="sharecard-img" />
          ) : (
            <div className="skeleton sharecard-skel" />
          )}
          {composing && <div className="sharecard-busy">Composing…</div>}
        </div>

        {error && (
          <div className="banner err" style={{ marginTop: 10 }}>
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="chip-row" style={{ marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => capture('camera')}>
            <Icon name="camera" size={16} /> {portrait ? 'Retake photo' : 'Take a photo'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => capture('gallery')}>
            <Icon name="image" size={16} /> Choose a photo
          </button>
          {portrait && (
            <button className="btn btn-ghost btn-sm" onClick={() => setPortrait(null)}>
              <Icon name="trash" size={16} /> Remove
            </button>
          )}
        </div>

        <p className="upload-limit">
          Photo: max {formatBytes(MEDIA_DATAURL_MAX)} encoded (about 6 MB original), prepared on this device.
          {portrait && ` Selected: ${formatBytes(portrait.length)}.`}
        </p>

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 12 }}
          onClick={onShare}
          disabled={!portrait || busy !== '' || composing}
        >
          <Icon name="send" size={17} /> {busy === 'share' ? 'Opening share…' : 'Share my supporter card'}
        </button>
        <button
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={onSave}
          disabled={!card || busy !== '' || composing}
        >
          <Icon name="download" size={17} /> {busy === 'save' ? 'Saving…' : 'Save to my device'}
        </button>

        {!portrait && (
          <p className="hint-text" style={{ marginTop: 8 }}>
            Add your photo to enable sharing. You can still save the card without it.
          </p>
        )}

        <p className="hint-text sharecard-popia" style={{ marginTop: 10 }}>
          <Icon name="lock" size={14} />
          <span>
            POPIA: your portrait is composed on your device and is never uploaded or stored by the
            UDF. It leaves your phone only if you choose to share or save the finished card.
          </span>
        </p>
      </div>
    </>
  );
}
