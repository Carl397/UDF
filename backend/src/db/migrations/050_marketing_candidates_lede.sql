-- Homepage "Meet our ward councillors" lede: drop the "— listed in party-list
-- order, with the wards each is accountable for" clause. After 048/049 the cards
-- show only names (no party-list number, no ward line), so the intro must no
-- longer promise party-list order or per-ward accountability.
--
-- Edits the CMS block seeded in 046 the way an editor publish would: rewrite the
-- sectionLede in both draft and published, bump the version, and snapshot it.
-- jsonb_set touches only sectionLede, leaving kicker/title intact. The matching
-- static fallback in website/index.html is updated to the same wording.
--
-- Idempotent: re-running rewrites to the same text; the version snapshot is
-- guarded by ON CONFLICT.
UPDATE content_blocks
SET draft = jsonb_set(
      COALESCE(draft, published),
      '{sectionLede}',
      '"The candidates standing for the United Democratic Front Party across Cape Town wards at Local Government 2026."'::jsonb,
      true),
    published = jsonb_set(
      published,
      '{sectionLede}',
      '"The candidates standing for the United Democratic Front Party across Cape Town wards at Local Government 2026."'::jsonb,
      true),
    version = version + 1,
    published_at = now()
WHERE key = 'marketing.candidates'
  AND published ->> 'sectionLede' <> 'The candidates standing for the United Democratic Front Party across Cape Town wards at Local Government 2026.';

INSERT INTO content_block_versions (key, version, payload)
SELECT key, version, published FROM content_blocks WHERE key = 'marketing.candidates'
ON CONFLICT (key, version) DO NOTHING;
