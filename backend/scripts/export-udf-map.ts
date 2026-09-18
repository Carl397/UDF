import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/db/pool.js';
import { logger } from '../src/config/logger.js';

/**
 * Bakes the three map layers (region → subcouncil → ward) out of Postgres into
 * a single static asset the app ships inside its own bundle.
 *
 * This is what makes the UDF map "static": the boundaries are frozen into a
 * JSON file at build time, so at runtime the map draws from memory and issues
 * NO network request of any kind — not to a tile server, not even to our own
 * API. It renders offline, in a WebView with no signal, on first paint.
 *
 * Geometry is simplified per layer before it is written. Full-resolution ward
 * polygons are far more detail than a boundary overview can show — the coastline
 * alone carries vertices spaced closer than a screen pixel at metro zoom — so
 * each layer is reduced to a tolerance matched to how large it is drawn.
 *
 * ST_SimplifyPreserveTopology, not ST_Simplify: the plain version happily returns
 * self-intersecting rings from concave shapes, which then render as inside-out
 * fills.
 *
 * KNOWN TRADE-OFF: topology is preserved within each geometry but not ACROSS
 * them, so two neighbouring wards simplify their shared border independently and
 * the results can diverge by up to the tolerance — leaving hairline slivers along
 * internal seams. That is accepted here on measurement, not by omission: at 22 m
 * on a map fitting a 64 km-wide metro into ~400 px, worst-case divergence is
 * ~0.14 px, i.e. invisible. Both alternatives measured worse. ST_SnapToGrid is
 * genuinely coverage-safe (it maps every coordinate through one lattice, so a
 * shared vertex moves identically for both owners) but removes almost no vertices
 * from this source data — measured at 817 KB, over 4× the simplified asset, to fix
 * a sub-pixel artefact. ST_CoverageSimplify is the purpose-built tool and would
 * give both, but it needs GEOS 3.12+ and this deployment's PostGIS is linked
 * against 3.9, so it raises rather than running. Revisit if the database image is
 * ever upgraded.
 *
 * ST_MakeValid runs after simplification because reducing a pinched ring can push
 * it into self-intersection, and ST_CollectionExtract(…, 3) then keeps only the
 * polygonal part — repairing such a polygon can otherwise yield a collection with
 * stray lines or points in it, which ST_AsGeoJSON would emit and the renderer
 * would choke on.
 *
 * Coordinates stay in lon/lat (WGS84) rather than being pre-projected to SVG
 * space, because the GPS fix the map plots arrives in lon/lat and the
 * point-in-polygon test that names the caller's ward has to run against the
 * same numbers. Projection is the renderer's job and depends on the viewport.
 *
 * Suburbs are exported too, but as a LOOKUP layer rather than a drawn one: the
 * map still has exactly three layers to switch between, and the 778 suburb
 * polygons exist only so a GPS fix can be named with the place a member would
 * actually recognise ("Woodstock") instead of a ward number. They are therefore
 * kept out of `layers` — nothing renders them — and out of the bbox, so adding
 * them cannot shift the frame the three real layers are fitted to.
 *
 * Run with: npm run map:export
 */

/**
 * Simplification tolerance per layer, in WGS84 degrees (~111 km per degree of
 * latitude here, so 0.0002° ≈ 22 m). Larger shapes are drawn at coarser effective
 * scale and tolerate more reduction; wards are the layer a member looks at
 * closely, so they keep the finest tolerance.
 */
const TOLERANCE: Record<Layer, number> = {
  region: 0.0006,
  subcouncil: 0.0004,
  ward: 0.0002,
  // Never drawn, only point-tested, so this only has to be fine enough that a
  // fix near a suburb edge lands on the right side. Measured at 245 KB.
  suburb: 0.0004,
};

/** Decimal places kept per coordinate. 5 dp ≈ 1.1 m — well under one pixel. */
const PRECISION = 5;

type Layer = 'region' | 'subcouncil' | 'ward' | 'suburb';

/** The layers the map draws and lets you switch between. */
const LAYERS: Layer[] = ['region', 'subcouncil', 'ward'];

/** A boundary reduced to what the renderer and the hit-test actually need. */
interface StaticShape {
  code: string;
  name: string;
  parentCode: string | null;
  /**
   * Every ring of every polygon in one flat list, outer rings and holes alike.
   * Both consumers are even-odd: an SVG path with `fill-rule: evenodd` and a
   * ray-casting hit-test that counts crossings, so neither needs to know which
   * ring is a hole — a point inside a hole crosses two rings and reads as
   * outside, which is the correct answer, for free.
   */
  rings: number[][][];
}

