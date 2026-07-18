CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name VARCHAR(80) PRIMARY KEY,
  status VARCHAR(30) NOT NULL,
  details JSONB,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  event_key VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'processing',
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS webhook_events_status_idx
  ON webhook_events (provider, status, updated_at);
