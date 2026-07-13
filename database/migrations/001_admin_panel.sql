ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE users
SET role = CASE
  WHEN role = 'admin' THEN 'admin'
  WHEN plano = 'premium' THEN 'premium'
  ELSE 'free'
END
WHERE role IS NULL OR role NOT IN ('admin', 'premium', 'free') OR (role = 'free' AND plano = 'premium');

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) UNIQUE NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  description TEXT DEFAULT '',
  benefits JSONB NOT NULL DEFAULT '[]'::jsonb,
  color VARCHAR(20) DEFAULT '#00E676',
  badge VARCHAR(80),
  display_order INTEGER NOT NULL DEFAULT 0,
  billing_period VARCHAR(30) NOT NULL DEFAULT 'monthly',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO plans (name, slug, price_cents, description, benefits, color, badge, display_order, billing_period)
VALUES
  ('Premium Mensal', 'premium-mensal', 2000, 'Acesso premium mensal ao PlacarPro', '["Análises completas", "Entradas premium", "Explicações da IA"]', '#00E676', 'Mensal', 1, 'monthly')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  trial_ends_at TIMESTAMP,
  starts_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);

ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS discount_cents INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code VARCHAR(60) UNIQUE NOT NULL,
  discount_type VARCHAR(20) NOT NULL DEFAULT 'percentage',
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  valid_from TIMESTAMP,
  valid_until TIMESTAMP,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  max_accesses INTEGER NOT NULL DEFAULT 1 CHECK (max_accesses > 0),
  default_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  mercado_pago_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  subscription_status VARCHAR(30) NOT NULL DEFAULT 'active',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  system_name VARCHAR(120) NOT NULL DEFAULT 'PlacarPro',
  logo_url TEXT,
  favicon_url TEXT,
  primary_color VARCHAR(20) NOT NULL DEFAULT '#00E676',
  secondary_color VARCHAR(20) NOT NULL DEFAULT '#1A1A1A',
  contact_email VARCHAR(255),
  contact_phone VARCHAR(60),
  social_links JSONB NOT NULL DEFAULT '{}'::jsonb,
  home_text TEXT,
  user_message TEXT,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  league VARCHAR(160) NOT NULL,
  championship VARCHAR(160),
  market VARCHAR(255) NOT NULL,
  odd NUMERIC(10,2) NOT NULL CHECK (odd > 1),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  ai_analysis TEXT,
  event_time TIMESTAMP,
  image_url TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  publish_at TIMESTAMP,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS entries_status_idx ON entries(status);
CREATE INDEX IF NOT EXISTS entries_publish_at_idx ON entries(publish_at);

CREATE TABLE IF NOT EXISTS news (
  id SERIAL PRIMARY KEY,
  title VARCHAR(220) NOT NULL,
  image_url TEXT,
  content TEXT NOT NULL,
  author VARCHAR(160),
  category VARCHAR(100),
  published BOOLEAN NOT NULL DEFAULT FALSE,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS news_published_idx ON news(published);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(100),
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(100),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id);
