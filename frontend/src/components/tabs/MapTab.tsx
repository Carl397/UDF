'use client';

import { useState } from 'react';
import { useShell } from '../AppShell';
import RegionSheet from '../RegionSheet';
import UdfStaticMap from '../UdfStaticMap';
import MemberMapTab from './MemberMapTab';

/**
 * The Map tab, dispatched by what this session may actually see.
 *
 * A member holds `geo:read_own_ward` but NOT `geo:read`: they get the restricted
 * own-ward map (`MemberMapTab`) — their subcouncil + ward and the ward's case
 * record, with no member counts or cross-ward drill. A staff role holds
 * `geo:read` and gets the full map (`FullMapTab`) below. AppShell only mounts
 * this tab when `caps.memberMap` (`geoRead || geoReadOwn`) is true, so exactly
 * one branch always applies.
 *
 * Both branches render the SAME renderer: `UdfStaticMap`, the UDF's own map —
 * three nested boundary layers drawn as plain SVG from a bundled asset
 * (`udfMapData.json`, baked from Postgres by `npm run map:export`) with the
 * device's own GPS fix on top and the area's case record beneath it. There is
 * no tile server, no style URL and no font endpoint in the render path: the map
 * issues no request to any third party to draw itself and works with no signal.
 * The only live call is the area's case counts, which come from our OWN API.
 */
export default function MapTab() {
  const { caps } = useShell();
  if (!caps.geoRead && caps.geoReadOwn) return <MemberMapTab />;
  return <FullMapTab />;
}

/**
 * Staff map: the whole city across all three layers.
 *
 * A staff tap opens the FULL `RegionSheet` (member counts by tier, child areas,
 * ward councillors) — the analytics a member is not shown. The sheet resolves
 * any level by code through `GET /api/geo/region-summary`, so tapping a region,
 * a subcouncil or a ward all work, and its own "Back to …" / drill rows climb
 * the hierarchy in both directions.
 */
function FullMapTab() {
  /** Region code the drill-down sheet is open on, if any. */
  const [region, setRegion] = useState<string | null>(null);

  return (
    <>
      <div className="map-pane">
        <UdfStaticMap
          scrollCue
          initialLayer="region"
          onSelect={({ code }) => setRegion(code)}
        />
      </div>

      {region && (
        <RegionSheet
          code={region}
          onClose={() => setRegion(null)}
          onBack={(parentCode) => setRegion(parentCode)}
          onDrill={(code) => setRegion(code)}
        />
      )}
    </>
  );
}
