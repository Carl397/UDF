import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';
import { migrate } from './migrate.js';
import { logger } from '../config/logger.js';

/**
 * Imports official City of Cape Town ward, subcouncil & suburb boundaries
 * from the City's ArcGIS REST service into the regions table.
 *
 * Source: City of Cape Town — Political_Administrative_Boundaries
 * Layers: 4 = Official Suburbs, 6 = Subcouncils, 7 = Wards
 *
 * Run with: npm run seed:cpt
 */

const ARCGIS_BASE =
  'https://citymaps.capetown.gov.za/agsext/rest/services/Theme_Based/Political_Administrative_Boundaries/MapServer';

const SUBURB_LAYER = 4;
const SUBCOUNCIL_LAYER = 6;
const WARD_LAYER = 7;

// ── helpers ──────────────────────────────────────────────────

interface GeoJSONFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

interface GeoJSONResponse {
  features: GeoJSONFeature[];
  exceededTransferLimit?: boolean;
}

/** Convert a GeoJSON coordinate ring to PostGIS WKT (lon lat order). */
function ringToWkt(ring: number[][]): string {
  return ring.map(([x, y]) => `${x} ${y}`).join(', ');
}

/**
 * Fetch all features from an ArcGIS MapServer layer, handling pagination.
 * Uses f=geojson for standard GeoJSON output.
 */
async function fetchLayer(layerId: number): Promise<GeoJSONFeature[]> {
  const allFeatures: GeoJSONFeature[] = [];
  let offset = 0;
  const limit = 2000; // MaxRecordCount

  while (true) {
    const url =
      `${ARCGIS_BASE}/${layerId}/query?` +
      `where=1%3D1&outFields=*&f=geojson&resultOffset=${offset}&resultRecordCount=${limit}`;

    logger.info({ layerId, offset }, 'Fetching ArcGIS layer…');
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ArcGIS query failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GeoJSONResponse;
    if (!data.features || data.features.length === 0) break;

    allFeatures.push(...data.features);
    offset += data.features.length;
    if (data.features.length < limit && !data.exceededTransferLimit) break;
  }

  logger.info({ layerId, count: allFeatures.length }, 'Fetched features from ArcGIS');
  return allFeatures;
}

/**
 * Convert GeoJSON polygon geometry to PostGIS WKT.
 */
function geojsonToWkt(geometry: any): string {
  // Standard GeoJSON Polygon
  if (geometry.type === 'Polygon' && geometry.coordinates) {
    // GeoJSON Polygon coordinates: number[][][] (array of rings)
    const coords = geometry.coordinates as number[][][];
    const polygons = coords.map((ring: number[][]) => {
      const wkt = ring.map(([x, y]) => `${x} ${y}`).join(', ');
      return `((${wkt}))`;
    });
    return `MULTIPOLYGON(${polygons.join(',')})`;
  }

  if (geometry.type === 'MultiPolygon' && geometry.coordinates) {
    // GeoJSON MultiPolygon coordinates: number[][][][]
    const coords = geometry.coordinates as number[][][][];
    const polygons = coords.map((polygon: number[][][]) => {
      const rings = polygon.map((ring: number[][]) => {
        const wkt = ring.map(([x, y]) => `${x} ${y}`).join(', ');
        return `(${wkt})`;
      });
      return `(${rings.join(',')})`;
    });
    return `MULTIPOLYGON(${polygons.join(',')})`;
  }

  return '';
}

// ── main import ──────────────────────────────────────────────

