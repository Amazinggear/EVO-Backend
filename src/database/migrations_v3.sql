-- ================================================
-- EVO Database Migrations v3
-- Run AFTER migrations_v2.sql
-- Updates for Admin Panel features:
--   - RBAC for admins (super_admin, operations, finance, support)
--   - Passenger rating & cancellation tracking
--   - Last login tracking
--   - Additional driver documents (vehicle_license, insurance)
--   - Complaints System
--   - Mass Notifications history
-- ================================================

-- ================================================
-- M01: Update users table
-- ================================================

-- Add detailed admin_role
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_role VARCHAR(30)
    CHECK (admin_role IN ('super_admin', 'operations', 'finance', 'support'));

-- Assign super_admin to existing admin if needed
UPDATE users SET admin_role = 'super_admin' WHERE role = 'admin' AND admin_role IS NULL;

-- Passenger rating & cancellations
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS passenger_rating DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS cancellation_count INT NOT NULL DEFAULT 0;

-- Last login tracking
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- ================================================
-- M02: Update driver_documents
-- ================================================

-- We need to alter the CHECK constraint for document_type to allow new types
ALTER TABLE driver_documents
  DROP CONSTRAINT IF EXISTS driver_documents_document_type_check;

ALTER TABLE driver_documents
  ADD CONSTRAINT driver_documents_document_type_check
  CHECK (document_type IN (
    'national_id_front', 'national_id_back',
    'personal_photo', 'license_photo',
    'criminal_clearance', 'car_photo',
    'vehicle_license', 'insurance'
  ));

-- ================================================
-- M03: Create complaints table
-- ================================================

CREATE TABLE IF NOT EXISTS complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- Complainant
  target_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Accused (Optional)
  ride_id UUID REFERENCES rides(id) ON DELETE SET NULL, -- Related Ride (Optional)
  
  type VARCHAR(30) NOT NULL
    CHECK (type IN ('from_customer', 'from_driver', 'other')),
  
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'investigating', 'resolved', 'closed')),
  
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, -- Support Agent
  
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  resolution_notes TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trigger_complaints_updated_at ON complaints;
CREATE TRIGGER trigger_complaints_updated_at
  BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ================================================
-- M04: Create mass_notifications log table
-- ================================================

CREATE TABLE IF NOT EXISTS mass_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  target_audience VARCHAR(50) NOT NULL
    CHECK (target_audience IN ('all_drivers', 'all_passengers', 'specific_group')),
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mass_notifications_audience ON mass_notifications(target_audience);
CREATE INDEX IF NOT EXISTS idx_mass_notifications_created ON mass_notifications(created_at DESC);

-- ================================================
-- Summary of changes v3:
-- 1. users: +admin_role, +passenger_rating, +cancellation_count, +last_login_at
-- 2. driver_documents: added 'vehicle_license', 'insurance' to constraint
-- 3. complaints: NEW TABLE
-- 4. mass_notifications: NEW TABLE
-- ================================================
