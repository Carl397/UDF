import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { query, withTransaction } from '../../db/pool.js';
import { Permission, Role, type Principal } from '../../auth/permissions.js';
import { ApiError } from '../../http/errors.js';
import { readCatalog, verifiedArtifact, OFFICIAL_ORIGIN, type Artifact } from './catalog.js';

const releaseId = z.string().regex(/^[1-9][0-9]{0,9}-[0-9a-f]{64}$/);
export const publishSchema = z.object({
  artifactId: releaseId,
  notes: z.string().trim().min(1).max(2000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/),
  expectedAnnouncementId: z.string().uuid().nullable(),
}).strict();
export const withdrawSchema = z.object({ announcementId: z.string().uuid() }).strict();
export const releaseIdSchema = releaseId;
export function requireReleaseManager(p: Principal) {
  if (p.role !== Role.SUPERADMIN || !p.permissions?.includes(Permission.APP_RELEASE_MANAGE)) {
    throw ApiError.forbidden('Superadmin app-release permission required');
  }
}
type Announcement = { id: string; artifact_id: string; notes: string; published_at: Date;
  withdrawn_at: Date | null; published_by: string; withdrawn_by: string | null; artifact: Artifact };
const select = `SELECT n.*, a.artifact FROM app_release_announcements n
  JOIN app_release_artifacts a ON a.id = n.artifact_id`;
