CREATE TABLE IF NOT EXISTS telegram_accounts (
  subject TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_sessions_expiry ON telegram_sessions(expires_at);
CREATE TABLE IF NOT EXISTS telegram_challenges (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_challenges_expiry ON telegram_challenges(expires_at);
