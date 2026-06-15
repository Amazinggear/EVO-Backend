-- ================================================
-- EVO Database Migrations v2
-- Run AFTER migrations.sql (v1)
-- Updates for new financial architecture:
--   - 5 car types (ev_mini, ev_taxi, ev_sedan, ev_suv, ev_luxury)
--   - Prepaid wallet (admin recharges, commission deduction 13%)
--   - CliQ alias mandatory for drivers
--   - EV TAXI metered tariffs (day/night)
--   - Remove payment_cards table
--   - Remove bank_iban/bank_name from driver_profiles
-- ================================================

-- ================================================
-- M01: Update driver_profiles
--   - New car_type ENUM (5 types)
--   - Add cliq_alias (mandatory)
--   - Add wallet fields (prepaid)
--   - Remove bank fields
-- ================================================

-- Alter car_type CHECK constraint
ALTER TABLE driver_profiles
  DROP CONSTRAINT IF EXISTS driver_profiles_car_type_check;

ALTER TABLE driver_profiles
  ADD CONSTRAINT driver_profiles_car_type_check
  CHECK (car_type IN ('ev_mini', 'ev_taxi', 'ev_sedan', 'ev_suv', 'ev_luxury'));

-- Add CliQ alias (mandatory)
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS cliq_alias VARCHAR(50);

-- Add wallet balance fields (prepaid system)
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_recharged DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_commission_paid DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- Remove old bank fields (no longer needed)
ALTER TABLE driver_profiles
  DROP COLUMN IF EXISTS bank_name,
  DROP COLUMN IF EXISTS bank_iban,
  DROP COLUMN IF EXISTS bank_account_holder;

-- ================================================
-- M02: Update rides table
--   - New car_type ENUM (5 types)
--   - Cash only (no card/payment_reference)
--   - Add commission tracking
--   - Add EV TAXI metered fields
-- ================================================

-- Update car_type CHECK on rides
ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_car_type_check;

ALTER TABLE rides
  ADD CONSTRAINT rides_car_type_check
  CHECK (car_type IN ('ev_mini', 'ev_taxi', 'ev_sedan', 'ev_suv', 'ev_luxury'));

-- Change payment_method to cash-only
ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_payment_method_check;

ALTER TABLE rides
  ALTER COLUMN payment_method SET DEFAULT 'cash';

ALTER TABLE rides
  ADD CONSTRAINT rides_payment_method_check
  CHECK (payment_method IN ('cash'));

-- Drop old payment status fields (cash = always completed on ride completion)
ALTER TABLE rides
  DROP COLUMN IF EXISTS payment_status,
  DROP COLUMN IF EXISTS payment_reference;

-- Add commission tracking
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS commission_deducted BOOLEAN NOT NULL DEFAULT false;

-- Add EV TAXI metered fields
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS tariff_type VARCHAR(10)
    CHECK (tariff_type IN ('day', 'night')),
  ADD COLUMN IF NOT EXISTS waiting_minutes DECIMAL(5,1) DEFAULT 0;

-- ================================================
-- M03: Update transactions table
--   - New types: admin_recharge, commission_deduction only
--   - Add recharged_by (admin reference)
--   - Remove old types
-- ================================================

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('admin_recharge', 'commission_deduction'));

ALTER TABLE transactions
  DROP COLUMN IF EXISTS reference;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS recharged_by UUID REFERENCES users(id);

-- ================================================
-- M04: Drop payment_cards table (no longer needed)
-- ================================================

DROP TABLE IF EXISTS payment_cards;

-- ================================================
-- M05: Update pricing_config
--   - New car types (5)
--   - Unified 13% commission
--   - EV TAXI metered day/night tariffs
--   - Higher precision for rates (3 decimal places)
-- ================================================

-- Drop old pricing
DELETE FROM pricing_config;

-- Alter car_type check
ALTER TABLE pricing_config
  DROP CONSTRAINT IF EXISTS pricing_config_car_type_check;

ALTER TABLE pricing_config
  ADD CONSTRAINT pricing_config_car_type_check
  CHECK (car_type IN ('ev_mini', 'ev_taxi', 'ev_sedan', 'ev_suv', 'ev_luxury'));

