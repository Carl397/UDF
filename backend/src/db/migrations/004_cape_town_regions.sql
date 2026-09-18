-- ============================================================
-- 004_cape_town_regions.sql — City of Cape Town region hierarchy
--
-- Creates the municipality node, 5 subcouncils with approximate
-- boundaries, and 118 ward slots (boundaries populated by the
-- seedCapeTown.ts import from the official ArcGIS service).
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Municipality ----------
INSERT INTO regions (code, name, parent_code, level)
VALUES ('CPT', 'City of Cape Town', NULL, 'municipality')
ON CONFLICT (code) DO UPDATE SET name = 'City of Cape Town';

-- ---------- Sub-councils (approximate polygons) ----------
-- Subcouncil 1: City Bowl, Atlantic Seaboard, Southern Suburbs
INSERT INTO regions (code, name, parent_code, level, geom)
VALUES (
  'CPT-SC1', 'Subcouncil 1', 'CPT', 'subcouncil',
  ST_SetSRID(ST_Multi(ST_MakeEnvelope(18.35, -34.08, 18.50, -33.88, 4326)), 4326)
)
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil 1', parent_code = 'CPT';

-- Subcouncil 2: South Peninsula
INSERT INTO regions (code, name, parent_code, level, geom)
VALUES (
  'CPT-SC2', 'Subcouncil 2', 'CPT', 'subcouncil',
  ST_SetSRID(ST_Multi(ST_MakeEnvelope(18.33, -34.36, 18.52, -34.02, 4326)), 4326)
)
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil 2', parent_code = 'CPT';

-- Subcouncil 3: Khayelitsha, Mitchells Plain, Eastern areas
INSERT INTO regions (code, name, parent_code, level, geom)
VALUES (
  'CPT-SC3', 'Subcouncil 3', 'CPT', 'subcouncil',
  ST_SetSRID(ST_Multi(ST_MakeEnvelope(18.55, -34.15, 19.00, -33.80, 4326)), 4326)
)
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil 3', parent_code = 'CPT';

-- Subcouncil 4: Blaauwberg, Northern Suburbs
INSERT INTO regions (code, name, parent_code, level, geom)
VALUES (
  'CPT-SC4', 'Subcouncil 4', 'CPT', 'subcouncil',
  ST_SetSRID(ST_Multi(ST_MakeEnvelope(18.45, -33.92, 18.80, -33.48, 4326)), 4326)
)
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil 4', parent_code = 'CPT';

-- Subcouncil 5: Tygerberg, Northern/Eastern Suburbs
INSERT INTO regions (code, name, parent_code, level, geom)
VALUES (
  'CPT-SC5', 'Subcouncil 5', 'CPT', 'subcouncil',
  ST_SetSRID(ST_Multi(ST_MakeEnvelope(18.50, -34.00, 18.80, -33.78, 4326)), 4326)
)
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil 5', parent_code = 'CPT';

-- ---------- Ward slots (118 wards — boundaries populated by import) ----------
INSERT INTO regions (code, name, parent_code, level)
SELECT
  'CPT-W' || lpad(n::text, 3, '0'),
  'Ward ' || n,
  'CPT',
  'ward'
FROM generate_series(1, 118) AS n
ON CONFLICT (code) DO UPDATE SET name = 'Ward ' || excluded.name;
