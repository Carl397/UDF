import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { principalSeesWard, principalSeesPlace } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import { uploadMedia } from '../transparency/service.js';
import type { CreateAttachment } from './schemas.js';

export type ParentType = 'bulletin' | 'event';
export type AttachmentKind = 'photo' | 'video' | 'document' | 'link';

export interface AttachmentView {
  id: string;
  parentType: ParentType;
  parentId: string;
  kind: AttachmentKind;
  title: string | null;
  caption: string | null;
  seq: number;
  /** Link destination (link kind only). */
  url: string | null;
  /** media_assets id (file kinds only), for the authenticated file fetch. */
  mediaId: string | null;
  contentType: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  parent_type: ParentType;
  parent_id: string;
  kind: AttachmentKind;
  title: string | null;
  caption: string | null;
  seq: number;
  url: string | null;
  media_id: string | null;
  content_type: string | null;
  created_at: string;
}

const SELECT = `SELECT a.id, a.parent_type, a.parent_id, a.kind, a.title, a.caption, a.seq,
       a.url, a.media_id, m.content_type, a.created_at
  FROM attachments a
  LEFT JOIN media_assets m ON m.id = a.media_id`;

const toView = (r: Row): AttachmentView => ({
  id: r.id,
  parentType: r.parent_type,
  parentId: r.parent_id,
  kind: r.kind,
  title: r.title,
  caption: r.caption,
  seq: r.seq,
  url: r.url,
  mediaId: r.media_id,
  contentType: r.content_type,
  createdAt: r.created_at,
});

function hasPerm(p: Principal, perm: Permission): boolean {
  // `authenticate` folds live role + per-user overrides into `permissions`.
  return p.permissions?.includes(perm) ?? false;
}

/** Parent territory record needed to authorise a write or a gated read. */
interface ParentScope {
  wardCode: string | null;
  regionCode: string | null;
  published: boolean;
}

