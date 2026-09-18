'use client';

import { useState } from 'react';
import {
  ALL_TIERS,
  REGIONS,
  STATUSES,
  TIERS,
  TIER_COLORS,
  allTiersOn,
} from '../../lib/taxonomy';
import { useShell, type Filters } from '../AppShell';
import { Icon, Sheet } from '../ui';

// Re-exported so existing screens keep importing these from one place.
export { REGIONS, TIERS, STATUSES };

/**
 * How many filters are narrowing the working set, for the badge on whatever
 * control opens the sheet. A chip row that hides its own state behind a button
 * is a chip row the user has to open to understand.
 *
 * `regionInSheet` says whether the region picker lives in the sheet rather than
 * in a visible strip: when the regions are already on screen, counting one of
 * them as "hidden filters" would double-report what the user can see.
 */
export function activeFilterCount(filters: Filters, regionInSheet = false): number {
  return (
    (allTiersOn(filters.tiers) ? 0 : 1) +
    (filters.status ? 1 : 0) +
    (regionInSheet && filters.regionCode ? 1 : 0)
  );
}

/**
 * The filter pickers on their own, for a host that already owns the sheet.
 *
 * Split out of `FilterBar` because the map needs exactly these controls behind
 * a toolbar chip of its own, and a second copy of the tier/status/region markup
 * is a second thing to keep in step with the server's filter vocabulary.
 */
export function FilterFields({
  withRegions = false,
  onDone,
}: {
  /** Render the region picker here (the map has no region strip of its own). */
  withRegions?: boolean;
  onDone?: () => void;
}) {
  const { filters, setFilters } = useShell();

  function toggleTier(tier: string) {
    const on = filters.tiers.includes(tier);
    setFilters({ tiers: on ? filters.tiers.filter((t) => t !== tier) : [...filters.tiers, tier] });
  }

  return (
    <>
      <div className="field" style={{ marginBottom: 14 }}>
        <label>Tiers</label>
        <div className="chip-row">
          <button
            className={`chip ${allTiersOn(filters.tiers) ? 'on' : ''}`}
            onClick={() => setFilters({ tiers: [...ALL_TIERS] })}
          >
            All
          </button>
          {TIERS.map((t) => (
            <button
              key={t}
              className={`chip ${filters.tiers.includes(t) ? 'on' : ''}`}
              onClick={() => toggleTier(t)}
            >
              <span className="swatch-dot" style={{ background: TIER_COLORS[t] }} />
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Status</label>
        <div className="chip-row">
          <button className={`chip ${filters.status === '' ? 'on' : ''}`} onClick={() => setFilters({ status: '' })}>
            Any
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`chip ${filters.status === s ? 'on' : ''}`}
              onClick={() => setFilters({ status: filters.status === s ? '' : s })}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {withRegions && (
        <div className="field" style={{ marginTop: 14 }}>
          <label>Region</label>
          <div className="chip-row">
            <button className={`chip ${filters.regionCode === '' ? 'on' : ''}`} onClick={() => setFilters({ regionCode: '' })}>
              All
            </button>
            {REGIONS.map((r) => (
              <button
                key={r}
                className={`chip ${filters.regionCode === r ? 'on' : ''}`}
                onClick={() => setFilters({ regionCode: filters.regionCode === r ? '' : r })}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => setFilters({ tiers: [...ALL_TIERS], status: '', regionCode: '' })}
        >
          <Icon name="refresh" size={16} /> Reset
        </button>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onDone?.()}>
          Apply
        </button>
      </div>
    </>
  );
}

/**
 * Horizontal region chips + a "Filters" button that opens a sheet with
 * tier/status pickers. Writes to the shared shell filters.
 *
 * Tiers are a MULTI-select (the same set the map legend toggles): tapping a
 * chip switches that tier on or off, "All" switches every one back on.
 */
export default function FilterBar({ showRegions = true }: { showRegions?: boolean }) {
  const { filters, setFilters } = useShell();
  const [open, setOpen] = useState(false);

  const activeCount = activeFilterCount(filters, !showRegions);

  return (
    <>
      {/* `nowrap`: this is the one strip where a single scrolling line beats a
          wrapped block — six region names are a fixed, short vocabulary and
          wrapping them pushes the content below the fold on a small phone. */}
      <div className="chip-row nowrap">
        {showRegions && (
          <>
            <button className={`chip ${filters.regionCode === '' ? 'on' : ''}`} onClick={() => setFilters({ regionCode: '' })}>
              All regions
            </button>
            {REGIONS.map((r) => (
              <button
                key={r}
                className={`chip ${filters.regionCode === r ? 'on' : ''}`}
                onClick={() => setFilters({ regionCode: filters.regionCode === r ? '' : r })}
              >
                {r[0] + r.slice(1).toLowerCase()}
              </button>
            ))}
          </>
        )}
        <button className={`chip ${activeCount > 0 ? 'on' : ''}`} onClick={() => setOpen(true)}>
          <Icon name="filter" size={13} /> Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
        </button>
      </div>

      {open && (
        <Sheet title="Filters" subtitle="Narrow the working set" onClose={() => setOpen(false)}>
          {/* The region picker only belongs in the sheet when the strip above
              is not already showing it. */}
          <FilterFields withRegions={!showRegions} onDone={() => setOpen(false)} />
        </Sheet>
      )}
    </>
  );
}
