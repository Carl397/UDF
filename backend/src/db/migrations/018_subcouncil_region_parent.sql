-- ============================================================
-- 018_subcouncil_region_parent.sql
--
-- Re-parent the 20 Cape Town subcouncils under the 5 planning
-- regions (CENTRAL / EAST / NORTH / SOUTH / WEST) instead of
-- directly under the municipality.  This completes the tree
--   municipality → region → subcouncil → ward
-- so the register form can auto-fill Region when the applicant
-- picks a Ward (ward → subcouncil → region).
--
-- Assignment basis: each subcouncil's ArcGIS centroid (imported
-- by seedCapeTown.ts) falls within the planning-region envelope
-- that the City uses for district administration.  The mapping
-- below was derived from those centroids and verified against
-- the City's own subcouncil profile pages.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- Insert the 5 planning-region nodes if they don't already exist.
-- (Local dev DBs may already have them from seedValidation; production
-- only has the ArcGIS-imported municipality/subcouncil/ward rows.)
INSERT INTO regions (code, name, level, parent_code) VALUES
  ('CENTRAL', 'Central Region',  'region', 'CPT'),
  ('EAST',    'Eastern Region',  'region', 'CPT'),
  ('NORTH',   'Northern Region', 'region', 'CPT'),
  ('SOUTH',   'Southern Region', 'region', 'CPT'),
  ('WEST',    'Western Region',  'region', 'CPT')
ON CONFLICT (code) DO UPDATE SET parent_code = 'CPT'
  WHERE regions.parent_code IS DISTINCT FROM 'CPT';

-- NORTH: Blaauwberg, Tygerberg, Northern Suburbs, Brackenfell
UPDATE regions SET parent_code = 'NORTH'
 WHERE level = 'subcouncil' AND code IN ('CPT-SC1','CPT-SC2','CPT-SC7');

-- CENTRAL: City Bowl, Southern Suburbs, Cape Flats central
UPDATE regions SET parent_code = 'CENTRAL'
 WHERE level = 'subcouncil' AND code IN ('CPT-SC3','CPT-SC4','CPT-SC5','CPT-SC6','CPT-SC11','CPT-SC13','CPT-SC15');

-- WEST: Atlantic Seaboard, Hout Bay, West Coast
UPDATE regions SET parent_code = 'WEST'
 WHERE level = 'subcouncil' AND code IN ('CPT-SC16','CPT-SC20');

-- SOUTH: South Peninsula, Constantia, Tokai
UPDATE regions SET parent_code = 'SOUTH'
 WHERE level = 'subcouncil' AND code IN ('CPT-SC18','CPT-SC19');

-- EAST: Khayelitsha, Mitchells Plain, Eastridge, Elsies River
UPDATE regions SET parent_code = 'EAST'
 WHERE level = 'subcouncil' AND code IN ('CPT-SC8','CPT-SC9','CPT-SC10','CPT-SC12','CPT-SC14','CPT-SC17');