function publicView(n: Announcement) {
  const a = n.artifact;
  return { announcementId: n.id, artifactId: a.id, packageId: a.packageId,
    versionCode: a.versionCode, versionName: a.versionName, sha256: a.sha256,
    bytes: a.bytes, notes: n.notes, publishedAt: n.published_at,
    downloadUrl: `${OFFICIAL_ORIGIN}/api/public/download/app-release/${a.id}` };
}
export async function activeUpdate() {
  const result = await query<Announcement>(`${select}
    JOIN app_release_state s ON s.active_id = n.id WHERE n.withdrawn_at IS NULL`);
  const n = result.rows[0];
  if (!n) return null;
  // Missing/replaced catalog files fail closed; clients tolerate an unavailable check.
  const artifact = await verifiedArtifact(n.artifact_id);
  return artifact && isDeepStrictEqual(artifact, n.artifact) ? publicView(n) : null;
}
export async function listReleases(p: Principal) {
  requireReleaseManager(p);
  let catalogError: string | null = null;
  const prepared: Array<{ artifact: Artifact; verified: boolean }> = [];
  try {
    const catalog = await readCatalog();
    if (!catalog.root) catalogError = 'No operator-prepared release catalog configured.';
    for (const entry of catalog.releases) {
      let verified = false;
      try { verified = Boolean(await verifiedArtifact(entry.artifact.id)); } catch { /* unavailable */ }
      prepared.push({ artifact: entry.artifact, verified });
    }
  } catch { catalogError = 'Release catalog verification failed. Contact the release operator.'; }
  const [history, state, events] = await Promise.all([
    query<Announcement>(`${select} ORDER BY n.published_at DESC LIMIT 100`),
    query<{ active_id: string | null; highest_version: number }>('SELECT active_id, highest_version FROM app_release_state'),
    query('SELECT seq, announcement_id, action, actor_id, created_at FROM app_release_events ORDER BY seq DESC LIMIT 200'),
  ]);
  return { prepared, catalogError, activeAnnouncementId: state.rows[0]?.active_id ?? null,
    highestVersionCode: state.rows[0]?.highest_version ?? 0,
    history: history.rows.map((n) => ({ ...publicView(n), withdrawnAt: n.withdrawn_at,
      publishedBy: n.published_by, withdrawnBy: n.withdrawn_by })), events: events.rows };
}
export async function publishRelease(p: Principal, raw: unknown) {
  requireReleaseManager(p);
  const input = publishSchema.parse(raw);
  return withTransaction(async (client) => {
    const state = (await client.query<{ active_id: string | null; highest_version: number }>(
      'SELECT active_id, highest_version FROM app_release_state WHERE singleton FOR UPDATE')).rows[0]!;
    const a = await verifiedArtifact(input.artifactId);
    if (!a) throw ApiError.conflict('Artifact is not verified and publicly available');
    if (state.active_id) {
      const active = (await client.query<Announcement>(`${select} WHERE n.id=$1`, [state.active_id])).rows[0]!;
      if (active.artifact_id === a.id && active.notes === input.notes && isDeepStrictEqual(active.artifact, a)) {
        return { announcementId: active.id, changed: false };
      }
    }
    if (state.active_id !== input.expectedAnnouncementId) throw ApiError.conflict('Announcement changed. Reload before sending.');
    if (a.versionCode <= state.highest_version) throw ApiError.conflict('Only a newer build can be announced; withdrawn notices cannot be resent');
    await client.query('INSERT INTO app_release_artifacts(id,version_code,artifact) VALUES ($1,$2,$3)',
      [a.id, a.versionCode, JSON.stringify(a)]);
    if (state.active_id) {
      await client.query('UPDATE app_release_announcements SET withdrawn_at=now(),withdrawn_by=$2 WHERE id=$1', [state.active_id, p.sub]);
      await client.query("INSERT INTO app_release_events(announcement_id,action,actor_id) VALUES ($1,'supersede',$2)", [state.active_id, p.sub]);
    }
    const n = (await client.query<{ id: string }>(`INSERT INTO app_release_announcements(artifact_id,notes,published_by)
      VALUES ($1,$2,$3) RETURNING id`, [a.id, input.notes, p.sub])).rows[0]!;
    await client.query('UPDATE app_release_state SET active_id=$1,highest_version=$2 WHERE singleton', [n.id, a.versionCode]);
    await client.query("INSERT INTO app_release_events(announcement_id,action,actor_id) VALUES ($1,'publish',$2)", [n.id, p.sub]);
    return { announcementId: n.id, changed: true };
  });
}
export async function withdrawRelease(p: Principal, raw: unknown) {
  requireReleaseManager(p);
  const input = withdrawSchema.parse(raw);
  return withTransaction(async (client) => {
    const state = (await client.query<{ active_id: string | null }>(
      'SELECT active_id FROM app_release_state WHERE singleton FOR UPDATE')).rows[0]!;
    const target = (await client.query<{ withdrawn_at: Date | null }>(
      'SELECT withdrawn_at FROM app_release_announcements WHERE id=$1', [input.announcementId])).rows[0];
    if (!target) throw ApiError.notFound('Announcement not found');
    if (target.withdrawn_at) return { changed: false };
    if (state.active_id !== input.announcementId) throw ApiError.conflict('Announcement changed. Reload before withdrawing.');
    await client.query('UPDATE app_release_announcements SET withdrawn_at=now(),withdrawn_by=$2 WHERE id=$1', [input.announcementId, p.sub]);
    await client.query('UPDATE app_release_state SET active_id=NULL WHERE singleton');
    await client.query("INSERT INTO app_release_events(announcement_id,action,actor_id) VALUES ($1,'withdraw',$2)", [input.announcementId, p.sub]);
    return { changed: true };
  });
}
export async function resolveReleaseDownload(id: string) {
  const a = await verifiedArtifact(releaseId.parse(id));
  if (!a) throw ApiError.notFound('Release unavailable');
  // A withdrawn/superseded notice cannot hand out a stale installer redirect.
  const result = await query<Announcement>(`${select} JOIN app_release_state s ON s.active_id=n.id
    WHERE n.artifact_id=$1 AND n.withdrawn_at IS NULL`, [a.id]);
  if (!result.rows[0] || !isDeepStrictEqual(result.rows[0].artifact, a)) throw ApiError.notFound('Release no longer active');
  return a;
}
