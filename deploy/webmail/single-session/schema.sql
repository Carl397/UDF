-- One authorized webmail session per Roundcube user; no raw session tokens.
CREATE TABLE IF NOT EXISTS udf_session_policy (
    user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
    expires_at INTEGER NOT NULL
);
