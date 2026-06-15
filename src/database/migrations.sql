-- ================================================
-- EVO Database Migrations
-- Run in order: 001 → 012
-- ================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enable PostGIS for geospatial queries
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ================================================
-- 001: USERS
-- ================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) NOT NULL,
  email VARCHAR(255),
  full_name VARCHAR(100) NOT NULL,
  date_of_birth DATE,
  avatar_url TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'passenger'
    CHECK (role IN ('passenger', 'driver', 'admin')),
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'pending_approval', 'rejected')),
  firebase_uid VARCHAR(128),
  onesignal_player_id VARCHAR(64),
  preferred_language VARCHAR(5) NOT NULL DEFAULT 'ar'
    CHECK (preferred_language IN ('ar', 'en')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_phone UNIQUE (phone),
  CONSTRAINT unique_firebase_uid UNIQUE (firebase_uid)
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- ================================================
-- 002: DRIVER PROFILES
-- ================================================
CREATE TABLE IF NOT EXISTS driver_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Identity Documents (encrypted URLs)
  national_id_number VARCHAR(20) NOT NULL,
  national_id_front_url TEXT NOT NULL,
  national_id_back_url TEXT NOT NULL,
  personal_photo_url TEXT NOT NULL,

  -- License
  license_number VARCHAR(50) NOT NULL,
  license_photo_url TEXT NOT NULL,

  -- Criminal Record
  criminal_clearance_url TEXT NOT NULL,

  -- Vehicle
  car_model VARCHAR(100) NOT NULL,
  car_plate VARCHAR(20) NOT NULL,
  car_type VARCHAR(20) NOT NULL
    CHECK (car_type IN ('ev_basic', 'ev_luxury', 'ev_suv')),
  car_image_url TEXT,
  battery_capacity_kwh DECIMAL(5,1),
  range_km INT,

  -- Real-time Location (updated by Socket.io)
  is_online BOOLEAN NOT NULL DEFAULT false,
  current_lat DECIMAL(10,8),
  current_lng DECIMAL(11,8),
  current_heading DECIMAL(5,2),
  last_location_update TIMESTAMPTZ,

  -- Stats
  rating DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  total_rides INT NOT NULL DEFAULT 0,
  total_earnings DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- Bank Info
  bank_name VARCHAR(100),
  bank_iban VARCHAR(34),
  bank_account_holder VARCHAR(100),

  -- Approval
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'more_info_needed')),
  approval_notes TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_driver_user UNIQUE (user_id),
  CONSTRAINT unique_national_id UNIQUE (national_id_number),
  CONSTRAINT unique_car_plate UNIQUE (car_plate)
);

CREATE INDEX idx_driver_profiles_user_id ON driver_profiles(user_id);
CREATE INDEX idx_driver_profiles_is_online ON driver_profiles(is_online);
CREATE INDEX idx_driver_profiles_approval_status ON driver_profiles(approval_status);
CREATE INDEX idx_driver_profiles_car_type ON driver_profiles(car_type);

-- ================================================
-- 003: DRIVER DOCUMENTS
-- ================================================
CREATE TABLE IF NOT EXISTS driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL
    CHECK (document_type IN (
      'national_id_front', 'national_id_back',
      'personal_photo', 'license_photo',
      'criminal_clearance', 'car_photo'
    )),
  file_url TEXT NOT NULL,
  file_hash VARCHAR(64),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected'))
);

CREATE INDEX idx_driver_documents_driver ON driver_documents(driver_user_id);

