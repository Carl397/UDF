'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import mapData from '../lib/udfMapData.json';
import { api } from '../lib/api';
import { mixWhite, prettyRegion, regionColor, wardColorForCode } from '../lib/taxonomy';
import type { AreaCaseStats, CaseStats, HeatmapPoint } from '../types';

/**
 * The UDF static map — three nested boundary layers drawn as plain SVG from a
 * bundled asset, with the device's own GPS fix plotted on top and the area's
 * case record beneath it.
 *
 * Static in the strict sense where it matters: every shape comes from
 * `udfMapData.json`, which `npm run map:export` bakes out of Postgres at build
 * time. The MAP needs no network at all — no tile server, no style URL, no font
 * endpoint — so there is no third party in the render path, which is the entire
 * point of it: the member map cannot leak a request to anyone, cannot be
 * rate-limited, cannot be withdrawn, and draws with the handset in flight mode.
 *
 * The case counts under it are the one thing that cannot be baked, because they
 * change hourly; they come from our OWN API (`/api/geo/case-stats`) and the map
 * renders without them if that call fails. Boundaries offline, numbers live.
 *
 * SVG rather than a canvas/WebGL map because 141 shapes and ~9k vertices is
 * nothing for the DOM, and it buys real things: the layers are inspectable,
 * they scale to any DPI without a raster step, taps hit-test themselves through
 * normal event dispatch, and shapes can be styled from the same CSS custom
 * properties as the rest of the app instead of a parallel style spec.
 *
 * The GPS fix is an indicator, not navigation: it marks where the reader is
 * standing and names the place containing them. Councillor and national patrol
 * routing is a separate surface with a real routable basemap.
 */

/** One layer of the hierarchy, outermost first. */
type Layer = 'region' | 'subcouncil' | 'ward';

const LAYERS: { id: Layer; label: string }[] = [
  { id: 'region', label: 'Region' },
  { id: 'subcouncil', label: 'Subcouncil' },
  { id: 'ward', label: 'Ward' },
];

interface StaticShape {
  code: string;
  name: string;
  parentCode: string | null;
  rings: number[][][];
}

/** The baked asset, with the structural typing the JSON import cannot express. */
const DATA = mapData as unknown as {
  generatedAt: string;
  bbox: [number, number, number, number];
  layers: Record<Layer, StaticShape[]>;
  /**
   * Suburbs are a name lookup, not a fourth layer — nothing draws them. They
   * exist so a fix can be reported as "Woodstock" rather than only "Ward 115",
   * which is the name a member actually recognises.
   */
  suburbs: StaticShape[];
};

/**
 * Ward code → the suburbs inside it.
 *
 * Free from the asset: the boundary import already parents each suburb to its
 * ward, so this is a regroup rather than a spatial join. Built once at module
 * load because it is the same for every mount.
 */
const SUBURBS_BY_WARD = ((): Map<string, StaticShape[]> => {
  const byWard = new Map<string, StaticShape[]>();
  for (const suburb of DATA.suburbs) {
    if (!suburb.parentCode) continue;
    const list = byWard.get(suburb.parentCode);
    if (list) list.push(suburb);
    else byWard.set(suburb.parentCode, [suburb]);
  }
  return byWard;
})();

/** Subcouncil code → its region code, so a ward can name its region in one hop. */
const REGION_OF_SUBCOUNCIL = new Map(
  DATA.layers.subcouncil.map((s) => [s.code, s.parentCode]),
);

/**
 * Region code → its display name.
 *
 * Needed because a ward only knows its region as a CODE, and the codes are bare
 * compass words ("WEST"). The region rows carry the proper name ("Western
 * Region"), so the map reads that rather than title-casing the code into "West",
 * which is not what the region is called.
 */
const REGION_NAME = new Map(
  DATA.layers.region.map((r) => [r.code, r.name] as const),
);

/** A region's display name, falling back to the app's code-prettifier. */
function regionName(code: string): string {
  return REGION_NAME.get(code) ?? prettyRegion(code);
}

