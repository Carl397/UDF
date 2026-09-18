-- ============================================================
-- 020_member_onboarding_otp.sql — Member onboarding (PRD-growth FR-P/FR-Q, Wave 5 Phase B).
--
-- A self-registered member gets a `members` row but — until now — NO `users`
-- row, so they could never sign in (PRD §3.1). This migration adds the schema
-- that lets registration provision a login account, onboard it with an emailed
-- one-time PIN used as the FIRST password, and force a private password before
-- the app unlocks:
--
--   users.member_id   explicit member ↔ user link (replaces the `created_by`-only
--                     guess the jobs/recruitment modules had to fall back on).
--   email_otps        6-digit codes, hashed at rest (argon2id, same as passwords),
--                     short TTL, attempt-capped, consumed on success/expiry.
--   email_outbox      delivery state + retry for the starter-pack email. INTERNAL:
--                     no API ever returns it (mirrors job_relay_outbox discipline).
--                     Stores a blind index of the recipient, never the address.
--
-- Provisioning itself (creating the `users` row, sealing its PII, hashing a
-- random initial password, issuing the OTP) is APPLICATION-side — it needs the
-- envelope crypto + blind index that SQL cannot run — so it lives in
-- modules/onboarding/service.ts and is triggered by registration/confirmation.
-- Backfilling accounts for EXISTING members is the idempotent
-- scripts/provision-members.ts, not a SQL UPDATE here.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- Explicit member ↔ user link (FR-P1) ----------
-- NULL for staff/admin accounts that are not themselves a registered member.
-- UNIQUE so one member can only ever be bound to one login account; ON DELETE
-- SET NULL keeps the account when a member exercises their right to erasure.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS member_id UUID UNIQUE REFERENCES members(id) ON DELETE SET NULL;

-- ---------- One-time PINs (FR-P2 / PRD.md FR-H) ----------
-- Migration 006 provisionally created `email_otps` keyed by `subject_id` with a
-- SHA-256 `code_hash CHAR(64)` for a login/reset/ward-change flow that was never
-- wired to any code path. Phase B consolidates EVERY OTP purpose onto this one
-- store, keyed by `user_id` (FK → users) with an argon2id `code_hash TEXT` that
-- matches how passwords are hashed and verified. The provisional table is empty
-- and its SHA-256 digests are unreadable by the argon2 verifier, so it is
-- replaced rather than migrated row-by-row. Guarded on the old `subject_id`
-- column so a re-run against an already-upgraded database is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'email_otps' AND column_name = 'subject_id'
  ) THEN
    DROP TABLE email_otps;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS email_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'onboarding' is the starter-pack first login; the others align with PRD.md
  -- FR-H (password reset) and the transparency ward-change re-verification.
  purpose     TEXT NOT NULL,
  -- argon2id hash of the 6-digit code (a salted hash — a DB leak cannot be
  -- replayed, and the online attempt cap blunts brute force).
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,                 -- set on success OR lock (>= max attempts)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_otps_purpose_chk
    CHECK (purpose IN ('onboarding', 'login', 'password_reset', 'ward_change'))
);
CREATE INDEX IF NOT EXISTS idx_email_otps_user_purpose ON email_otps (user_id, purpose);
-- Housekeeping sweep (purgeExpiredOtps) reaps consumed/expired rows.
CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON email_otps (expires_at);

-- ---------- Email delivery outbox (FR-Q4) — INTERNAL, never exposed ----------
CREATE TABLE IF NOT EXISTS email_outbox (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Blind index of the recipient (HMAC), NOT the address: the address is
  -- resolved transiently at send time and never persisted here (POPIA §7).
  to_bidx    BYTEA,
  template   TEXT NOT NULL,                -- e.g. 'starter_pack', 'otp_resend'
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_status_chk CHECK (status IN ('queued', 'sent', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox (status, created_at);

-- ---------- Kill-switch flags (PRD-growth Appendix C) ----------
-- onboarding.otp gates member→user provisioning + OTP login; onboarding.starterPack
-- gates the welcome email (bio/manifesto/leader). Both default ON; the mailer
-- degrades to outbox capture when SMTP is unset (dev), and production requires a
-- real MAIL_FROM (config/env.ts fail-fast), so enabling these is safe to ship.
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('onboarding.otp',        true, 'Provision a login account for each new member and onboard with an emailed OTP used as the first password (FR-P1/P2/P3).'),
  ('onboarding.starterPack', true, 'Send the starter-pack welcome email (councillor bio + photo, mini-manifesto, party leader, thank-you) on provisioning (FR-Q1).')
ON CONFLICT (key) DO NOTHING;