async function importCapeTown(): Promise<void> {
  logger.info('Starting Cape Town boundary import…');

  // Ensure migration 004 has created the region hierarchy
  await migrate();

  // ── 1. Import subcouncil boundaries ──
  const subcouncils = await fetchLayer(SUBCOUNCIL_LAYER);
  let scUpdated = 0;

  for (const f of subcouncils) {
    const name = String(f.properties['SUB_CNCL_NAME'] ?? '');
    const num = Number(f.properties['SUB_CNCL_NMBR'] ?? 0);
    const code = `CPT-SC${num}`;
    const wkt = geojsonToWkt(f.geometry);

    if (!wkt) {
      logger.warn({ name, num }, 'Subcouncil has no geometry — skipping');
      continue;
    }

    await query(
      `UPDATE regions
       SET name = $2, geom = ST_SetSRID(ST_GeomFromText($3, 4326), 4326)
       WHERE code = $1`,
      [code, name, wkt],
    );
    scUpdated++;
  }
  logger.info({ count: scUpdated }, 'Subcouncil boundaries updated');

  // ── 2. Import ward boundaries ──
  const wards = await fetchLayer(WARD_LAYER);
  let wardUpdated = 0;

  for (const f of wards) {
    const wardName = String(f.properties['WARD_NAME'] ?? '');
    // Extract ward number from name (e.g., "Ward 1" → 1)
    const match = wardName.match(/(\d+)/);
    if (!match) {
      logger.warn({ wardName }, 'Could not parse ward number — skipping');
      continue;
    }
    const wardNum = parseInt(match[1]!, 10);
    const code = `CPT-W${String(wardNum).padStart(3, '0')}`;
    const wkt = geojsonToWkt(f.geometry as any);

    if (!wkt) {
      logger.warn({ wardName, code }, 'Ward has no geometry — skipping');
      continue;
    }

    await query(
      `UPDATE regions
       SET name = $2, geom = ST_SetSRID(ST_GeomFromText($3, 4326), 4326)
       WHERE code = $1`,
      [code, wardName, wkt],
    );
    wardUpdated++;
  }
  logger.info({ count: wardUpdated }, 'Ward boundaries updated');

  // ── 3. Assign wards to subcouncils based on centroid location ──
  // Uses the official subcouncil geometries to determine which subcouncil
  // each ward belongs to.
  await query(`
    UPDATE regions w
    SET parent_code = sc.code
    FROM regions sc
    WHERE w.level = 'ward'
      AND w.code LIKE 'CPT-W%'
      AND sc.level = 'subcouncil'
      AND sc.geom IS NOT NULL
      AND w.geom IS NOT NULL
      AND ST_Contains(sc.geom, ST_Centroid(w.geom))
  `);
  logger.info('Wards assigned to subcouncils by centroid containment');

  // Any wards not assigned (e.g., on boundaries) — assign by nearest subcouncil
  await query(`
    UPDATE regions w
    SET parent_code = nearest.code
    FROM (
      SELECT DISTINCT ON (w2.code)
        w2.code AS ward_code,
        sc.code
      FROM regions w2
      CROSS JOIN LATERAL (
        SELECT sc2.code, ST_Distance(w2.geom, sc2.geom) AS dist
        FROM regions sc2
        WHERE sc2.level = 'subcouncil' AND sc2.geom IS NOT NULL
        ORDER BY dist
        LIMIT 1
      ) sc
      WHERE w2.level = 'ward'
        AND w2.code LIKE 'CPT-W%'
        AND w2.parent_code = 'CPT'
        AND w2.geom IS NOT NULL
    ) nearest
    WHERE w.code = nearest.ward_code
  `);

  // ── 4. Import official suburbs and assign to wards by centroid ──
  const suburbs = await fetchLayer(SUBURB_LAYER);
  let subInserted = 0;

  for (const f of suburbs) {
    const name = String(f.properties['OFC_SBRB_NAME'] ?? '').trim();
    if (!name) continue;
    // Deterministic code from the name: CPT-HYDE-PARK, CPT-SUN-VALLEY, etc.
    const code = 'CPT-' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const wkt = geojsonToWkt(f.geometry as any);

    await query(
      `INSERT INTO regions (code, name, level, parent_code, geom)
       VALUES ($1, $2, 'suburb', NULL, ${wkt ? `ST_SetSRID(ST_GeomFromText($3, 4326), 4326)` : 'NULL'})
       ON CONFLICT (code) DO UPDATE SET name = $2, level = 'suburb'
         ${wkt ? ', geom = ST_SetSRID(ST_GeomFromText($3, 4326), 4326)' : ''}`,
      wkt ? [code, name, wkt] : [code, name],
    );
    subInserted++;
  }
  logger.info({ count: subInserted }, 'Suburbs inserted/updated');

  // Assign suburbs to wards by centroid containment.
  await query(`
    UPDATE regions s
    SET parent_code = w.code
    FROM regions w
    WHERE s.level = 'suburb'
      AND s.code LIKE 'CPT-%'
      AND w.level = 'ward'
      AND w.geom IS NOT NULL
      AND s.geom IS NOT NULL
      AND ST_Contains(w.geom, ST_Centroid(s.geom))
  `);

  // Fallback: suburbs not matched (centroid on a boundary) → nearest ward.
  await query(`
    UPDATE regions s
    SET parent_code = nearest.code
    FROM (
      SELECT DISTINCT ON (s2.code)
        s2.code AS suburb_code,
        w.code
      FROM regions s2
      CROSS JOIN LATERAL (
        SELECT w2.code, ST_Distance(s2.geom, w2.geom) AS dist
        FROM regions w2
        WHERE w2.level = 'ward' AND w2.geom IS NOT NULL
        ORDER BY dist
        LIMIT 1
      ) w
      WHERE s2.level = 'suburb'
        AND s2.parent_code IS NULL
        AND s2.geom IS NOT NULL
    ) nearest
    WHERE s.code = nearest.suburb_code
  `);

  const assigned = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM regions WHERE level = 'suburb' AND parent_code IS NOT NULL`,
  );
  logger.info({ assigned: assigned.rows[0]?.n }, 'Suburbs assigned to wards');

  logger.info('Cape Town boundary import complete');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  importCapeTown()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'Cape Town import failed');
      process.exit(1);
    });
}

export { importCapeTown };
