ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS original_amount INTEGER;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS coupon_redeemed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS access_limit INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS payment_sessions_coupon_idx ON payment_sessions(coupon_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id VARCHAR(80) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id, revoked, expires_at);
