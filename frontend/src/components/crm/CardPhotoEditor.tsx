'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../../lib/api';
import { CrmModal, CrmButton, CrmSmallButton } from './ui';
import { paintPhotoPreview } from '../../lib/cardRender';
import { loadImageEl, shrinkImage } from '../../lib/image';
import { CARD_PHOTO_UPLOAD_MAX, formatBytes } from '../../lib/uploadLimits';
import type { PhotoTransform } from '../../types';

/**
 * CRM ▸ Members ▸ Card photo. Set or re-frame the photo that appears in this
 * member's ID-card slot (when the national-admin design shows one).
 *
 * The framing is stored as a normalised crop rect `{x,y,w,h}` (fractions of the
 * source) — zoom shrinks the rect about its centre, drag pans it — and the
 * preview is painted by the SAME `drawPhoto` the card uses, so what you see here
 * is exactly what prints. `member:write` within the caller's scope; audited.
 */

const DEFAULT_TRANSFORM: PhotoTransform = { x: 0, y: 0, w: 1, h: 1, zoom: 1 };
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function CardPhotoEditor({
  memberId,
  memberLabel,
  initialMediaId,
  initialTransform,
  onClose,
  onSaved,
}: {
  memberId: string;
  memberLabel: string;
  initialMediaId?: string | null;
  initialTransform?: PhotoTransform | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [transform, setTransform] = useState<PhotoTransform>(initialTransform ?? DEFAULT_TRANSFORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [hasExisting, setHasExisting] = useState(Boolean(initialMediaId));
  const previewRef = useRef<HTMLCanvasElement>(null);
  const objUrlRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    window.setTimeout(() => setMsg(null), 4000);
  };

  // Load the member's existing photo (authenticated media → blob → object URL).
  useEffect(() => {
    let live = true;
    (async () => {
      if (!initialMediaId) return;
      const blob = await api.cardMediaBlob(initialMediaId);
      if (!blob || !live) return;
      const u = URL.createObjectURL(blob);
      objUrlRef.current = u;
      const el = await loadImageEl(u).catch(() => null);
      if (live && el) setImg(el);
    })();
    return () => {
      live = false;
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    };
  }, [initialMediaId]);

  // Repaint the preview on any change.
  useEffect(() => {
    if (previewRef.current) paintPhotoPreview(previewRef.current, img, transform, 'rounded', 320, 0.8);
  }, [img, transform]);

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await shrinkImage(file, { mime: 'image/jpeg', budget: CARD_PHOTO_UPLOAD_MAX });
      const el = await loadImageEl(url);
      setDataUrl(url);
      setImg(el);
      setTransform(DEFAULT_TRANSFORM);
      flash('ok', 'Photo loaded — drag to reposition, then Save.');
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not read that image.');
    } finally {
      setBusy(false);
    }
  }, []);

  function setZoom(z: number) {
    setTransform((t) => {
      const w = 1 / z;
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - w / 2, 0, 1 - w), w, h: w, zoom: 1 };
    });
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  }
  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    const cv = previewRef.current;
    if (!d || !cv) return;
    const rect = cv.getBoundingClientRect();
    const dxF = (e.clientX - d.x) / (rect.width || 1);
    const dyF = (e.clientY - d.y) / (rect.height || 1);
    setTransform((t) => ({
      ...t,
      x: clamp(d.tx - dxF * t.w, 0, 1 - t.w),
      y: clamp(d.ty - dyF * t.h, 0, 1 - t.h),
    }));
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  async function save() {
    if (!img) { flash('err', 'Choose a photo first.'); return; }
    if (!dataUrl && !hasExisting) { flash('err', 'Choose a photo first.'); return; }
    setBusy(true);
    try {
      await api.setCardPhoto(memberId, dataUrl ? { dataUrl, transform } : { transform });
      onSaved();
      onClose();
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not save the photo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteCardPhoto(memberId);
      onSaved();
      onClose();
    } catch (e: any) {
      flash('err', e?.message ?? 'Could not remove the photo.');
    } finally {
      setBusy(false);
    }
  }

  const zoom = Math.round(1 / (transform.w || 1));

  return (
    <CrmModal title={`Card photo · ${memberLabel}`} onClose={onClose}>
      {msg && (
        <div style={{
          padding: 10, marginBottom: 14, borderRadius: 8, fontSize: 13,
          background: msg.tone === 'ok' ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${msg.tone === 'ok' ? '#bbf7d0' : '#fecaca'}`,
          color: msg.tone === 'ok' ? '#166534' : '#991b1b',
        }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div>
          <canvas
            ref={previewRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ width: '100%', height: 'auto', borderRadius: 10, display: 'block', cursor: img ? 'grab' : 'default', touchAction: 'none' }}
          />
          <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 6 }}>Drag to reposition · the slot mask follows the card design.</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ cursor: 'pointer' }}>
            <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
            <span style={{
              display: 'inline-block', padding: '9px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8,
              border: '1px solid #e7e5e4', background: '#fff', color: '#1c1917',
            }}>
              {img ? 'Replace photo' : 'Choose photo'}
            </span>
          </label>
          <p className="upload-limit">
            Photo: max {formatBytes(CARD_PHOTO_UPLOAD_MAX)} encoded after automatic compression.
            {dataUrl && ` Ready: ${formatBytes(dataUrl.length)}.`}
          </p>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#78716c', marginBottom: 6 }}>
              Zoom · {zoom}×
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range" min={1} max={8} step={0.1} value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                disabled={!img}
                style={{ flex: 1 }}
              />
              <CrmSmallButton disabled={!img} onClick={() => setTransform(DEFAULT_TRANSFORM)}>Reset</CrmSmallButton>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
            <CrmButton onClick={save} disabled={busy || !img}>Save photo</CrmButton>
            {hasExisting && (
              <CrmButton variant="danger" onClick={remove} disabled={busy}>Remove</CrmButton>
            )}
            <CrmButton variant="secondary" onClick={onClose} disabled={busy}>Cancel</CrmButton>
          </div>

          <p style={{ fontSize: 12, color: '#a8a29e', margin: 0, lineHeight: 1.6 }}>
            Photos are stored as sealed media and released only to staff who can see this member.
            Setting or removing a photo is written to the audit log.
          </p>
        </div>
      </div>
    </CrmModal>
  );
}
