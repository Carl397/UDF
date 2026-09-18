-- ============================================================
-- 022_id_card_studio.sql — Party ID Card Studio (national-admin card designer).
--
-- Turns the party ID card from a hardcoded layout into an admin-designed
-- template. Today `IdCardSheet.tsx` fixes the size, colours, wording, field
-- order, border and QR position in source, and the card carries no photo; the
-- only branding knob is the `PARTY_PROFILE` const in `public/content.ts`. This
-- migration adds the storage a national administrator needs to design the card
-- in CRM → Settings → ID Card Studio and print it in production runs, without a
-- redeploy — the same "config takes effect immediately" discipline as the Ward
-- Jobs admin surface (008) and the module registry (016).
--
-- Three additions:
--   id_card_design      ONE global template row (`id = 'default'`) holding the
--                       full design as JSONB: size + scale (up to 1000%),
--                       colours, border, editable branding text, logo, the field
--                       list/order/visibility, photo + QR placement, and the
--                       batch-print sheet setup. The shape is validated (and
--                       default-filled) in `cardstudio/schemas.ts`, so the row is
--                       always a complete, known-good document; an absent row
--                       means "use the code default" (the card as it looks today).
--   member_card_photos  An optional per-member photo for the card, pointing at a
--                       `media_assets` row (the existing hashed-upload store the
--                       CRM avatar editor already uses) plus a crop/zoom
--                       transform so the face can be framed on the card without
--                       re-encoding the source image.
--   feature_flags       Kill-switches for the studio surfaces, mirroring the
--                       jobs.* flags: the designer, batch printing and the card
--                       photo. Off degrades gracefully to the classic card.
--
-- The card RENDER stays gated exactly as before (`requireModule(id_cards)` +
-- `member:read`); the DESIGNER is gated on `module:manage` (national admin), the
-- same permission that guards the module registry. `id_cards` still owns no
-- permission, so the RBAC matrix and `check-caps` invariants are untouched.
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- The global card template ----------
CREATE TABLE IF NOT EXISTS id_card_design (
  id          TEXT PRIMARY KEY,                 -- 'default' (a single global template)
  config      JSONB NOT NULL,                   -- the full CardDesign document
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Optional per-member card photo (crop/zoom) ----------
CREATE TABLE IF NOT EXISTS member_card_photos (
  member_id   UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  media_id    UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  -- Normalised crop rect + zoom the card uses to frame the face:
  --   { "x":0.1,"y":0.05,"w":0.8,"h":0.9,"zoom":1.15 }  (x/y/w/h in 0..1 of the
  --   source; zoom >= 1 scales within the crop). Empty {} = use the whole image.
  transform   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_card_photos_media_idx ON member_card_photos (media_id);

-- ---------- Studio kill-switches (mirror the jobs.* flag discipline) ----------
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('id_cards.designer',   true, 'National-admin ID Card Studio: design the card template (size, layout, colours, text, logo, border, scale) with no redeploy.'),
  ('id_cards.batchPrint', true, 'Multi-select members and batch-print their party ID cards, several per sheet on a chosen paper size.'),
  ('id_cards.photo',      true, 'Optional member photo on the party ID card, uploaded to the media store and framed with crop/zoom.')
ON CONFLICT (key) DO NOTHING;
