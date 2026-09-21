'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { fileToDataUrl } from '../../lib/device';
import { MEDIA_DATAURL_MAX, dataUrlBytes, formatBytes } from '../../lib/uploadLimits';
import { CrmModal, CrmButton, CrmSmallButton } from './ui';

/**
 * CoverEditor — set or clear the single hero image on an event or ward bulletin.
 *
 * Separate from the multi-file AttachmentManager: the cover is one dedicated
 * banner, so it is authored with its own control. The file is sent as a base64
 * data-url through the shared media pipeline (same 8 MB encoded cap the
 * attachments use). The current cover previews from an authenticated blob so a
 * DRAFT bulletin's cover — which the server never serves publicly — still shows
 * here; the CRM is always signed in.
 */
export function CoverEditor({
  parentType,
  parentId,
  parentTitle,
  hasCover,
  onClose,
  onSaved,
}: {
  parentType: 'event' | 'bulletin';
  parentId: string;
  parentTitle: string;
  hasCover: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const coverPath =
    parentType === 'event' ? `/events/${parentId}/cover` : `/ward-bulletins/${parentId}/cover`;

  useEffect(() => {
    if (!hasCover) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api
      .coverBlob(coverPath, controller.signal)
      .then((blob) => {
        if (!blob) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasCover, coverPath]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (dataUrlBytes(dataUrl) > MEDIA_DATAURL_MAX) {
        setError(`Image too large (max ${formatBytes(MEDIA_DATAURL_MAX)})`);
        return;
      }
      if (parentType === 'event') await api.setEventCover(parentId, dataUrl);
      else await api.setBulletinCover(parentId, dataUrl);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not upload cover');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (parentType === 'event') await api.deleteEventCover(parentId);
      else await api.deleteBulletinCover(parentId);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not remove cover');
    } finally {
      setBusy(false);
    }
  }

  return (
    <CrmModal title={`Cover image — ${parentTitle}`} onClose={onClose}>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 10px' }}>
        The banner shown on this {parentType}. Use a landscape image for best results.
      </p>

      <div style={previewBox}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Cover preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : hasCover ? (
          <span style={{ color: '#64748b' }}>Loading…</span>
        ) : (
          <span style={{ color: '#94a3b8' }}>No cover set</span>
        )}
      </div>

      {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <CrmButton onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Saving…' : hasCover ? 'Replace cover' : 'Upload cover'}
        </CrmButton>
        {hasCover && (
          <CrmSmallButton danger onClick={remove} disabled={busy}>
            Remove
          </CrmSmallButton>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onFile}
      />
    </CrmModal>
  );
}

const previewBox: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  borderRadius: 10,
  border: '1px dashed #cbd5e1',
  background: '#f8fafc',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  fontSize: 14,
};
