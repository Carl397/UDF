'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '../../../lib/api';
import type { HeatmapPoint } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmCard,
  CrmFilters, CrmSmallButton, downloadCsv,
} from '../../../components/crm/ui';

/**
 * CRM Heatmaps — geographic density of members, cases and patrol activity.
 * The map is the UDF's own `UdfStaticMap` (SVG boundaries baked from Postgres,
 * no third-party tiles or fonts); the table lists the clustered patrol heatmap
 * points for the selected ward.
 */

const UdfStaticMap = dynamic(() => import('../../../components/UdfStaticMap'), { ssr: false });

const CATEGORIES = ['water', 'power', 'roads', 'waste', 'housing', 'safety', 'parks', 'other'];

export default function CrmHeatmaps() {
  const [ward, setWard] = useState('');
  const [points, setPoints] = useState<HeatmapPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .getHeatmap(ward || undefined)
      .then((r: { points: HeatmapPoint[] }) => { if (live) setPoints(r.points); })
      .catch((e) => { if (live) { setPoints([]); setError(e?.message ?? 'Could not load case density'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ward, retry]);

  const totalWeight = points.reduce((sum, p) => sum + (p.count ?? 0), 0);
  const byCategory = [...new Set([...CATEGORIES, ...points.map((p) => p.category)])].map((c) => ({
    category: c,
    count: points.filter((p) => p.category === c).reduce((s, p) => s + (p.count ?? 0), 0),
  })).filter((c) => c.count > 0);

  return (
    <div>
      <CrmPageHeader
        title="Heatmaps"
        subtitle="Non-private service cases with saved locations. Locations are rounded to a 0.001° grid; missing locations and duplicate cases are excluded."
      />

      {error && <p role="alert">{error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button></p>}
      {!loading && !error && <CrmStatGrid
        stats={[
          { label: 'Clusters', value: points.length },
          { label: 'Mapped Cases', value: totalWeight.toLocaleString() },
          ...byCategory.slice(0, 2).map((c) => ({ label: c.category.replace('_', ' '), value: c.count.toLocaleString() })),
        ]}
      />}

      <CrmFilters>
        <input
          type="text"
          value={ward}
          onChange={(e) => setWard(e.target.value)}
          placeholder="Filter by ward code (e.g. CPT-W054)"
        />
        <CrmSmallButton
          disabled={loading || !!error}
          onClick={() =>
            downloadCsv(
              'heatmap',
              ['Latitude', 'Longitude', 'Category', 'Count'],
              points.map((p) => [p.latitude, p.longitude, p.category, p.count]),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      <CrmCard title="Service Case Density">
        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e5e5' }}>
          <UdfStaticMap initialLayer="ward" wardCode={ward} heatPoints={loading || error ? [] : points} showCaseStats={false}
            onSelect={({ layer, code }) => { if (layer === 'ward') setWard(code); }} />
        </div>
      </CrmCard>

      <CrmCard title="Heatmap Clusters">
        {loading ? (
          <p style={{ color: '#64748b' }}>Loading clusters…</p>
        ) : error ? null : (
          <CrmTable
            columns={['Latitude', 'Longitude', 'Category', 'Count']}
            rows={points.map((p) => [
              p.latitude.toFixed(5),
              p.longitude.toFixed(5),
              <CrmBadge key="c" value={p.category} />,
              <strong key="n">{p.count}</strong>,
            ])}
            empty="No heatmap clusters for this filter."
          />
        )}
      </CrmCard>
    </div>
  );
}
