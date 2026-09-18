-- ============================================================
-- 024_region_geometry_dissolve.sql — geometry for the upper map layers
--
-- The static UDF map draws three layers: region, subcouncil, ward.
-- Only the lower two ever had shapes: subcouncils and wards were imported
-- with polygons, while the 5 `region` rows and the `municipality` root were
-- created as hierarchy-only nodes (parents for scoping) and carry geom NULL.
-- Selecting level='region' therefore returned an empty FeatureCollection and
-- the top layer of the map had nothing to render.
--
-- Rather than import an outline from anywhere, each upper shape is DISSOLVED
-- from the children already in this table: a region is exactly the union of
-- its subcouncils, and the municipality is exactly the union of its regions.
-- No external data source is involved, and the layers nest perfectly by
-- construction — a dissolved parent can never disagree with its children
-- about where the shared border runs, which an independently-sourced outline
-- routinely does (slivers and gaps along every seam).
--
-- ST_Buffer(…, 0) before the union repairs the self-intersections that the
-- source polygons carry; ST_Union on invalid input raises rather than
-- returning a best effort. ST_Multi keeps the column's MultiPolygon type,
-- since dissolving a set of adjacent shapes usually collapses to a single
-- Polygon that would otherwise fail the type constraint.
--
-- Idempotent: recomputed from children on every run, so re-running after a
-- boundary re-import refreshes the parents instead of leaving them stale.
-- Guarded by `WHERE geom IS NOT NULL` on the children so a region whose
-- subcouncils are all unmapped stays NULL rather than becoming an empty shape.
-- ============================================================

-- ---------- Regions: union of their subcouncils ----------
UPDATE regions r
SET geom = sub.geom
FROM (
  SELECT
    c.parent_code AS code,
    ST_Multi(ST_Union(ST_Buffer(c.geom, 0))) AS geom
  FROM regions c
  WHERE c.level = 'subcouncil'
    AND c.geom IS NOT NULL
    AND c.parent_code IS NOT NULL
  GROUP BY c.parent_code
) AS sub
WHERE r.code = sub.code
  AND r.level = 'region';

-- ---------- Municipality: union of its regions ----------
-- Runs second so it consumes the geometry the statement above just wrote.
UPDATE regions r
SET geom = sub.geom
FROM (
  SELECT
    c.parent_code AS code,
    ST_Multi(ST_Union(ST_Buffer(c.geom, 0))) AS geom
  FROM regions c
  WHERE c.level = 'region'
    AND c.geom IS NOT NULL
    AND c.parent_code IS NOT NULL
  GROUP BY c.parent_code
) AS sub
WHERE r.code = sub.code
  AND r.level = 'municipality';