/**
 * Suburb names arrive from the boundary import in full caps ("CAPE TOWN CITY
 * CENTRE"), which reads as shouting beside every other label in the app.
 * Word-wise capitalisation is sufficient for this source: capitalising after a
 * space or a hyphen leaves "Simon's Town" and "Cape Farms - District H" right,
 * because the apostrophe sits inside a word rather than starting one.
 */
function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Viewport the shapes are projected into. Arbitrary units — the SVG is scaled
 * to its container by `viewBox` + `preserveAspectRatio`, so this only sets the
 * coordinate precision of the path data.
 */
const VIEW_W = 1000;

/** Padding inside the frame, in view units, so strokes are not clipped. */
const PAD = 8;

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * Web Mercator northing for a latitude, returned in DEGREES.
 *
 * Mercator rather than plotting lon/lat straight into the viewBox: at 34° south a
 * degree of longitude is only ~83% the length of a degree of latitude, so the raw
 * equirectangular version stretches the metro east-west and every shape reads
 * subtly wrong to anyone who knows the city.
 *
 * The ×180/π is not cosmetic. The Mercator y term is an isometric latitude in
 * RADIANS, while x here is a longitude in degrees; dividing the frame by one and
 * multiplying by the other silently mixes units and flattens the map to a ~24:1
 * letterbox. Converting y to degrees puts both axes in the same unit, which is
 * what makes the aspect ratio come out as the map's own ~0.65:1.
 */
