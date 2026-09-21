'use client';

/**
 * Lightweight, dependency-free charts for the SuperAdmin ops screens.
 *
 * The CRM already renders analytics with hand-rolled CSS/SVG (see
 * `app/crm/analytics/page.tsx`), so the ops surface follows the same rule and
 * pulls in no charting library. These are read-only display primitives: an HTML
 * dataset with no user interaction is exactly what a status dashboard needs, and
 * it keeps the static export small.
 */

const SERIES_COLORS = ['#c8102e', '#0369a1', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

/** Horizontal labelled bars — the workhorse for breakdown tables. */
export function HBarChart({
  data,
  color = '#c8102e',
  unit = '',
}: {
  data: { label: string; value: number }[];
  color?: string;
  unit?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) {
    return <p style={{ color: '#8a817b', fontSize: 13, margin: 0 }}>No data in this window.</p>;
  }
  return (
    <div>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span
            style={{ width: 150, fontSize: 13, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={d.label}
          >
            {d.label}
          </span>
          <span style={{ flex: 1, height: 18, background: '#f1f1f1', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${(d.value / max) * 100}%`, height: 18, background: color, borderRadius: 4 }} />
          </span>
          <span style={{ width: 64, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>
            {d.value.toLocaleString()}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Day-labelled time series as overlapping area+line (pageviews vs visitors). */
export function TimeSeriesArea({
  points,
  series,
}: {
  points: string[];
  series: { name: string; values: number[]; color?: string }[];
}) {
  const W = 720;
  const H = 200;
  const PAD = 8;
  if (points.length === 0) {
    return <p style={{ color: '#8a817b', fontSize: 13, margin: 0 }}>No data in this window.</p>;
  }
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = points.length;
  const x = (i: number) => PAD + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        {series.map((s, i) => (
          <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {s.name}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8a817b' }}>peak {max.toLocaleString()}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="time series">
        {series.map((s, i) => {
          const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
          const line = s.values.map((v, j) => `${j === 0 ? 'M' : 'L'}${x(j)},${y(v)}`).join(' ');
          const area = `${line} L${x(n - 1)},${H - PAD} L${x(0)},${H - PAD} Z`;
          return (
            <g key={s.name}>
              <path d={area} fill={color} opacity={0.12} />
              <path d={line} fill="none" stroke={color} strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8a817b', marginTop: 4 }}>
        <span>{points[0]}</span>
        <span>{points[points.length - 1]}</span>
      </div>
    </div>
  );
}

/** Simple proportional donut for a small set of categories (browser/OS mix). */
export function DonutChart({
  data,
  size = 160,
}: {
  data: { label: string; value: number }[];
  size?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) {
    return <p style={{ color: '#8a817b', fontSize: 13, margin: 0 }}>No data in this window.</p>;
  }
  const r = size / 2;
  const stroke = size * 0.18;
  const radius = r - stroke / 2;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="breakdown">
        <g transform={`rotate(-90 ${r} ${r})`}>
          <circle cx={r} cy={r} r={radius} fill="none" stroke="#f1f1f1" strokeWidth={stroke} />
          {data.map((d, i) => {
            const frac = d.value / total;
            const dash = frac * circ;
            const el = (
              <circle
                key={d.label}
                cx={r}
                cy={r}
                r={radius}
                fill="none"
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${circ - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        </g>
      </svg>
      <div style={{ fontSize: 13 }}>
        {data.map((d, i) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            <span style={{ color: '#374151' }}>{d.label}</span>
            <span style={{ color: '#8a817b' }}>{Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