async function loadParentScope(parentType: ParentType, parentId: string): Promise<ParentScope | null> {
  if (parentType === 'bulletin') {
    const r = await query<{ ward_code: string; status: string }>(
      'SELECT ward_code, status FROM ward_bulletins WHERE id = $1',
      [parentId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { wardCode: row.ward_code, regionCode: null, published: row.status === 'published' };
  }
  const r = await query<{ region_code: string | null; ward: string | null }>(
    'SELECT region_code, ward FROM events WHERE id = $1',
    [parentId],
  );
  const row = r.rows[0];
  if (!row) return null;
  // The public calendar is always readable; every event's attachments are public.
  return { wardCode: row.ward, regionCode: row.region_code, published: true };
}

/**
 * May this caller WRITE (add/remove) attachments on the parent?
 * Mirrors the gate each parent's own create/edit route applies, so an
 * attachment cannot be pushed into a ward or region the caller does not own.
 */
async function assertCanWrite(parentType: ParentType, scope: ParentScope, p: Principal): Promise<void> {
  if (parentType === 'bulletin') {
    if (!hasPerm(p, Permission.BULLETIN_WRITE)) {
      throw ApiError.forbidden('Missing permission: bulletin:write');
    }
    if (!(await principalSeesWard(p, scope.wardCode!))) {
      throw ApiError.forbidden('Ward outside your authorized scope');
    }
    return;
  }
  if (!hasPerm(p, Permission.EVENT_WRITE)) {
    throw ApiError.forbidden('Missing permission: event:write');
  }
  if (!(await principalSeesPlace(p, { regionCode: scope.regionCode, ward: scope.wardCode }))) {
    throw ApiError.forbidden('Event outside your authorized scope');
  }
}

/** May this (possibly anonymous) caller SEE the parent, and therefore its media? */
async function canReadParent(scope: ParentScope, p: Principal | null): Promise<boolean> {
  if (scope.published) return true;
  if (!p) return false;
  // Unpublished bulletin: only a `bulletin:read` holder inside its ward.
  if (!hasPerm(p, Permission.BULLETIN_READ) || !scope.wardCode) return false;
  return principalSeesWard(p, scope.wardCode);
}

async function nextSeq(parentType: ParentType, parentId: string): Promise<number> {
  const r = await query<{ n: string }>(
    'SELECT COALESCE(MAX(seq), -1)::text AS n FROM attachments WHERE parent_type = $1 AND parent_id = $2',
    [parentType, parentId],
  );
  return Number(r.rows[0]?.n ?? -1) + 1;
}

export async function createAttachment(
  input: CreateAttachment,
  p: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<AttachmentView> {
  const scope = await loadParentScope(input.parentType, input.parentId);
  if (!scope) throw ApiError.notFound(`${input.parentType} not found`);
  await assertCanWrite(input.parentType, scope, p);

  let mediaId: string | null = null;
  let url: string | null = null;
  if (input.kind === 'link') {
    url = input.url;
  } else {
    // Reuse the shared media pipeline: base64 -> uploads/ + SHA-256 -> media_assets.
    const stored = await uploadMedia(
      { dataUrl: input.dataUrl, captureMode: input.kind },
      p,
    );
    mediaId = stored.id;
  }

  const seq = await nextSeq(input.parentType, input.parentId);
  const inserted = await query<{ id: string }>(
    `INSERT INTO attachments
       (parent_type, parent_id, kind, media_id, url, title, caption, seq, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [input.parentType, input.parentId, input.kind, mediaId, url,
     input.title ?? null, input.caption ?? null, seq, p.sub],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw ApiError.internal('Failed to create attachment');

  const row = await query<Row>(`${SELECT} WHERE a.id = $1`, [id]);

  await recordAudit({
    action: 'attachment.create',
    actorId: p.sub,
    actorRole: p.role,
    targetType: `attachment_${input.parentType}`,
    targetId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { kind: input.kind, parentId: input.parentId },
  });

  return toView(row.rows[0]!);
}

export async function listAttachments(
  parentType: ParentType,
  parentId: string,
  p: Principal | null,
): Promise<AttachmentView[]> {
  const scope = await loadParentScope(parentType, parentId);
  if (!scope) throw ApiError.notFound(`${parentType} not found`);
  if (!(await canReadParent(scope, p))) throw ApiError.notFound(`${parentType} not found`);
  const res = await query<Row>(
    `${SELECT} WHERE a.parent_type = $1 AND a.parent_id = $2 ORDER BY a.seq ASC`,
    [parentType, parentId],
  );
  return res.rows.map(toView);
}

async function loadAttachment(id: string): Promise<Row | null> {
  const res = await query<Row>(`${SELECT} WHERE a.id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function deleteAttachment(
  id: string,
  p: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const att = await loadAttachment(id);
  if (!att) throw ApiError.notFound('Attachment not found');
  const scope = await loadParentScope(att.parent_type, att.parent_id);
  if (!scope) throw ApiError.notFound(`${att.parent_type} not found`);
  await assertCanWrite(att.parent_type, scope, p);

  await query('DELETE FROM attachments WHERE id = $1', [id]);

  await recordAudit({
    action: 'attachment.delete',
    actorId: p.sub,
    actorRole: p.role,
    targetType: `attachment_${att.parent_type}`,
    targetId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { kind: att.kind, parentId: att.parent_id },
  });
}

/**
 * Resolve an attachment's file bytes for serving, after the parent's read gate.
 * Links and missing media return null (links have no file; the route 404s).
 */
export async function loadAttachmentFile(
  id: string,
  p: Principal | null,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const att = await loadAttachment(id);
  if (!att || !att.media_id) return null;
  const scope = await loadParentScope(att.parent_type, att.parent_id);
  if (!scope || !(await canReadParent(scope, p))) {
    throw ApiError.forbidden('Attachment is not available');
  }
  const asset = await query<{ storage_key: string; content_type: string }>(
    'SELECT storage_key, content_type FROM media_assets WHERE id = $1',
    [att.media_id],
  );
  const row = asset.rows[0];
  if (!row) return null;
  const buffer = await readFile(join(process.cwd(), row.storage_key));
  return { buffer, contentType: row.content_type };
}
