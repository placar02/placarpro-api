-- Preserve existing values while replacing floating-point money with exact decimals.
ALTER TABLE users
  ALTER COLUMN banca_inicial TYPE NUMERIC(14, 2) USING ROUND(COALESCE(banca_inicial, 0)::numeric, 2),
  ALTER COLUMN saldo_atual TYPE NUMERIC(14, 2) USING ROUND(COALESCE(saldo_atual, 0)::numeric, 2);

ALTER TABLE bets
  ALTER COLUMN odd TYPE NUMERIC(12, 4) USING ROUND(odd::numeric, 4),
  ALTER COLUMN valor_apostado TYPE NUMERIC(14, 2) USING ROUND(valor_apostado::numeric, 2),
  ALTER COLUMN lucro_prejuizo TYPE NUMERIC(14, 2) USING ROUND(lucro_prejuizo::numeric, 2);

ALTER TABLE bankroll_history
  ALTER COLUMN saldo TYPE NUMERIC(14, 2) USING ROUND(saldo::numeric, 2);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_balances_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_balances_nonnegative
  CHECK (banca_inicial >= 0 AND saldo_atual >= 0);

ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_valid_financial_values;
ALTER TABLE bets ADD CONSTRAINT bets_valid_financial_values
  CHECK (odd > 1 AND valor_apostado > 0 AND resultado IN ('pending', 'green', 'red'));

ALTER TABLE bankroll_history DROP CONSTRAINT IF EXISTS bankroll_history_balance_nonnegative;
ALTER TABLE bankroll_history ADD CONSTRAINT bankroll_history_balance_nonnegative CHECK (saldo >= 0);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_usage_within_limit;
ALTER TABLE coupons ADD CONSTRAINT coupons_usage_within_limit
  CHECK (uses_count >= 0 AND (max_uses IS NULL OR (max_uses >= 0 AND uses_count <= max_uses)));

CREATE INDEX IF NOT EXISTS bets_user_recent_idx ON bets(user_id, id DESC);
CREATE INDEX IF NOT EXISTS bankroll_history_user_idx ON bankroll_history(user_id, id);
CREATE INDEX IF NOT EXISTS payment_sessions_user_external_idx ON payment_sessions(user_id, external_id);
CREATE INDEX IF NOT EXISTS payment_sessions_user_checkout_idx ON payment_sessions(user_id, checkout_id);

CREATE UNIQUE INDEX IF NOT EXISTS bets_one_pending_entry_idx
  ON bets(user_id, event_id, market, recommendation)
  WHERE resultado = 'pending' AND event_id IS NOT NULL AND market IS NOT NULL AND recommendation IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_user_idx
  ON subscriptions(user_id) WHERE status = 'active';
