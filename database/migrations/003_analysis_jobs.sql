CREATE TABLE IF NOT EXISTS analysis_jobs (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  request_type VARCHAR(60) NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'partial', 'completed', 'failed')),
  total_events INTEGER NOT NULL DEFAULT 0 CHECK (total_events >= 0),
  processed_events INTEGER NOT NULL DEFAULT 0 CHECK (processed_events >= 0),
  failed_events INTEGER NOT NULL DEFAULT 0 CHECK (failed_events >= 0),
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  finished_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS analysis_jobs_queue_idx
  ON analysis_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS analysis_jobs_user_idx
  ON analysis_jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS analysis_job_results (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  event_id VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cached')),
  market TEXT,
  confidence REAL,
  analysis JSONB,
  data_profile JSONB,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, event_id)
);

CREATE INDEX IF NOT EXISTS analysis_job_results_job_idx
  ON analysis_job_results(job_id, created_at);

CREATE INDEX IF NOT EXISTS analysis_job_results_cache_idx
  ON analysis_job_results(event_id, updated_at DESC)
  WHERE status IN ('completed', 'cached');
