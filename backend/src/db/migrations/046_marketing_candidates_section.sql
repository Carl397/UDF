-- Editable heading for the homepage's "Meet our ward councillors" grid.
--
-- The PEOPLE in that grid are rows in `ward_candidates` (migration 045), managed
-- on /crm/candidates; only the section's wording lives in the CMS, so an author
-- can retitle the section without touching the roster. As with migration 044,
-- the published values below are EXACTLY the copy already hand-written in
-- website/index.html, so this migration is visually lossless — and the static
-- HTML stays the no-JS / CMS-down fallback.

INSERT INTO content_blocks (key, site, title, schema, draft, published, version, published_at)
VALUES (
  'marketing.candidates',
  'marketing',
  'Marketing: Ward councillors section',
  '{
     "sectionKicker": {"label":"Kicker","type":"text","maxLength":60},
     "sectionTitle":  {"label":"Section headline","type":"text","maxLength":120},
     "sectionLede":   {"label":"Intro paragraph","type":"textarea","maxLength":600}
   }'::jsonb,
  $$
  {
    "sectionKicker": "Ward councillors",
    "sectionTitle":  "Meet our ward councillors",
    "sectionLede":   "The candidates standing for the United Democratic Front Party across Cape Town wards at Local Government 2026 — listed in party-list order, with the wards each is accountable for."
  }
  $$::jsonb,
  NULL, 0, NULL
)
ON CONFLICT (key) DO NOTHING;

-- Publish the seeded copy (published = draft, version 1) and snapshot it, exactly
-- as a real editor publish would have produced.
UPDATE content_blocks
SET published = draft, version = 1, published_at = now()
WHERE key = 'marketing.candidates'
  AND published IS NULL;

INSERT INTO content_block_versions (key, version, payload)
SELECT key, 1, published FROM content_blocks WHERE key = 'marketing.candidates'
ON CONFLICT (key, version) DO NOTHING;
