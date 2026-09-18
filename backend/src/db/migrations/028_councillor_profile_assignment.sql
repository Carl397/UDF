-- Only managed profiles carry a user link; curated profiles are left intact.
ALTER TABLE leaders ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS leaders_user_idx ON leaders(user_id);

-- Retire a managed public assignment immediately, even for non-CRM user updates.
CREATE OR REPLACE FUNCTION retire_councillor_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.ward_code IS DISTINCT FROM OLD.ward_code
     OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    UPDATE leaders SET is_public = false, updated_at = now() WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS retire_councillor_profile ON users;
CREATE TRIGGER retire_councillor_profile AFTER UPDATE OF role, ward_code, is_active ON users
FOR EACH ROW EXECUTE FUNCTION retire_councillor_profile();
