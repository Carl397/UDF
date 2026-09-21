-- Seed the initial structured content blocks (SuperAdmin website editor).
--
-- These mirror the copy currently hard-coded in `modules/public/content.ts` and
-- the app-landing page, so the editor starts from the real published wording and
-- the public hydration API has content on day one. Each block ships WITH a
-- published payload (published = draft, version = 1) and a matching v1 snapshot,
-- exactly as a real publish would have produced.
--
-- `schema` describes the fields the editor renders: label, control type, and an
-- optional max length. The public API serves only `published`.
INSERT INTO content_blocks (key, site, title, schema, draft, published, version, published_at)
VALUES
  (
    'shared.brand',
    'shared',
    'Brand & contact',
    '{
       "name":     {"label":"Short name","type":"text","maxLength":40},
       "fullName": {"label":"Full name","type":"text","maxLength":80},
       "tagline":  {"label":"Tagline","type":"text","maxLength":80},
       "slogan":   {"label":"Slogan","type":"text","maxLength":80},
       "email":    {"label":"Contact email","type":"text","maxLength":120},
       "website":  {"label":"Website","type":"url"},
       "address":  {"label":"Postal address","type":"textarea","maxLength":240}
     }'::jsonb,
    '{
       "name":"UDF","fullName":"United Democratic Front","tagline":"One flag · One movement",
       "slogan":"Service before self","email":"info@udf-party.co.za",
       "website":"https://www.udf-party.co.za","address":"UDF National Secretariat"
     }'::jsonb,
    '{
       "name":"UDF","fullName":"United Democratic Front","tagline":"One flag · One movement",
       "slogan":"Service before self","email":"info@udf-party.co.za",
       "website":"https://www.udf-party.co.za","address":"UDF National Secretariat"
     }'::jsonb,
    1, now()
  ),
  (
    'marketing.home',
    'marketing',
    'Marketing homepage',
    '{
       "heroTitle":    {"label":"Hero headline","type":"text","maxLength":120},
       "heroSubtitle": {"label":"Hero sub-headline","type":"textarea","maxLength":320},
       "ctaLabel":     {"label":"Primary button label","type":"text","maxLength":40},
       "ctaHref":      {"label":"Primary button link","type":"text","maxLength":160},
       "mission":      {"label":"Mission","type":"textarea","maxLength":600},
       "vision":       {"label":"Vision","type":"textarea","maxLength":600}
     }'::jsonb,
    '{
       "heroTitle":"Service before self",
       "heroSubtitle":"A ward-first movement holding every representative answerable to the people who elected them.",
       "ctaLabel":"Join the UDF","ctaHref":"/register",
       "mission":"To organise ordinary people in every ward so that public power is used to deliver dignified services, honest work and safe neighbourhoods.",
       "vision":"A country where the queue at the clinic is short, the tap runs, the classroom has a teacher, and any citizen can reach their representative in one phone call."
     }'::jsonb,
    '{
       "heroTitle":"Service before self",
       "heroSubtitle":"A ward-first movement holding every representative answerable to the people who elected them.",
       "ctaLabel":"Join the UDF","ctaHref":"/register",
       "mission":"To organise ordinary people in every ward so that public power is used to deliver dignified services, honest work and safe neighbourhoods.",
       "vision":"A country where the queue at the clinic is short, the tap runs, the classroom has a teacher, and any citizen can reach their representative in one phone call."
     }'::jsonb,
    1, now()
  ),
  (
    'app.landing',
    'app',
    'App download landing page',
    '{
       "title":      {"label":"Page title","type":"text","maxLength":80},
       "subtitle":   {"label":"Subtitle","type":"textarea","maxLength":320},
       "ctaLabel":   {"label":"Download button label","type":"text","maxLength":40},
       "badgeCount": {"label":"Stat badge (e.g. members)","type":"text","maxLength":40},
       "badgeLabel": {"label":"Stat badge label","type":"text","maxLength":60}
     }'::jsonb,
    '{
       "title":"Get the UDF app",
       "subtitle":"Report issues, attend events and hold your councillor to account — from your pocket.",
       "ctaLabel":"Download for Android","badgeCount":"1","badgeLabel":"wards organised"
     }'::jsonb,
    '{
       "title":"Get the UDF app",
       "subtitle":"Report issues, attend events and hold your councillor to account — from your pocket.",
       "ctaLabel":"Download for Android","badgeCount":"1","badgeLabel":"wards organised"
     }'::jsonb,
    1, now()
  )
ON CONFLICT (key) DO NOTHING;

-- Snapshot the seeded payloads as version 1 so the rollback history is complete.
INSERT INTO content_block_versions (key, version, payload)
SELECT key, 1, published FROM content_blocks
ON CONFLICT (key, version) DO NOTHING;
