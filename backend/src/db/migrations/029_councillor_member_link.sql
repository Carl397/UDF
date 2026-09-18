-- Repair managed profiles published before member identity was synchronized.
UPDATE leaders l
SET member_id = u.member_id, updated_at = now()
FROM users u
WHERE l.user_id = u.id AND l.member_id IS DISTINCT FROM u.member_id;
