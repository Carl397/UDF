'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { fileToDataUrl } from '../../lib/device';
import { MEDIA_DATAURL_MAX, formatBytes, dataUrlBytes } from '../../lib/uploadLimits';
import type { Attachment } from '../../types';
import { CrmModal, CrmButton, CrmSmallButton } from './ui';

/**
 * AttachmentManager — insert a PDF, photo, short video or URL link onto a ward
 * bulletin or an event.
 *
 * Files are sent as base64 data-urls through the shared media pipeline (one file
 * per request, under the same 8 MB encoded cap the reports/patrols use — which
 * is also what keeps a "short video" short). Links are stored as a URL only.
 * Preview thumbs are fetched as authenticated blobs because `<img>` cannot send
 * a bearer token, so a bulletin draft is visible here but never publicly.
 */

const KIND_LABEL: Record<Attachment['kind'], string> = {
  photo: 'Photo',
  video: 'Video',
  document: 'PDF',
  link: 'Link',
};

function kindFromFile(mime: string): Attachment['kind'] | null {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return null;
}

/** Authenticated thumbnail/preview for a file attachment. */
function FilePreview({ att }: { att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!att.mediaId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api.attachmentFileBlob(att.id, controller.signal)
      .then((blob) => {
        if (!blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [att.id, att.mediaId]);

  if (!url) return <div style={thumbBox}>Loading…</div>;
  if (att.kind === 'video') {
    return <video src={url} controls style={{ ...thumbBox, objectFit: 'contain', background: '#000' }} />;
  }
  if (att.kind === 'photo') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={att.title ?? 'attachment'} style={thumbBox} />;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...thumbBox, textDecoration: 'none' }}>
      PDF
    </a>
  );
}

const thumbBox: CSSProperties = {
  width: 96,
  height: 96,
  objectFit: 'cover',
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  color: '#475569',
  flexShrink: 0,
};

export function AttachmentManager({
  parentType,
  parentId,
  parentTitle,
  onClose,
}: {
  parentType: 'bulletin' | 'event';
  parentId: string;
  parentTitle: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlText, setUrlText] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listAttachments(parentType, parentId)
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [parentType, parentId]);

  useEffect(load, [load]);

  const onPickFile = async (file: File) => {
    setError(null);
    const kind = kindFromFile(file.type);
    if (!kind || kind === 'link') {
      setError('Unsupported file. Choose a PDF, an image, or a short video (MP4/WebM).');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (dataUrlBytes(dataUrl) > MEDIA_DATAURL_MAX) {
        throw new Error(`File is too large (${formatBytes(dataUrlBytes(dataUrl))}). The limit is ${formatBytes(MEDIA_DATAURL_MAX)} encoded — trim the video or pick a smaller file.`);
      }
      await api.createAttachment({
        parentType,
        parentId,
        kind: kind as 'photo' | 'video' | 'document',
        dataUrl,
        title: file.name.slice(0, 160),
      });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addLink = async () => {
    setError(null);
    const trimmed = urlText.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('Enter a full URL starting with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      await api.createAttachment({
        parentType,
        parentId,
        kind: 'link',
        url: trimmed,
        title: linkTitle.trim() || undefined,
      });
      setUrlText('');
      setLinkTitle('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the link.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteAttachment(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the attachment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal title={`Attachments — ${parentTitle}`} onClose={onClose} wide>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0 }}>
        Insert a PDF, photo, short video, or URL link onto this {parentType}.
      </p>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading attachments…</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>No attachments yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {items.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {a.kind === 'link' ? (
                <div style={{ ...thumbBox, background: '#f1f5f9' }}>{KIND_LABEL.link}</div>
              ) : (
                <FilePreview att={a} />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.title || KIND_LABEL[a.kind]}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {a.kind === 'link' && a.url ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>
                  ) : (
                    KIND_LABEL[a.kind]
                  )}
                </div>
              </div>
              <CrmSmallButton danger onClick={() => remove(a.id)} disabled={busy}>
                Remove
              </CrmSmallButton>
            </div>
          ))}
        </div>
      )}

      {error && <p style={{ color: '#b91c1c', fontSize: 13 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickFile(f);
          }}
        />
        <CrmButton variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
          + Add PDF / photo / video
        </CrmButton>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 2, minWidth: 220 }}>
          <label style={{ fontSize: 12, color: '#475569' }}>URL link</label>
          <input
            style={{ width: '100%' }}
            placeholder="https://…"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={{ fontSize: 12, color: '#475569' }}>Label (optional)</label>
          <input
            style={{ width: '100%' }}
            placeholder="e.g. Full statement"
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
          />
        </div>
        <CrmButton onClick={addLink} disabled={busy || !urlText.trim()}>
          + Add link
        </CrmButton>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <CrmButton variant="secondary" onClick={onClose}>Done</CrmButton>
      </div>
    </CrmModal>
  );
}