-- ================================================
-- 004: DRIVER APPROVAL AUDIT LOG
-- ================================================
CREATE TABLE IF NOT EXISTS driver_approval_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES users(id),
  action VARCHAR(30) NOT NULL
    CHECK (action IN ('submitted', 'approved', 'rejected', 'more_info_requested', 'resubmitted')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approval_logs_driver ON driver_approval_logs(driver_user_id);

-- ================================================
-- 005: RIDES
-- ================================================
CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id UUID NOT NULL REFERENCES users(id),
  driver_id UUID REFERENCES users(id),

  -- Locations (8 decimal = ~1.1mm precision)
  pickup_lat DECIMAL(10,8) NOT NULL,
  pickup_lng DECIMAL(11,8) NOT NULL,
  pickup_address TEXT,
  pickup_address_ar TEXT,
  dropoff_lat DECIMAL(10,8) NOT NULL,
  dropoff_lng DECIMAL(11,8) NOT NULL,
  dropoff_address TEXT,
  dropoff_address_ar TEXT,

  -- Status machine
  status VARCHAR(20) NOT NULL DEFAULT 'searching'
    CHECK (status IN ('searching', 'accepted', 'arriving', 'arrived',
                      'in_progress', 'completed', 'cancelled')),

  -- Vehicle
  car_type VARCHAR(20) NOT NULL
    CHECK (car_type IN ('ev_basic', 'ev_luxury', 'ev_suv')),

  -- Fare Breakdown
  distance_km DECIMAL(6,2),
  duration_min INT,
  base_fare DECIMAL(6,2),
  per_km_rate DECIMAL(4,2),
  per_min_rate DECIMAL(4,2),
  surge_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.0,
  subtotal DECIMAL(8,2),

  -- Promo
  promo_code_id UUID,
  discount_amount DECIMAL(6,2) NOT NULL DEFAULT 0,

  -- Final
  total_fare DECIMAL(8,2),
  co2_saved_kg DECIMAL(5,2),

  -- Payment
  payment_method VARCHAR(10) NOT NULL
    CHECK (payment_method IN ('cash', 'card')),
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_reference VARCHAR(100),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('passenger', 'driver', 'system')),
  cancellation_reason TEXT
);

CREATE INDEX idx_rides_passenger ON rides(passenger_id);
CREATE INDEX idx_rides_driver ON rides(driver_id);
CREATE INDEX idx_rides_status ON rides(status);
CREATE INDEX idx_rides_created_at ON rides(created_at DESC);

-- ================================================
-- 006: TRANSACTIONS (WALLET)
-- ================================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID REFERENCES rides(id),
  type VARCHAR(30) NOT NULL
    CHECK (type IN ('ride_earning', 'commission_deduction', 'payout', 'ride_payment', 'refund')),
  amount DECIMAL(8,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  description TEXT,
  description_ar TEXT,
  reference VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_ride ON transactions(ride_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);

-- Wallet balance view (computed from transactions)
CREATE OR REPLACE VIEW driver_wallet AS
  SELECT
    user_id,
    COALESCE(SUM(CASE WHEN type IN ('ride_earning') THEN amount ELSE 0 END), 0) AS total_earned,
    COALESCE(SUM(CASE WHEN type IN ('commission_deduction') THEN amount ELSE 0 END), 0) AS total_commission,
    COALESCE(SUM(CASE WHEN type IN ('payout') THEN amount ELSE 0 END), 0) AS total_paid_out,
    COALESCE(
      SUM(CASE WHEN type IN ('ride_earning') THEN amount ELSE 0 END) -
      SUM(CASE WHEN type IN ('commission_deduction', 'payout') THEN amount ELSE 0 END),
      0
    ) AS current_balance
  FROM transactions
  GROUP BY user_id;

-- ================================================
-- 007: PAYMENT CARDS (TOKENIZED — NO RAW CARD DATA)
-- ================================================
CREATE TABLE IF NOT EXISTS payment_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_token VARCHAR(255) NOT NULL,
  last_four VARCHAR(4) NOT NULL,
  brand VARCHAR(15) NOT NULL CHECK (brand IN ('visa', 'mastercard')),
  expiry_month INT NOT NULL,
  expiry_year INT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_cards_user ON payment_cards(user_id);

-- ================================================
-- 008: PROMO CODES
-- ================================================
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL,
  discount_type VARCHAR(15) NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value DECIMAL(6,2) NOT NULL,
  max_discount_jod DECIMAL(6,2),
  min_fare_jod DECIMAL(6,2) NOT NULL DEFAULT 0,
  max_total_uses INT,
  max_per_user INT NOT NULL DEFAULT 1,
  current_total_uses INT NOT NULL DEFAULT 0,
  applicable_car_types TEXT[],
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_promo_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS promo_code_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id),
  user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID REFERENCES rides(id),
  discount_applied DECIMAL(6,2) NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_promo_ride UNIQUE (promo_code_id, user_id, ride_id)
);

CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_usages_user ON promo_code_usages(user_id);
CREATE INDEX idx_promo_usages_code ON promo_code_usages(promo_code_id);

-- ================================================
-- 009: PRICING CONFIGURATION
-- ================================================
CREATE TABLE IF NOT EXISTS pricing_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_type VARCHAR(20) NOT NULL UNIQUE
    CHECK (car_type IN ('ev_basic', 'ev_luxury', 'ev_suv')),
  base_fare DECIMAL(6,2) NOT NULL,
  per_km_rate DECIMAL(4,2) NOT NULL,
  per_min_rate DECIMAL(4,2) NOT NULL,
  min_fare DECIMAL(6,2) NOT NULL,
  commission_pct DECIMAL(4,2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default pricing from blueprint
INSERT INTO pricing_config (car_type, base_fare, per_km_rate, per_min_rate, min_fare, commission_pct) VALUES
  ('ev_basic',  0.50, 0.35, 0.10, 1.50, 15.00),
  ('ev_luxury', 1.00, 0.60, 0.15, 3.00, 18.00),
  ('ev_suv',    1.50, 0.75, 0.20, 4.00, 20.00)
ON CONFLICT (car_type) DO NOTHING;

-- ================================================
-- 010: SURGE PRICING ZONES
-- ================================================
CREATE TABLE IF NOT EXISTS surge_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_name VARCHAR(100) NOT NULL,
  zone_name_ar VARCHAR(100),
  polygon GEOGRAPHY(POLYGON, 4326) NOT NULL,
  surge_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.0,
  active_from TIMESTAMPTZ,
  active_until TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_surge_zones_polygon ON surge_zones USING GIST(polygon);

-- ================================================
-- 011: CHARGING STATIONS (Hybrid: OCM + Manual)
-- ================================================
CREATE TABLE IF NOT EXISTS charging_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  name_ar VARCHAR(200),
  lat DECIMAL(10,8) NOT NULL,
  lng DECIMAL(11,8) NOT NULL,
  address TEXT,
  address_ar TEXT,
  charger_types TEXT[],
  total_chargers INT,
  available_chargers INT,
  operator VARCHAR(100),
  source VARCHAR(20) NOT NULL CHECK (source IN ('opencharge_map', 'manual')),
  ocm_id INT,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  added_by UUID REFERENCES users(id),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_charging_stations_visible ON charging_stations(is_visible);
CREATE INDEX idx_charging_stations_ocm_id ON charging_stations(ocm_id);
-- Spatial index for nearby queries
CREATE INDEX idx_charging_stations_location ON charging_stations(lat, lng);

-- ================================================
-- 012: ADMIN AUDIT LOGS
-- ================================================
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id UUID,
  details JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_admin ON admin_audit_logs(admin_id);
CREATE INDEX idx_audit_logs_action ON admin_audit_logs(action);
CREATE INDEX idx_audit_logs_created ON admin_audit_logs(created_at DESC);

-- ================================================
-- Add promo_code_id FK to rides AFTER promo table created
-- ================================================
ALTER TABLE rides
  ADD CONSTRAINT fk_rides_promo
  FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id)
  NOT VALID;

-- ================================================
-- Auto-update updated_at trigger
-- ================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_charging_stations_updated_at
  BEFORE UPDATE ON charging_stations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
