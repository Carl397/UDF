'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { fileToDataUrl } from '../../lib/device';
import { MEDIA_DATAURL_MAX, dataUrlBytes, formatBytes } from '../../lib/uploadLimits';
import { CrmModal, CrmButton, CrmSmallButton } from './ui';

/**
 * CandidatePhotoEditor — set or clear the portrait shown on a ward candidate's
 * public "Meet our ward councillors" card.
 *
 * Mirrors CoverEditor but square-cropped: one dedicated photo per person, sent
 * as a base64 data-url through the shared media pipeline (same 8 MB encoded
 * cap) and stored as the row's photo_media_id. The preview is fetched with the
 * bearer token from the CRM photo path, so an *inactive* candidate's photo
 * still shows here even though the public homepage hides it.
 */
export function CandidatePhotoEditor({
  candidateId,
  candidateName,
  hasPhoto,
  onClose,
  onSaved,
}: {
  candidateId: string;
  candidateName: string;
  hasPhoto: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hasPhoto) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api
      .coverBlob(`/crm/candidates/${candidateId}/photo`, controller.signal)
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
  }, [hasPhoto, candidateId]);

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
      await api.setCandidatePhoto(candidateId, dataUrl);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not upload photo');
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCandidatePhoto(candidateId);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Could not remove photo');
      setBusy(false);
    }
  }

  return (
    <CrmModal title={`Photo — ${candidateName}`} onClose={onClose}>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 10px' }}>
        The headshot shown on this candidate&apos;s public card. Use a square or portrait image.
      </p>

      <div style={previewBox}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={`${candidateName} photo`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : hasPhoto ? (
          <span style={{ color: '#64748b' }}>Loading…</span>
        ) : (
          <span style={{ color: '#94a3b8' }}>No photo set</span>
        )}
      </div>

      {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <CrmButton onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Saving…' : hasPhoto ? 'Replace photo' : 'Upload photo'}
        </CrmButton>
        {hasPhoto && (
          <CrmSmallButton danger onClick={remove} disabled={busy}>
            Remove
          </CrmSmallButton>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
    </CrmModal>
  );
}

const previewBox: CSSProperties = {
  width: 180,
  height: 180,
  borderRadius: '50%',
  border: '1px dashed #cbd5e1',
  background: '#f8fafc',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  fontSize: 14,
  margin: '0 auto',
};
