CREATE TABLE IF NOT EXISTS user_consents (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type VARCHAR(40) NOT NULL,
  policy_version VARCHAR(30) NOT NULL,
  granted BOOLEAN NOT NULL,
  ip_hash CHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS user_consents_user_idx ON user_consents(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_type VARCHAR(20) NOT NULL CHECK (request_type IN ('export', 'deletion')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  details JSONB
);
CREATE INDEX IF NOT EXISTS data_subject_requests_user_idx ON data_subject_requests(user_id, requested_at DESC);

ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS payload_digest CHAR(64);
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS raw_payload_purged_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_recovery_hashes JSONB;
