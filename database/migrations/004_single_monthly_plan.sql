INSERT INTO plans (name, slug, price_cents, description, benefits, color, badge, display_order, billing_period, active)
VALUES (
  'Premium Mensal',
  'premium-mensal',
  2000,
  'Acesso premium mensal ao PlacarPro',
  '["Análises completas", "Entradas premium", "Explicações da IA"]'::jsonb,
  '#00E676',
  'Mensal',
  1,
  'monthly',
  TRUE
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  description = EXCLUDED.description,
  benefits = EXCLUDED.benefits,
  color = EXCLUDED.color,
  badge = EXCLUDED.badge,
  display_order = EXCLUDED.display_order,
  billing_period = EXCLUDED.billing_period,
  active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

UPDATE plans
SET active = FALSE,
    updated_at = CURRENT_TIMESTAMP
WHERE slug <> 'premium-mensal';