interface GeoJsonGeometry {
  type: string;
  coordinates: number[][][] | number[][][][];
}

/** Round to PRECISION, dropping the float noise that inflates the JSON. */
function round(n: number): number {
  return Number(n.toFixed(PRECISION));
}

/**
 * Flatten a GeoJSON Polygon/MultiPolygon into the even-odd ring list, dropping
 * degenerate rings. A ring of fewer than 4 positions cannot enclose area (the
 * last position repeats the first), and simplification does leave a few behind
 * on slivers; they would contribute a stray line to the path and a spurious
 * crossing to the hit-test.
 */
function toRings(geom: GeoJsonGeometry): number[][][] {
  const polygons: number[][][][] =
    geom.type === 'Polygon'
      ? [geom.coordinates as number[][][]]
      : (geom.coordinates as number[][][][]);

  const rings: number[][][] = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 4) continue;
      rings.push(ring.map(([lon, lat]) => [round(lon), round(lat)]));
    }
  }
  return rings;
}

async function fetchLayer(layer: Layer): Promise<StaticShape[]> {
  const res = await query<{
    code: string;
    name: string;
    parent_code: string | null;
    geom: string;
  }>(
    `SELECT code, name, parent_code, ST_AsGeoJSON(geom) AS geom
       FROM (
         SELECT code,
                name,
                parent_code,
                ST_CollectionExtract(
                  ST_MakeValid(ST_SimplifyPreserveTopology(ST_MakeValid(geom), $2)),
                  3
                ) AS geom
           FROM regions
          WHERE level = $1
            AND geom IS NOT NULL
       ) AS reduced
      WHERE geom IS NOT NULL
        AND NOT ST_IsEmpty(geom)
      ORDER BY code`,
    [layer, TOLERANCE[layer]],
  );

  const shapes: StaticShape[] = [];
  for (const row of res.rows) {
    const rings = toRings(JSON.parse(row.geom) as GeoJsonGeometry);
    // A shape reduced away entirely would render as an invisible, unclickable
    // entry in the layer's legend — leave it out and say so.
    if (rings.length === 0) {
      logger.warn({ layer, code: row.code }, 'shape has no drawable ring — skipped');
      continue;
    }
    shapes.push({
      code: row.code,
      name: row.name,
      parentCode: row.parent_code,
      rings,
    });
  }
  return shapes;
}

async function main(): Promise<void> {
  const layers: Record<string, StaticShape[]> = {};
  let vertices = 0;

  for (const layer of LAYERS) {
    const shapes = await fetchLayer(layer);
    layers[layer] = shapes;
    const count = shapes.reduce(
      (sum, s) => sum + s.rings.reduce((r, ring) => r + ring.length, 0),
      0,
    );
    vertices += count;
    logger.info({ layer, shapes: shapes.length, vertices: count }, 'layer baked');
  }

  // One bbox over every DRAWN layer, so the renderer can fit the whole map
  // without walking the geometry on mount. Derived from the widest layer in
  // practice, but computed across all of them: a ward reaching past its
  // dissolved parent would otherwise be clipped at the frame edge.
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const shapes of Object.values(layers)) {
    for (const shape of shapes) {
      for (const ring of shape.rings) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
  }

  // Suburbs last, and deliberately after the bbox: they are a name lookup, not
  // a layer, so they must not influence the frame.
  const suburbs = await fetchLayer('suburb');
  const suburbVertices = suburbs.reduce(
    (sum, s) => sum + s.rings.reduce((r, ring) => r + ring.length, 0),
    0,
  );
  logger.info({ shapes: suburbs.length, vertices: suburbVertices }, 'suburb lookup baked');

  const out = {
    generatedAt: new Date().toISOString(),
    bbox: [minLon, minLat, maxLon, maxLat],
    layers,
    suburbs,
  };

  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../frontend/src/lib/udfMapData.json',
  );
  await mkdir(dirname(target), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(target, `${json}\n`, 'utf8');

  logger.info(
    {
      target,
      kb: Math.round(json.length / 1024),
      vertices: vertices + suburbVertices,
      bbox: out.bbox.map((n) => Number(n.toFixed(4))),
    },
    'static map asset written',
  );
}

main()
  .catch((err) => {
    logger.error({ err }, 'map export failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