function mercatorY(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

const [MIN_LON, MIN_LAT, MAX_LON, MAX_LAT] = DATA.bbox;
const Y_TOP = mercatorY(MAX_LAT);
const Y_BOTTOM = mercatorY(MIN_LAT);

/** Scale factor mapping bbox longitude span onto the padded frame width. */
const SCALE = (VIEW_W - PAD * 2) / (MAX_LON - MIN_LON);

/**
 * Frame height derived from the projection rather than fixed, so the aspect
 * ratio is the map's own and nothing is squashed to fit a chosen box.
 */
const VIEW_H = (Y_TOP - Y_BOTTOM) * SCALE + PAD * 2;

/** Project one lon/lat pair into view coordinates. */
function project(lon: number, lat: number): [number, number] {
  return [
    PAD + (lon - MIN_LON) * SCALE,
    PAD + (Y_TOP - mercatorY(lat)) * SCALE,
  ];
}

/** Build one SVG path covering every ring of a shape. */
function pathOf(shape: StaticShape): string {
  let d = '';
  for (const ring of shape.rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const [x, y] = project(ring[i]![0]!, ring[i]![1]!);
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    d += 'Z';
  }
  return d;
}

// ── Interactive viewport ─────────────────────────────────────────────────────

/** A viewBox rectangle in projected view units. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Aspect the frame is locked to. The viewBox always carries this exact ratio,
 * so pan/zoom can move it freely without the SVG ever letterboxing inside the
 * frame — which is what makes a client pixel map to a constant number of view
 * units in both axes, the assumption every gesture below relies on.
 */
const MAP_ASPECT = VIEW_W / VIEW_H;

/** The whole map — the zoomed-all-the-way-out extent, and the reset target. */
const FULL_VIEW: Box = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

/** Closest zoom-in, as a width in view units, so a tap can't zoom to a blur. */
const MIN_VIEW_W = VIEW_W * 0.04;

/** Projected bounding box of a shape, so the viewport can be flown to it. */
function boxOf(shape: StaticShape): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of shape.rings) {
    for (const pt of ring) {
      const [x, y] = project(pt[0]!, pt[1]!);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Keep a viewport legal: aspect locked to the frame, zoom clamped between the
 * whole map and MIN_VIEW_W, and panned only as far as the map's own edges so
 * the reader can never lose the geography off-screen into blank space.
 */
function clampView(v: Box): Box {
  const w = Math.min(Math.max(v.w, MIN_VIEW_W), VIEW_W);
  const h = w / MAP_ASPECT;
  const x = w >= VIEW_W ? (VIEW_W - w) / 2 : Math.min(Math.max(v.x, 0), VIEW_W - w);
  const y = h >= VIEW_H ? (VIEW_H - h) / 2 : Math.min(Math.max(v.y, 0), VIEW_H - h);
  return { x, y, w, h };
}

/**
 * Grow a shape's box by `padScale` for breathing room, expand it to the frame
 * aspect about its centre, then clamp — the target a tap flies the viewport to.
 */
function fitBox(box: Box, padScale: number): Box {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let w = box.w * padScale;
  let h = box.h * padScale;
  if (w / h > MAP_ASPECT) h = w / MAP_ASPECT;
  else w = h * MAP_ASPECT;
  return clampView({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/**
 * Zoom a viewport by `factor` while holding a client-pixel focal point still,
 * so a pinch or a wheel zooms into whatever is under the fingers/cursor rather
 * than the map's centre.
 */
function zoomAbout(v: Box, factor: number, clientX: number, clientY: number, rect: DOMRect): Box {
  const fx = v.x + ((clientX - rect.left) / rect.width) * v.w;
  const fy = v.y + ((clientY - rect.top) / rect.height) * v.h;
  const w = Math.min(Math.max(v.w * factor, MIN_VIEW_W), VIEW_W);
  const h = w / MAP_ASPECT;
  return clampView({
    x: fx - (fx - v.x) * (w / v.w),
    y: fy - (fy - v.y) * (h / v.h),
    w,
    h,
  });
}

// ── Hit-testing ──────────────────────────────────────────────────────────────

/**
 * Even-odd ray casting in lon/lat space: does this position fall inside the
 * shape?
 *
 * Counting crossings across ALL rings — outer boundaries and holes together —
 * is what makes holes work without tracking which ring is which. A point in a
 * hole crosses the outer ring once and the hole ring once: two crossings, even,
 * outside. Which is correct.
 *
 * Tested in lon/lat, not projected view units, because the fix arrives in
 * lon/lat and Mercator is conformal — it cannot move a point across an edge, so
 * projecting first would only add rounding.
 */
function contains(shape: StaticShape, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of shape.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = [ring[i]![0]!, ring[i]![1]!];
      const [xj, yj] = [ring[j]![0]!, ring[j]![1]!];
      // Half-open comparison on latitude: a vertex exactly level with the ray
      // is counted by one of its two edges, never both, so a position due east
      // of a vertex is not double-counted into the wrong parity.
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Colour for a shape, per layer, from the app's shared palette. */
function fillOf(layer: Layer, shape: StaticShape): string {
  if (layer === 'region') return mixWhite(regionColor(shape.code), 0.45);
  if (layer === 'subcouncil') {
    return mixWhite(regionColor(shape.parentCode ?? shape.code), 0.6);
  }
  return mixWhite(wardColorForCode(shape.code), 0.35);
}

/**
 * Human label for a shape.
 *
 * All three layers need help, for different reasons. Region codes are bare
 * compass words, so the row's own name is used ("Western Region"). Ward rows
 * carry the bare number the boundary import read off the source attribute —
 * `name` is literally "9" — so they need the word prefixed, guarded for the
 * handful of fixture wards already named "Ward 117", which would otherwise read
 * "Ward Ward 117". Subcouncils are the only layer already display-ready
 * ("Subcouncil 4").
 */
function labelOf(layer: Layer, shape: StaticShape): string {
  if (layer === 'region') return regionName(shape.code);
  if (layer !== 'ward') return shape.name;
  return /^ward\b/i.test(shape.name) ? shape.name : `Ward ${shape.name}`;
}

function geographyLabel(layer: Layer, shape: StaticShape): string {
  const parts = [labelOf(layer, shape)];
  const subcouncil = layer === 'ward' ? DATA.layers.subcouncil.find((s) => s.code === shape.parentCode) : null;
  if (subcouncil) parts.push(labelOf('subcouncil', subcouncil));
  const regionCode = layer === 'ward' ? subcouncil?.parentCode : layer === 'subcouncil' ? shape.parentCode : null;
  if (regionCode) parts.push(regionName(regionCode));
  return parts.join(' · ');
}

/** The three bars, in the order they are drawn. */
const BARS: { key: 'open' | 'resolved' | 'followUps'; label: string; tone: string }[] = [
  { key: 'open', label: 'Open cases', tone: 'open' },
  { key: 'resolved', label: 'Resolved cases', tone: 'resolved' },
  { key: 'followUps', label: 'Follow-ups', tone: 'follow' },
];

const ZERO_STATS: AreaCaseStats = { code: '', open: 0, resolved: 0, followUps: 0 };

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  /** Layer shown on mount. */
  initialLayer?: Layer;
  /** Notified when a shape is tapped, for a drill-down sheet. */
  onSelect?: (selection: { layer: Layer; code: string; name: string; geography: string }) => void;
  wardCode?: string;
  heatPoints?: HeatmapPoint[];
  showCaseStats?: boolean;
  /** Start watching position immediately rather than waiting for the button. */
  autoLocate?: boolean;
}

/** The device's own position, once granted. */
interface Fix {
  lon: number;
  lat: number;
  /** Reported accuracy radius in metres, for the uncertainty ring. */
  accuracy: number;
}

export default function UdfStaticMap({
  initialLayer = 'ward',
  onSelect,
  autoLocate = false,
  wardCode,
  heatPoints = [],
  showCaseStats = true,
}: Props) {
  const [layer, setLayer] = useState<Layer>(initialLayer);
  const [selected, setSelected] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [stats, setStats] = useState<CaseStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [statsRetry, setStatsRetry] = useState(0);
  const watchRef = useRef<number | null>(null);

  // Interactive viewport. `view` is the live viewBox; `viewRef` mirrors it so
  // the rAF tween and the pointer handlers can read the current value without a
  // stale closure. Pointer bookkeeping lives in refs because it changes many
  // times per gesture and must never trigger a render of its own.
  const [view, setView] = useState<Box>(FULL_VIEW);
  const viewRef = useRef<Box>(FULL_VIEW);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const ptrsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef(0);
  const movedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const zoomedToFixRef = useRef(false);

  /**
   * Case counts for the whole map, fetched once.
   *
   * One call covers all three layers, so switching layer or tapping a shape
   * re-reads memory instead of hitting the API — the buttons stay instant. A
   * failure is deliberately silent in the UI: the boundaries and the GPS fix are
   * still useful without the numbers, and an error banner over a working map
   * would be the more misleading outcome.
   */
  useEffect(() => {
    if (!showCaseStats) return;
    let live = true;
    setStatsError(false);
    api
      .geoCaseStats()
      .then((res) => {
        if (live) setStats(res);
      })
      .catch(() => { if (live) { setStats(null); setStatsError(true); } });
    return () => {
      live = false;
    };
  }, [statsRetry, showCaseStats]);

  useEffect(() => {
    if (wardCode === undefined) return;
    const ward = DATA.layers.ward.find((s) => s.code === wardCode);
    setLayer('ward');
    setSelected(ward?.code ?? null);
    stopAnim();
    setView(ward ? fitBox(boxOf(ward), 1.6) : FULL_VIEW);
  }, [wardCode]);

  /**
   * Shapes of the active layer. Memoised because the `?? []` fallback would
   * otherwise hand back a fresh array identity on every render, invalidating
   * the two memos below it and reprojecting ~9k vertices on each GPS tick.
   */
  const shapes = useMemo<StaticShape[]>(() => DATA.layers[layer] ?? [], [layer]);

  /**
   * Paths are memoised per layer: projecting ~9k vertices is cheap once but
   * would otherwise repeat on every GPS tick, and a fix arrives about once a
   * second while the watch is open.
   */
  const paths = useMemo(
    () => shapes.map((shape) => ({ shape, d: pathOf(shape), box: boxOf(shape) })),
    [shapes],
  );

  /** The shape the reader is standing in, at the layer they are looking at. */
  const here = useMemo(() => {
    if (!fix) return null;
    return shapes.find((shape) => contains(shape, fix.lon, fix.lat)) ?? null;
  }, [fix, shapes]);

  /**
   * The ward containing the fix, whatever layer is on screen.
   *
   * Tracked separately from `here` because the suburb and the region are read
   * off the ward: standing in Woodstock while looking at the Region layer should
   * still name Woodstock, and `here` would be the region in that case.
   */
  const wardHere = useMemo(() => {
    if (!fix) return null;
    return DATA.layers.ward.find((w) => contains(w, fix.lon, fix.lat)) ?? null;
  }, [fix]);

  /**
   * The suburb containing the fix.
   *
   * Narrowed to the suburbs of the containing ward first, which turns 778
   * point-in-polygon tests into about half a dozen — worth doing because this
   * recomputes on every GPS tick, roughly once a second while the watch is open.
   */
  const suburbHere = useMemo(() => {
    if (!fix || !wardHere) return null;
    const candidates = SUBURBS_BY_WARD.get(wardHere.code) ?? [];
    return candidates.find((s) => contains(s, fix.lon, fix.lat)) ?? null;
  }, [fix, wardHere]);

  /**
   * The area the readout and the bars describe: what was tapped, else where the
   * reader is standing, else nothing (and the bars fall back to the whole
   * layer's total).
   */
  const focus = useMemo(
    () => (selected ? shapes.find((s) => s.code === selected) ?? null : here),
    [selected, shapes, here],
  );

  /**
   * Counts for the focused area, or the layer's total when nothing is focused.
   *
   * Totalling across the layer rather than showing dashes means the panel always
   * answers something true — on the Region layer with no selection it is the
   * movement's whole case record.
   */
  const focusStats = useMemo<AreaCaseStats>(() => {
    const rows = stats?.[layer];
    if (!rows) return ZERO_STATS;
    if (focus) return rows.find((r) => r.code === focus.code) ?? { ...ZERO_STATS, code: focus.code };
    return rows.reduce(
      (sum, r) => ({
        code: '',
        open: sum.open + r.open,
        resolved: sum.resolved + r.resolved,
        followUps: sum.followUps + r.followUps,
      }),
      ZERO_STATS,
    );
  }, [stats, layer, focus]);

  /**
   * The place names for the focused area, outermost name last.
   *
   * Only the ward layer carries all three, because only a ward is small enough
   * for a suburb to mean anything. With a GPS fix the suburb is the one the
   * reader is actually standing in; without one, a tapped ward names the suburbs
   * it contains, because a ward has several and picking one would be a guess.
   */
  const placeRows = useMemo<{ label: string; value: string }[]>(() => {
    if (!focus) return [];
    if (layer === 'region') return [{ label: 'Region', value: regionName(focus.code) }];

    if (layer === 'subcouncil') {
      const rows = [{ label: 'Subcouncil', value: focus.name }];
      if (focus.parentCode) rows.push({ label: 'Region', value: regionName(focus.parentCode) });
      return rows;
    }

    const rows = [{ label: 'Ward', value: labelOf('ward', focus) }];
    const subcouncil = DATA.layers.subcouncil.find((s) => s.code === focus.parentCode);
    if (subcouncil) rows.push({ label: 'Subcouncil', value: labelOf('subcouncil', subcouncil) });

    const inThisWard = focus.code === wardHere?.code ? suburbHere : null;
    const suburbs = SUBURBS_BY_WARD.get(focus.code) ?? [];
    if (inThisWard) {
      rows.push({ label: 'Suburb', value: titleCase(inThisWard.name) });
    } else if (suburbs.length > 0) {
      const names = suburbs.map((s) => titleCase(s.name)).sort();
      rows.push({
        label: suburbs.length === 1 ? 'Suburb' : 'Suburbs',
        value: names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', '),
      });
    }

    const regionCode = focus.parentCode ? REGION_OF_SUBCOUNCIL.get(focus.parentCode) : null;
    if (regionCode) rows.push({ label: 'Region', value: regionName(regionCode) });
    return rows;
  }, [focus, layer, wardHere, suburbHere]);

  /** Is the fix even on this map? */
  const fixOnMap =
    fix !== null &&
    fix.lon >= MIN_LON &&
    fix.lon <= MAX_LON &&
    fix.lat >= MIN_LAT &&
    fix.lat <= MAX_LAT;

  // Release the GPS watch on unmount. A watch left open is the one thing this
  // component can do that costs battery after the reader has moved on.
  useEffect(
    () => () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Keep the ref mirror in step so gesture handlers and the tween read the
  // committed viewport without waiting for a re-render.
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  function stopAnim(): void {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  /**
   * Ease the viewport from where it is to `target` over ~380ms. A tween rather
   * than a jump because the whole point of the tap is to show the reader WHERE
   * the place is; a cut teleports them and they lose the relationship to the
   * rest of the metro, while a glide keeps it.
   */
  function animateTo(target: Box): void {
    stopAnim();
    const start = viewRef.current;
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dur = 380;
    const tick = (now: number): void => {
      const p = Math.min((now - t0) / dur, 1);
      // easeInOutQuad: unhurried at both ends, quick through the middle.
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      const next: Box = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        w: start.w + (target.w - start.w) * e,
        h: start.h + (target.h - start.h) * e,
      };
      viewRef.current = next;
      setView(next);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Wheel zoom for the desktop CRM. Attached natively, not through React's
  // onWheel, because the listener must be non-passive to preventDefault the
  // page scroll the wheel would otherwise do over the map.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      stopAnim();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setView((v) => zoomAbout(v, factor, e.clientX, e.clientY, rect));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Pan & pinch ────────────────────────────────────────────────────────────
  // One pointer drags; two pointers pinch-zoom about their midpoint. `movedRef`
  // records whether the gesture travelled, so a drag that happens to end on a
  // shape is not mistaken for a tap that selects it.

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    stopAnim();
    ptrsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedRef.current = false;
    if (ptrsRef.current.size === 2) {
      const [a, b] = [...ptrsRef.current.values()];
      pinchRef.current = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const prev = ptrsRef.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    ptrsRef.current.set(e.pointerId, cur);
    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    if (ptrsRef.current.size >= 2) {
      const [a, b] = [...ptrsRef.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const midX = (a!.x + b!.x) / 2;
      const midY = (a!.y + b!.y) / 2;
      const prevDist = pinchRef.current || dist;
      pinchRef.current = dist;
      movedRef.current = true;
      // prevDist/dist: fingers spreading (dist grows) gives factor < 1, which
      // shrinks the viewBox — i.e. zooms in. Exactly the natural direction.
      const factor = dist > 0 ? prevDist / dist : 1;
      setView((v) => zoomAbout(v, factor, midX, midY, rect));
      return;
    }

    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      movedRef.current = true;
      frameRef.current?.setPointerCapture(e.pointerId);
    }
    setView((v) => {
      const per = v.w / rect.width;
      return clampView({ ...v, x: v.x - dx * per, y: v.y - dy * per });
    });
  }

  function endPointer(e: React.PointerEvent<HTMLDivElement>): void {
    ptrsRef.current.delete(e.pointerId);
    if (ptrsRef.current.size < 2) pinchRef.current = 0;
  }

  useEffect(() => {
    if (autoLocate) startLocate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocate]);

  function startLocate(): void {
    if (!('geolocation' in navigator)) {
      setGeoError('This device has no location service.');
      return;
    }
    if (watchRef.current !== null) return;

    setLocating(true);
    setGeoError(null);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setLocating(false);
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        setFix({ lon, lat, accuracy: pos.coords.accuracy });
        // Fly to the fix the first time only, so a later drift tick doesn't
        // yank a viewport the reader has since panned somewhere on purpose.
        const within = lon >= MIN_LON && lon <= MAX_LON && lat >= MIN_LAT && lat <= MAX_LAT;
        if (within && !zoomedToFixRef.current) {
          zoomedToFixRef.current = true;
          const [mx, my] = project(lon, lat);
          const w = VIEW_W * 0.22;
          const h = w / MAP_ASPECT;
          animateTo(clampView({ x: mx - w / 2, y: my - h / 2, w, h }));
        }
      },
      (err) => {
        setLocating(false);
        // Distinguish refusal from failure: "denied" needs a settings change,
        // the others are worth retrying, and a single generic message would
        // send half the readers to the wrong remedy.
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission is off. Enable it to see where you are.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'No GPS signal right now. Try again outdoors.'
              : 'Could not get a location fix. Try again.',
        );
        if (watchRef.current !== null) {
          navigator.geolocation.clearWatch(watchRef.current);
          watchRef.current = null;
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  }

  function choose(shape: StaticShape, box: Box): void {
    // A drag that ended on this shape is not a tap — don't hijack it into a
    // selection, and don't fly the viewport out from under the pan.
    if (movedRef.current) return;
    setSelected(shape.code);
    animateTo(fitBox(box, 1.6));
    onSelect?.({ layer, code: shape.code, name: labelOf(layer, shape), geography: geographyLabel(layer, shape) });
  }

  const marker = fix && fixOnMap ? project(fix.lon, fix.lat) : null;

  /** Tallest bar, so the other two are drawn in proportion to it. */
  const peak = Math.max(focusStats.open, focusStats.resolved, focusStats.followUps);

  return (
    <div className="udf-map">
      {/* Layer switch — the three buttons that are the map's whole control set. */}
      <div className="udf-map-layers" role="group" aria-label="Map layer">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`udf-map-layer${layer === l.id ? ' on' : ''}`}
            aria-pressed={layer === l.id}
            onClick={() => {
              setLayer(l.id);
              setSelected(null);
              stopAnim();
              setView(FULL_VIEW);
            }}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div
        className="udf-map-frame"
        ref={frameRef}
        style={{ aspectRatio: `${VIEW_W} / ${VIEW_H.toFixed(1)}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <svg
          viewBox={`${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`}
          preserveAspectRatio="xMidYMid meet"
          className="udf-map-svg"
          role="img"
          aria-label={`UDF ${layer} boundaries`}
        >
          {paths.map(({ shape, d, box }) => {
            const isHere = here?.code === shape.code;
            const isSelected = selected === shape.code;
            return (
              <path
                key={shape.code}
                d={d}
                fill={fillOf(layer, shape)}
                fillRule="evenodd"
                stroke={isSelected || isHere ? 'var(--red)' : 'var(--line-strong)'}
                strokeWidth={isSelected || isHere ? 2.4 : 0.9}
                vectorEffect="non-scaling-stroke"
                className="udf-map-shape"
                tabIndex={0}
                role="button"
                aria-label={geographyLabel(layer, shape)}
                aria-pressed={isSelected}
                onClick={() => choose(shape, box)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose(shape, box);
                  }
                }}
              />
            );
          })}

          <g pointerEvents="none" aria-hidden="true">
            {paths.map(({ shape, box }) => {
              if (box.w / view.w < (layer === 'region' ? 0.15 : 0.055) || box.h / view.h < 0.025) return null;
              return <text key={shape.code} x={box.x + box.w / 2} y={box.y + box.h / 2}
                textAnchor="middle" dominantBaseline="middle" fontSize={view.w * 0.019}
                fontWeight={700} fill="#17202a" stroke="#fff" strokeWidth={view.w * 0.003}
                paintOrder="stroke">{labelOf(layer, shape)}</text>;
            })}
          </g>
          <g aria-label="Service case density">
            {heatPoints.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.latitude >= MIN_LAT && p.latitude <= MAX_LAT && p.longitude >= MIN_LON && p.longitude <= MAX_LON).map((p, i) => {
              const [x, y] = project(p.longitude, p.latitude);
              return <circle key={`${p.latitude}:${p.longitude}:${p.category}:${i}`} cx={x} cy={y}
                r={Math.min(22, 5 + Math.sqrt(p.count) * 3) * view.w / VIEW_W}
                fill="#c8102e" fillOpacity={0.45} stroke="#7f1020" strokeWidth={0.7} vectorEffect="non-scaling-stroke">
                <title>{p.category}: {p.count} case{p.count === 1 ? '' : 's'} (approximate location)</title>
              </circle>;
            })}
          </g>
          {/* GPS indicator, drawn last so it is never covered by a shape. */}
          {marker && fix && (
            <g className="udf-map-fix" pointerEvents="none">
              {/* Uncertainty ring, sized from the reported accuracy. Left in
                  view units so it stays true to real distance as the reader
                  zooms — the ring is a claim about precision, not a UI chrome.
                  ~111 km per degree of latitude at this latitude. */}
              <circle
                cx={marker[0]}
                cy={marker[1]}
                r={Math.max((fix.accuracy / 111_000) * SCALE, 4)}
                fill="var(--red)"
                fillOpacity={0.14}
                stroke="var(--red)"
                strokeOpacity={0.3}
                strokeWidth={0.8}
                vectorEffect="non-scaling-stroke"
              />
              {/* The dot itself is chrome, not distance: its radius tracks the
                  zoom so it stays a constant size on screen instead of
                  ballooning to cover a whole ward when zoomed right in. */}
              <circle
                cx={marker[0]}
                cy={marker[1]}
                r={Math.max(5 * (view.w / VIEW_W), 1.4)}
                fill="var(--red)"
                stroke="#fff"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>

        {/* View controls, bottom-right. Reset only appears once the reader has
            moved away from the full extent, so it isn't clutter at rest. */}
        <div className="udf-map-tools">
          {(view.w < VIEW_W - 1 || view.x > 0.5 || view.y > 0.5) && (
            <button
              type="button"
              className="udf-map-reset"
              onClick={() => animateTo(FULL_VIEW)}
              aria-label="Reset map view"
            >
              ⤢
            </button>
          )}
          <button
            type="button"
            className="udf-map-locate"
            onClick={startLocate}
            disabled={locating}
            aria-label="Show my location"
          >
            {locating ? '…' : '◎'}
          </button>
        </div>
      </div>

      {/* Status line: what the GPS found, or why it did not. */}
      <div className="udf-map-status" aria-live="polite">
        {geoError ? (
          <span className="udf-map-status-err">{geoError}</span>
        ) : here ? (
          <span>
            You are in <strong>{labelOf(layer, here)}</strong>
          </span>
        ) : fix && !fixOnMap ? (
          <span>You are outside the mapped area.</span>
        ) : fix ? (
          <span>Location found, but not inside a mapped {layer}.</span>
        ) : (
          <span className="udf-map-status-idle">Tap ◎ to show where you are.</span>
        )}
      </div>

      {/* Where the reader is, in the names they would use themselves. */}
      {placeRows.length > 0 && (
        <div className="udf-map-place">
          {placeRows.map((row) => (
            <div className="udf-map-place-row" key={row.label}>
              <span className="udf-map-place-k">{row.label}</span>
              <span className="udf-map-place-v">{row.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* The area's case record. Three bars, each with its own count above it —
          this is what replaced the heat overlay: a colour gradient could show
          that somewhere was "hot" but never how many cases that was, nor whether
          they had been resolved. */}
      {showCaseStats && <div className="udf-map-bars-card">
        {statsError && <p role="alert">Case counts unavailable. <button onClick={() => setStatsRetry((n) => n + 1)}>Retry</button></p>}
        <div className="udf-map-bars-head">
          <span>Cases</span>
          <span className="udf-map-bars-scope">
            {focus ? labelOf(layer, focus) : `All ${layer === 'subcouncil' ? 'subcouncils' : `${layer}s`}`}
          </span>
        </div>
        <div className="udf-map-bars">
          {BARS.map((bar) => {
            const value = focusStats[bar.key];
            // Scaled against the largest of the three, so the shortest bar is
            // still readable. A zero bar keeps a visible stub rather than
            // vanishing, because an absent bar and a zero bar are different
            // claims and only one of them is being made.
            const height = peak > 0 ? Math.max(Math.round((value / peak) * 100), value > 0 ? 6 : 2) : 2;
            return (
              <div className="udf-map-bar-col" key={bar.key}>
                <span className="udf-map-bar-val">{stats ? value.toLocaleString('en-ZA') : '–'}</span>
                <span className="udf-map-bar-track">
                  <span className={`udf-map-bar-fill ${bar.tone}`} style={{ height: `${height}%` }} />
                </span>
                <span className="udf-map-bar-lab">{bar.label}</span>
              </div>
            );
          })}
        </div>
      </div>}
    </div>
  );
}
