'use client';

import { Icon } from '../ui';
import type { PreciseLocationState } from '../../lib/useLocation';

/**
 * The "where am I" box shared by the resident report and the patrol add-stop
 * form. Driven by `usePreciseLocation`, it:
 *  - offers an "Attach my location" button when idle,
 *  - shows a live accuracy indicator while the fix tightens toward the ≤4 m
 *    target (with a "use this fix now" escape hatch), and
 *  - once settled, displays the street + area in a box alongside the coordinates
 *    and an accuracy dot (green when the target is met, amber otherwise).
 */
export default function LocationBox({
  loc,
  idleLabel = 'Attach my location',
  fullAddress = false,
}: {
  loc: PreciseLocationState;
  idleLabel?: string;
  fullAddress?: boolean;
}) {
  const { pos, place, locating, geocoding, settled, targetM, accurate, error, start, accept } = loc;
  const acc = pos?.accuracyM != null ? Math.round(pos.accuracyM) : null;

  if (!locating && !settled && !pos) {
    return (
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={start}>
          <Icon name="pin" size={15} /> {idleLabel}
        </button>
        {error && <p className="hint-text" style={{ marginTop: 6, color: 'var(--danger, #c0392b)' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div className="loc-box" style={{ marginTop: 10 }}>
      {locating && (
        <div className="loc-live">
          <span className="loc-spin" aria-hidden />
          <span>
            Locating…{' '}
            <strong>{acc != null ? `±${acc} m` : 'searching'}</strong>
            <span className="hint-text"> · tightening to ≤{targetM} m</span>
          </span>
        </div>
      )}

      {(settled || pos) && (
        <div className="loc-place">
          <span className={`dot ${accurate ? 'ok' : 'warn'}`} />
          <div className="loc-place-text">
            <div className="loc-street">
              <Icon name="pin" size={13} /> {place?.street
                ? (fullAddress ? place.fullAddress ?? place.label ?? place.street : place.street)
                : 'Street to be identified'}
            </div>
            <div className="loc-area hint-text">
              {geocoding ? 'Identifying street and area…' : place?.area ?? place?.ward?.name ?? 'Area to be identified'}
              {pos ? ` · ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : ''}
              {acc != null ? ` · ±${acc} m` : ''}
            </div>
          </div>
        </div>
      )}

      <div className="chip-row" style={{ marginTop: 8 }}>
        {locating && (
          <button className="btn btn-ghost btn-sm" onClick={accept} disabled={!pos}>
            <Icon name="check" size={14} /> {pos ? `Use ±${acc} m now` : 'Waiting for fix…'}
          </button>
        )}
        {settled && (
          <button className="btn btn-ghost btn-sm" onClick={start}>
            <Icon name="pin" size={14} /> Update location
          </button>
        )}
      </div>

      {error && <p className="hint-text" style={{ marginTop: 6, color: 'var(--danger, #c0392b)' }}>{error}</p>}
    </div>
  );
}
