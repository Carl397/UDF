-- Make the public marketing site (udf-party.co.za) editable from /crm/website.
--
-- The static pages under `website/` carry `data-cms` hooks that udf-content.js
-- hydrates from these published blocks. Every value below is set to EXACTLY the
-- copy already rendered in the hand-written HTML, so applying this migration is
-- visually lossless: the live page looks identical before and after, and the
-- SuperAdmin editor opens showing the real, current wording. An edit + publish
-- is then the only thing that changes what visitors see.
--
--  * marketing.home       — homepage hero headline/lede + primary CTA. The
--                           mission/vision fields are left as-is: they also feed
--                           GET /api/public/manifesto for the member app.
--  * marketing.housing    — Housing & Infrastructure page hero.
--  * marketing.safety     — Safety & Communities page hero.
--  * marketing.economy    — Economy & Governance page hero.

-- Homepage hero + primary call-to-action (merge, so mission/vision are untouched).
UPDATE content_blocks
SET
  published = COALESCE(published, '{}'::jsonb) || $$
  {
    "heroTitle":    "A community-centric plan for Cape Town's future",
    "heroSubtitle": "As a non-racial, non-sexist and all-inclusive party, we believe every decision must be community-centric and evidence-based, addressing root causes, redressing historical injustices, and creating meaningful improvements in the social, political and economic conditions of all.",
    "ctaLabel":     "Read the manifesto",
    "ctaHref":      "housing-infrastructure.html"
  }
  $$::jsonb,
  draft = draft || $$
  {
    "heroTitle":    "A community-centric plan for Cape Town's future",
    "heroSubtitle": "As a non-racial, non-sexist and all-inclusive party, we believe every decision must be community-centric and evidence-based, addressing root causes, redressing historical injustices, and creating meaningful improvements in the social, political and economic conditions of all.",
    "ctaLabel":     "Read the manifesto",
    "ctaHref":      "housing-infrastructure.html"
  }
  $$::jsonb,
  version = version + 1,
  published_at = now()
WHERE key = 'marketing.home';

INSERT INTO content_block_versions (key, version, payload)
SELECT key, version, published FROM content_blocks WHERE key = 'marketing.home'
ON CONFLICT (key, version) DO NOTHING;

-- Policy-page hero blocks (one per pillar page).
INSERT INTO content_blocks (key, site, title, schema, draft, published, version, published_at)
VALUES
  (
    'marketing.housing',
    'marketing',
    'Marketing: Housing & Infrastructure hero',
    '{
       "heroKicker": {"label":"Kicker","type":"text","maxLength":60},
       "heroTitle":  {"label":"Page headline","type":"text","maxLength":120},
       "heroLede":   {"label":"Intro paragraph","type":"textarea","maxLength":600}
     }'::jsonb,
    $$
    {
      "heroKicker": "Pillars 01 & 02",
      "heroTitle":  "Housing & public infrastructure",
      "heroLede":   "Housing is a means of giving back dignity, a tool for community-based economic growth, skills development and an ultimate vehicle for social change. Infrastructure must be governed as a public good, not a commercial commodity."
    }
    $$::jsonb,
    NULL, 0, NULL
  ),
  (
    'marketing.safety',
    'marketing',
    'Marketing: Safety & Communities hero',
    '{
       "heroKicker": {"label":"Kicker","type":"text","maxLength":60},
       "heroTitle":  {"label":"Page headline","type":"text","maxLength":120},
       "heroLede":   {"label":"Intro paragraph","type":"textarea","maxLength":600}
     }'::jsonb,
    $$
    {
      "heroKicker": "Pillars 03 & 07",
      "heroTitle":  "Safety, healing & community partnership",
      "heroLede":   "Crime prevention and community safety cannot succeed through enforcement alone. Sustainable safety requires collaboration, early intervention, social support and transparent policing practices. Our approach is five-pronged, supported by an overarching commitment to evidence-based budgeting and intersectoral coordination."
    }
    $$::jsonb,
    NULL, 0, NULL
  ),
  (
    'marketing.economy',
    'marketing',
    'Marketing: Economy & Governance hero',
    '{
       "heroKicker": {"label":"Kicker","type":"text","maxLength":60},
       "heroTitle":  {"label":"Page headline","type":"text","maxLength":120},
       "heroLede":   {"label":"Intro paragraph","type":"textarea","maxLength":600}
     }'::jsonb,
    $$
    {
      "heroKicker": "Pillars 04, 05 & 06",
      "heroTitle":  "Economic empowerment, fair finance & accountable councillors",
      "heroLede":   "A fundamental shift from elite shareholding to broad-based worker ownership, community empowerment and regionally fair employment equity, backed by a balanced municipal finance model and enforceable performance agreements for every councillor."
    }
    $$::jsonb,
    NULL, 0, NULL
  )
ON CONFLICT (key) DO NOTHING;

-- Publish the seeded heroes (published = draft, version 1) and snapshot them,
-- exactly as a real editor publish would have produced.
UPDATE content_blocks
SET published = draft, version = 1, published_at = now()
WHERE key IN ('marketing.housing', 'marketing.safety', 'marketing.economy')
  AND published IS NULL;

INSERT INTO content_block_versions (key, version, payload)
SELECT key, 1, published FROM content_blocks
WHERE key IN ('marketing.housing', 'marketing.safety', 'marketing.economy')
ON CONFLICT (key, version) DO NOTHING;
