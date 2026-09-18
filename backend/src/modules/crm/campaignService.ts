import { query } from '../../db/pool.js';

/**
 * CRM Campaign service — marketing_campaigns CRUD and engagement tracking.
 * Backed by the marketing_campaigns table (migration 003).
 */

export interface CampaignFilters {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listCampaigns(filters: CampaignFilters) {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.status) {
    conditions.push(`status = $${idx}`);
    params.push(filters.status);
    idx++;
  }
  if (filters.search) {
    conditions.push(`(title ILIKE $${idx} OR description ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM marketing_campaigns ${where}`, params),
    query(
      `SELECT * FROM marketing_campaigns ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    items: dataRes.rows,
    total: parseInt(countRes.rows[0].total, 10),
    limit,
    offset,
  };
}

export async function getCampaign(id: string) {
  const res = await query(`SELECT * FROM marketing_campaigns WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function createCampaign(payload: {
  title: string;
  description?: string;
  target_audience?: Record<string, unknown>;
  start_date?: string;
  end_date?: string;
  status?: string;
  created_by?: string;
}) {
  const res = await query(
    `INSERT INTO marketing_campaigns (title, description, target_audience, start_date, end_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.title,
      payload.description ?? null,
      JSON.stringify(payload.target_audience ?? {}),
      payload.start_date ?? null,
      payload.end_date ?? null,
      payload.status ?? 'draft',
      payload.created_by ?? null,
    ],
  );
  return res.rows[0];
}

export async function updateCampaign(
  id: string,
  payload: {
    title?: string;
    description?: string;
    target_audience?: Record<string, unknown>;
    start_date?: string | null;
    end_date?: string | null;
    status?: string;
  },
) {
  const fields: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (payload.title !== undefined) { fields.push(`title = $${idx++}`); params.push(payload.title); }
  if (payload.description !== undefined) { fields.push(`description = $${idx++}`); params.push(payload.description); }
  if (payload.target_audience !== undefined) { fields.push(`target_audience = $${idx++}`); params.push(JSON.stringify(payload.target_audience)); }
  if (payload.start_date !== undefined) { fields.push(`start_date = $${idx++}`); params.push(payload.start_date); }
  if (payload.end_date !== undefined) { fields.push(`end_date = $${idx++}`); params.push(payload.end_date); }
  if (payload.status !== undefined) { fields.push(`status = $${idx++}`); params.push(payload.status); }

  if (fields.length === 0) return getCampaign(id);

  params.push(id);
  const res = await query(
    `UPDATE marketing_campaigns SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function deleteCampaign(id: string) {
  await query(`DELETE FROM marketing_campaigns WHERE id = $1`, [id]);
}

/** Increment engagement metrics (clicks, shares, conversions). */
export async function recordEngagement(
  id: string,
  metrics: { clicks?: number; shares?: number; conversions?: number },
) {
  const current = await getCampaign(id);
  if (!current) return null;
  const existing = (current.engagement_metrics ?? {}) as Record<string, number>;
  const merged = {
    clicks: (existing.clicks ?? 0) + (metrics.clicks ?? 0),
    shares: (existing.shares ?? 0) + (metrics.shares ?? 0),
    conversions: (existing.conversions ?? 0) + (metrics.conversions ?? 0),
  };
  const res = await query(
    `UPDATE marketing_campaigns SET engagement_metrics = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify(merged), id],
  );
  return res.rows[0] ?? null;
}
