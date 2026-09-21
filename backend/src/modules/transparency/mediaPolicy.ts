import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import type { Principal } from '../../auth/permissions.js';
import { recordAudit } from '../../security/audit.js';
import { z } from 'zod';

export const mediaPolicySchema = z.object({ photo: z.boolean(), video: z.boolean(), voice: z.boolean() }).strict();
export type MediaPolicy = z.infer<typeof mediaPolicySchema>;
export async function getMediaPolicy(): Promise<MediaPolicy> {
  const { rows: [row] } = await query<MediaPolicy>('SELECT photo, video, voice FROM media_capture_policy WHERE singleton');
  if (!row) throw ApiError.internal('Media policy is unavailable');
  return row;
}
export async function setMediaPolicy(policy: MediaPolicy, principal: Principal) {
  if (principal.role !== 'national_admin') throw ApiError.forbidden('National administrator required');
  await query('UPDATE media_capture_policy SET photo=$1, video=$2, voice=$3, updated_by=$4, updated_at=now() WHERE singleton',
    [policy.photo, policy.video, policy.voice, principal.sub]);
  await recordAudit({ action: 'media.policy.update', actorId: principal.sub, actorRole: principal.role,
    targetType: 'media_policy', targetId: 'global', metadata: policy });
  return policy;
}

const SUPPORTED = new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime',
  'audio/webm','audio/ogg','audio/mp4','audio/m4a','audio/x-m4a','audio/mpeg','audio/wav','audio/x-wav','audio/aac',
  // Bulletin / event document attachments (PDF). Not a capture, so it is never
  // gated by the photo/video/voice policy toggles below.
  'application/pdf']);
/** What a validated data-url turned out to be. `document` = a PDF attachment. */
export type MediaKind = 'photo' | 'video' | 'voice' | 'document';
export function parseCapturedMedia(dataUrl: string, mode: string): { contentType: string; buffer: Buffer; kind: MediaKind } {
  if (dataUrl.length > 8 * 1024 * 1024) throw ApiError.badRequest('Attachment exceeds the 8 MB encoded limit');
  const match = /^data:([a-z0-9+.-]+\/[a-z0-9+.-]+)(?:;codecs=[a-z0-9.,_-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw ApiError.badRequest('Invalid base64 media data URL');
  const contentType = match[1]!.toLowerCase();
  if (!SUPPORTED.has(contentType)) throw ApiError.badRequest('Unsupported media format. Use JPEG/PNG/WebP, MP4/WebM video, PDF, or a supported audio file.');
  const kind: MediaKind = contentType.startsWith('image/') ? 'photo'
    : contentType.startsWith('video/') ? 'video'
    : contentType === 'application/pdf' ? 'document'
    : 'voice';
  const expected = mode === 'voice_note' || mode === 'audio' ? 'voice' : mode;
  if (kind !== expected) throw ApiError.badRequest('Attachment type does not match capture mode');
  const buffer = Buffer.from(match[2]!, 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== match[2]!.replace(/=+$/, '')) throw ApiError.badRequest('Invalid media payload');
  return { contentType, buffer, kind };
}
export async function validateMediaBatch(items: Array<{ dataUrl: string; captureMode: string }>) {
  if (!items.length) return;
  if (items.reduce((n, m) => n + m.dataUrl.length, 0) > 20 * 1024 * 1024) throw ApiError.badRequest('Attachments exceed the total upload limit');
  const policy = await getMediaPolicy();
  for (const item of items) {
    const parsed = parseCapturedMedia(item.dataUrl, item.captureMode);
    // Documents are not a capture type and carry no policy toggle.
    if (parsed.kind !== 'document' && !policy[parsed.kind]) {
      throw ApiError.forbidden(`${parsed.kind} attachments have been disabled by the administrator`);
    }
  }
}
