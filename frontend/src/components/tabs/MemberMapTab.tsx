'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { MyWard } from '../../types';
import { Sheet } from '../ui';
import RegionSheet from '../RegionSheet';
import UdfStaticMap from '../UdfStaticMap';

/**
 * The Map tab as a MEMBER (`geo:read_own_ward`, not `geo:read`) gets it.
 *
 * This is the UDF static map: three nested boundary layers (region, subcouncil,
 * ward) drawn from a bundled asset, with the device's GPS fix plotted on top and
 * one button per layer. It replaced a MapLibre map that pulled raster tiles from
 * a third-party tile server on every pan — the boundaries are now baked into the
 * bundle at build time, so this tab issues no request to anyone to draw itself
 * and works with no signal.
 *
 * Showing all boundaries rather than only the caller's own ward is not a widening
 * of scope: boundary geometry is the public baseline the `/api/geo/boundaries`
 * endpoint already serves un-scoped, and the baked asset carries nothing but
 * codes, names and outlines — no member points, no counts, no PII of any kind.
 * Tapping a shape opens the RESTRICTED `RegionSheet`, whose counts the server
 * still ANDs with the caller's territory, so an out-of-ward tap returns zeros
 * rather than data.
 */
export default function MemberMapTab() {
  const [selected, setSelected] = useState<{ code: string; geography: string } | null>(null);
  const [own, setOwn] = useState<MyWard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api.geoMyWard().then((ward) => { if (live) setOwn(ward); })
      .catch((e) => { if (live) setError(e?.message ?? 'Your ward profile is unavailable'); });
    return () => { live = false; };
  }, [retry]);

  return (
    <>
      {error && <div className="banner err" role="alert">{error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
      {own && <button className="btn btn-ghost" onClick={() => setSelected({ code: own.ward.code, geography: `${/^ward\b/i.test(own.ward.name) ? own.ward.name : `Ward ${own.ward.name}`} · ${own.subcouncil?.name ?? 'Subcouncil unknown'}` })}>My ward councilor</button>}
      <div className="map-pane">
        <UdfStaticMap
          initialLayer="ward"
          wardCode={own?.ward.code}
          onSelect={setSelected}
        />
      </div>

      {selected && own?.ward.code === selected.code ? (
        <RegionSheet
          code={selected.code}
          geography={selected.geography}
          prefetched={own.summary}
          restricted
          onClose={() => setSelected(null)}
          onBack={() => setSelected(null)}
          onDrill={() => undefined}
        />
      ) : selected ? (
        <Sheet title={selected.geography} onClose={() => setSelected(null)}>
          <p>Public boundary information. Your councilor profile and ward details are available through My ward councilor.</p>
          {!own && <p>{error ?? 'Loading your registered ward…'}</p>}
        </Sheet>
      ) : null}
    </>
  );
}
