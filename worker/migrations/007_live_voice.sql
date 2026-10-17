CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_hash TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reserved INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ticket_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  chat_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_sessions_owner ON live_sessions(user_id, status);