-- Add EV TAXI night tariff columns
ALTER TABLE pricing_config
  ADD COLUMN IF NOT EXISTS night_base_fare DECIMAL(6,3),
  ADD COLUMN IF NOT EXISTS night_per_km_rate DECIMAL(4,3),
  ADD COLUMN IF NOT EXISTS night_per_min_rate DECIMAL(4,3),
  ADD COLUMN IF NOT EXISTS day_start_hour INT DEFAULT 6,
  ADD COLUMN IF NOT EXISTS night_start_hour INT DEFAULT 22;

-- Alter column precision for rates
ALTER TABLE pricing_config
  ALTER COLUMN base_fare TYPE DECIMAL(6,3),
  ALTER COLUMN per_km_rate TYPE DECIMAL(4,3),
  ALTER COLUMN per_min_rate TYPE DECIMAL(4,3);

-- Seed new pricing (all 13% commission)
INSERT INTO pricing_config (car_type, base_fare, per_km_rate, per_min_rate, min_fare, commission_pct) VALUES
  ('ev_mini',   0.350, 0.280, 0.030, 1.20, 13.00),
  ('ev_taxi',   0.450, 0.316, 0.060, 1.00, 13.00),
  ('ev_sedan',  0.380, 0.290, 0.030, 1.30, 13.00),
  ('ev_suv',    0.400, 0.340, 0.040, 1.50, 13.00),
  ('ev_luxury', 0.500, 0.450, 0.060, 2.50, 13.00)
ON CONFLICT (car_type) DO UPDATE SET
  base_fare = EXCLUDED.base_fare,
  per_km_rate = EXCLUDED.per_km_rate,
  per_min_rate = EXCLUDED.per_min_rate,
  min_fare = EXCLUDED.min_fare,
  commission_pct = EXCLUDED.commission_pct,
  updated_at = NOW();

-- Update EV TAXI night tariffs
UPDATE pricing_config SET
  night_base_fare = 0.462,
  night_per_km_rate = 0.389,
  night_per_min_rate = 0.070,
  day_start_hour = 6,
  night_start_hour = 22
WHERE car_type = 'ev_taxi';

-- ================================================
-- M06: Update driver_wallet VIEW for prepaid system
-- ================================================

DROP VIEW IF EXISTS driver_wallet;

CREATE OR REPLACE VIEW driver_wallet AS
  SELECT
    dp.user_id,
    dp.wallet_balance,
    dp.total_recharged,
    dp.total_commission_paid,
    -- Today's stats
    COALESCE(
      SUM(CASE WHEN t.type = 'admin_recharge'
               AND DATE(t.created_at) = CURRENT_DATE THEN t.amount ELSE 0 END), 0
    ) AS today_recharged,
    COALESCE(
      SUM(CASE WHEN t.type = 'commission_deduction'
               AND DATE(t.created_at) = CURRENT_DATE THEN t.amount ELSE 0 END), 0
    ) AS today_commission,
    -- Count today's rides
    (
      SELECT COUNT(*) FROM rides r
      WHERE r.driver_id = dp.user_id
      AND DATE(r.completed_at) = CURRENT_DATE
      AND r.status = 'completed'
    ) AS today_rides
  FROM driver_profiles dp
  LEFT JOIN transactions t ON t.user_id = dp.user_id
  GROUP BY dp.user_id, dp.wallet_balance, dp.total_recharged, dp.total_commission_paid;

-- ================================================
-- M07: Add index for wallet balance (for matching engine)
-- ================================================

CREATE INDEX IF NOT EXISTS idx_driver_profiles_wallet_balance
  ON driver_profiles(wallet_balance)
  WHERE is_online = true AND approval_status = 'approved';

-- ================================================
-- M08: Ensure cliq_alias NOT NULL for new drivers
-- (Applied via app validation — migration sets NOT NULL after backfill)
-- ================================================

-- Note: Run this AFTER backfilling existing drivers' CliQ aliases:
-- ALTER TABLE driver_profiles ALTER COLUMN cliq_alias SET NOT NULL;

-- ================================================
-- Summary of changes:
-- 1. driver_profiles: +cliq_alias, +wallet fields, -bank fields, new car_type ENUM
-- 2. rides: +commission_amount, +commission_deducted, +tariff_type, +waiting_minutes, cash-only
-- 3. transactions: admin_recharge + commission_deduction only, +recharged_by
-- 4. pricing_config: 5 car types, 13% unified commission, EV TAXI night tariffs
-- 5. payment_cards: DROPPED
-- 6. driver_wallet VIEW: updated for prepaid model
-- ================================================
