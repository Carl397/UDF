-- ============================================================
-- 005_cape_town_subcouncils_6_to_20.sql
--
-- Cape Town has 20 subcouncils (the initial migration only
-- created 1–5).  Add the remaining 15.
-- ============================================================

INSERT INTO regions (code, name, parent_code, level)
SELECT
  'CPT-SC' || n,
  'Subcouncil ' || n,
  'CPT',
  'subcouncil'
FROM generate_series(6, 20) AS n
ON CONFLICT (code) DO UPDATE SET name = 'Subcouncil ' || excluded.name;
