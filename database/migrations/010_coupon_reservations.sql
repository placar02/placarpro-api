CREATE TABLE IF NOT EXISTS coupon_reservations (
  id BIGSERIAL PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'redeemed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS coupon_reservations_capacity_idx
  ON coupon_reservations(coupon_id, status, expires_at);
