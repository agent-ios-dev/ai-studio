CREATE TABLE IF NOT EXISTS token_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,
  reserved_until INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
UPDATE settings SET daily_limit = 50000 WHERE id = 1;
