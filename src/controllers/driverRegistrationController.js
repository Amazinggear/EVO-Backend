'use strict';

const { query } = require('../config/database');
const { notify } = require('../config/onesignal');
const logger = require('../utils/logger');

/**
 * Valid car types for the EVO 5-tier vehicle system.
 */
const VALID_CAR_TYPES = ['ev_mini', 'ev_taxi', 'ev_sedan', 'ev_suv', 'ev_luxury'];

// ─────────────────────────────────────────────────────────────────
// DRIVER: Multi-step registration flow
// ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/driver/register/step-1
 * Basic info — date of birth + CliQ payment alias.
 * cliqAlias is MANDATORY; missing it returns 422.
 */
const registerStep1 = async (req, res) => {
  try {
    const { dateOfBirth, cliqAlias } = req.body;
    const userId = req.user.id;

    // ── Validate cliqAlias (mandatory) ──────────────────────────
    if (!cliqAlias || typeof cliqAlias !== 'string' || cliqAlias.trim() === '') {
      return res.status(422).json({
        error: 'CliQ alias is required for payouts',
        code: 'CLIQ_ALIAS_REQUIRED',
      });
    }

    const sanitizedAlias = cliqAlias.trim().toLowerCase();

    // ── Validate age ──────────────────────────────────────────────
    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return res.status(422).json({ error: 'Invalid date of birth', code: 'INVALID_DOB' });
    }
    const today = new Date();
    const age = Math.floor((today - dob) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 21) {
      return res.status(422).json({
        error: 'Driver must be at least 21 years old',
        code: 'AGE_REQUIREMENT',
      });
    }

    // ── Update users table ────────────────────────────────────────
    await query(
      `UPDATE users
         SET role = 'driver', status = 'pending_approval', date_of_birth = $1, updated_at = NOW()
       WHERE id = $2`,
      [dateOfBirth, userId]
    );

    // ── Upsert driver_profiles so cliq_alias is persisted early ───
    await query(
      `INSERT INTO driver_profiles (
         user_id, cliq_alias,
         national_id_number, national_id_front_url, national_id_back_url, personal_photo_url,
         license_number, license_photo_url, criminal_clearance_url,
         car_model, car_plate, car_type
       ) VALUES ($1, $2, 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'ev_mini')
       ON CONFLICT (user_id) DO UPDATE
         SET cliq_alias = EXCLUDED.cliq_alias`,
      [userId, sanitizedAlias]
    );

    return res.json({ success: true, step: 1, nextStep: 2 });
  } catch (err) {
    logger.error('registerStep1 error:', err.message);
    return res.status(500).json({ error: 'Registration step 1 failed' });
  }
};

/**
 * POST /api/v1/driver/register/step-2
 * Identity documents — national ID number + uploaded document URLs
 */
const registerStep2 = async (req, res) => {
  try {
    const { nationalIdNumber, nationalIdFrontUrl, nationalIdBackUrl, personalPhotoUrl } = req.body;
    const userId = req.user.id;

    // Check national ID uniqueness
    const { rows: existing } = await query(
      'SELECT id FROM driver_profiles WHERE national_id_number = $1 AND user_id != $2',
      [nationalIdNumber, userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This National ID is already registered', code: 'DUPLICATE_NATIONAL_ID' });
    }

    // ── Upsert driver profile — partial fill ──────────────────────
    // Default car_type is 'ev_mini' (lowest tier); step 4 sets the real value.
    await query(
      `INSERT INTO driver_profiles (
         user_id, national_id_number, national_id_front_url, national_id_back_url, personal_photo_url,
         license_number, license_photo_url, criminal_clearance_url,
         car_model, car_plate, car_type
       ) VALUES ($1, $2, $3, $4, $5, 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'ev_mini')
       ON CONFLICT (user_id) DO UPDATE SET
         national_id_number    = EXCLUDED.national_id_number,
         national_id_front_url = EXCLUDED.national_id_front_url,
         national_id_back_url  = EXCLUDED.national_id_back_url,
         personal_photo_url    = EXCLUDED.personal_photo_url`,
      [userId, nationalIdNumber, nationalIdFrontUrl, nationalIdBackUrl, personalPhotoUrl]
    );

    // Log documents
    for (const [docType, url] of [
      ['national_id_front', nationalIdFrontUrl],
      ['national_id_back', nationalIdBackUrl],
      ['personal_photo', personalPhotoUrl],
    ]) {
      await query(
        `INSERT INTO driver_documents (driver_user_id, document_type, file_url)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, docType, url]
      );
    }

    return res.json({ success: true, step: 2, nextStep: 3 });
  } catch (err) {
    logger.error('registerStep2 error:', err.message);
    return res.status(500).json({ error: 'Registration step 2 failed' });
  }
};

/**
 * POST /api/v1/driver/register/step-3
 * License + criminal clearance
 */
const registerStep3 = async (req, res) => {
  try {
    const { licenseNumber, licensePhotoUrl, criminalClearanceUrl } = req.body;
    const userId = req.user.id;

    await query(
      `UPDATE driver_profiles SET license_number = $1, license_photo_url = $2, criminal_clearance_url = $3 WHERE user_id = $4`,
      [licenseNumber, licensePhotoUrl, criminalClearanceUrl, userId]
    );

    for (const [docType, url] of [
      ['license_photo', licensePhotoUrl],
      ['criminal_clearance', criminalClearanceUrl],
    ]) {
      await query(
        `INSERT INTO driver_documents (driver_user_id, document_type, file_url)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, docType, url]
      );
    }

    return res.json({ success: true, step: 3, nextStep: 4 });
  } catch (err) {
    logger.error('registerStep3 error:', err.message);
    return res.status(500).json({ error: 'Registration step 3 failed' });
  }
};

/**
 * POST /api/v1/driver/register/step-4
 * Vehicle information
 */
const registerStep4 = async (req, res) => {
  try {
    const { carModel, carPlate, carType, carImageUrl, batteryCapacityKwh, rangeKm } = req.body;
    const userId = req.user.id;

    // ── Car-type validation — 5-type system ───────────────────────
    if (!VALID_CAR_TYPES.includes(carType)) {
      return res.status(400).json({
        error: `Invalid car type. Must be one of: ${VALID_CAR_TYPES.join(', ')}`,
        code: 'INVALID_CAR_TYPE',
        valid_types: VALID_CAR_TYPES,
      });
    }

    // ── Plate uniqueness check ────────────────────────────────────
    const { rows: existing } = await query(
      'SELECT id FROM driver_profiles WHERE car_plate = $1 AND user_id != $2',
      [carPlate.toUpperCase(), userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This plate number is already registered', code: 'DUPLICATE_PLATE' });
    }

    await query(
      `UPDATE driver_profiles
         SET car_model            = $1,
             car_plate            = $2,
             car_type             = $3,
             car_image_url        = $4,
             battery_capacity_kwh = $5,
             range_km             = $6
       WHERE user_id = $7`,
      [carModel, carPlate.toUpperCase(), carType, carImageUrl || null, batteryCapacityKwh || null, rangeKm || null, userId]
    );

    return res.json({ success: true, step: 4, nextStep: 'submit' });
  } catch (err) {
    logger.error('registerStep4 error:', err.message);
    return res.status(500).json({ error: 'Registration step 4 failed' });
  }
};

/**
 * POST /api/v1/driver/register/submit
 * Final submission — validate all required fields are present
 */
const submitRegistration = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await query(
      'SELECT * FROM driver_profiles WHERE user_id = $1',
      [userId]
    );

    if (!rows[0]) {
      return res.status(400).json({ error: 'Please complete all registration steps first' });
    }

    const profile = rows[0];
    const pendingFields = [];

    // ── Verify all sentinel fields have real data ─────────────────
    if (!profile.cliq_alias || profile.cliq_alias === 'PENDING') pendingFields.push('cliq_alias');
    if (!profile.national_id_front_url || profile.national_id_front_url === 'PENDING') pendingFields.push('national_id_front');
    if (!profile.license_number || profile.license_number === 'PENDING') pendingFields.push('license');
    if (!profile.criminal_clearance_url || profile.criminal_clearance_url === 'PENDING') pendingFields.push('criminal_clearance');
    if (!profile.car_model || profile.car_model === 'PENDING') pendingFields.push('vehicle_info');

    if (pendingFields.length > 0) {
      return res.status(422).json({
        error: 'Registration incomplete',
        pending_fields: pendingFields,
      });
    }

    // ── Mark as submitted for admin review ────────────────────────
    await query(
      `UPDATE driver_profiles SET approval_status = 'pending' WHERE user_id = $1`,
      [userId]
    );

    // ── Audit log ─────────────────────────────────────────────────
    await query(
      `INSERT INTO driver_approval_logs (driver_user_id, action, notes)
       VALUES ($1, 'submitted', 'Driver submitted registration for review')`,
      [userId]
    );

    return res.json({
      success: true,
      message: 'Application submitted successfully! You will be notified within 24-48 hours.',
      message_ar: 'تم إرسال طلبك بنجاح! سيتم إشعارك خلال 24-48 ساعة.',
      approval_status: 'pending',
      cliq_alias: profile.cliq_alias,
    });
  } catch (err) {
    logger.error('submitRegistration error:', err.message);
    return res.status(500).json({ error: 'Submission failed' });
  }
};

/**
 * GET /api/v1/driver/register/status
 */
const getRegistrationStatus = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT dp.approval_status, dp.approval_notes, dp.approved_at, dp.cliq_alias,
              u.status AS account_status
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
        WHERE dp.user_id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.json({ approval_status: 'not_registered', step_completed: 0 });
    }

    return res.json({
      approval_status: rows[0].approval_status,
      approval_notes:  rows[0].approval_notes,
      approved_at:     rows[0].approved_at,
      account_status:  rows[0].account_status,
      cliq_alias:      rows[0].cliq_alias,
    });
  } catch (err) {
    logger.error('getRegistrationStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
};

// ─────────────────────────────────────────────
// ADMIN: Driver Approval
// ─────────────────────────────────────────────

/**
 * GET /api/admin/drivers/pending
 */
const getPendingDrivers = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;

    const { rows } = await query(
      `SELECT
         dp.id, dp.user_id, u.full_name, u.phone, u.email, u.created_at AS registered_at,
         dp.national_id_number, dp.car_model, dp.car_plate, dp.car_type, dp.cliq_alias,
         dp.approval_status, dp.created_at AS submitted_at
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
      WHERE dp.approval_status IN ('pending', 'more_info_needed')
      ORDER BY dp.created_at ASC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM driver_profiles WHERE approval_status IN ('pending', 'more_info_needed')`
    );

    return res.json({
      drivers: rows,
      total:   parseInt(countRows[0].count, 10),
      page,
      limit,
    });
  } catch (err) {
    logger.error('getPendingDrivers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch pending drivers' });
  }
};

/**
 * POST /api/admin/drivers/:id/approve
 */
const approveDriver = async (req, res) => {
  try {
    const { id: driverUserId } = req.params;
    const adminId = req.user.id;

    const { rows } = await query(
      `UPDATE driver_profiles
       SET approval_status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE user_id = $2
       RETURNING user_id`,
      [adminId, driverUserId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Driver not found' });

    await query(
      `UPDATE users SET status = 'active' WHERE id = $1`,
      [driverUserId]
    );

    // Audit log
    await query(
      `INSERT INTO driver_approval_logs (driver_user_id, admin_user_id, action, notes)
       VALUES ($1, $2, 'approved', 'Driver account approved')`,
      [driverUserId, adminId]
    );
    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
       VALUES ($1, 'approve_driver', 'user', $2, '{"action":"approved"}')`,
      [adminId, driverUserId]
    );

    // Send OneSignal push to driver
    const { rows: userRows } = await query(
      'SELECT onesignal_player_id FROM users WHERE id = $1',
      [driverUserId]
    );
    if (userRows[0]?.onesignal_player_id) {
      await notify.driverApproved(userRows[0].onesignal_player_id);
    }

    return res.json({ success: true, message: 'Driver approved successfully' });
  } catch (err) {
    logger.error('approveDriver error:', err.message);
    return res.status(500).json({ error: 'Approval failed' });
  }
};

/**
 * POST /api/admin/drivers/:id/reject
 * Body: { reason }
 */
const rejectDriver = async (req, res) => {
  try {
    const { id: driverUserId } = req.params;
    const { reason }           = req.body;
    const adminId              = req.user.id;

    if (!reason || reason.trim() === '') {
      return res.status(422).json({ error: 'Rejection reason is required', code: 'REASON_REQUIRED' });
    }

    await query(
      `UPDATE driver_profiles SET approval_status = 'rejected', approval_notes = $1 WHERE user_id = $2`,
      [reason, driverUserId]
    );
    await query(`UPDATE users SET status = 'rejected' WHERE id = $1`, [driverUserId]);

    await query(
      `INSERT INTO driver_approval_logs (driver_user_id, admin_user_id, action, notes)
       VALUES ($1, $2, 'rejected', $3)`,
      [driverUserId, adminId, reason]
    );

    const { rows: userRows } = await query('SELECT onesignal_player_id FROM users WHERE id = $1', [driverUserId]);
    if (userRows[0]?.onesignal_player_id) {
      await notify.driverRejected(userRows[0].onesignal_player_id, reason);
    }

    return res.json({ success: true, message: 'Driver rejected' });
  } catch (err) {
    logger.error('rejectDriver error:', err.message);
    return res.status(500).json({ error: 'Rejection failed' });
  }
};

/**
 * POST /api/admin/drivers/:id/request-info
 * Body: { requiredDoc }
 */
const requestMoreInfo = async (req, res) => {
  try {
    const { id: driverUserId } = req.params;
    const { requiredDoc }      = req.body;
    const adminId              = req.user.id;

    if (!requiredDoc || requiredDoc.trim() === '') {
      return res.status(422).json({ error: 'requiredDoc is required', code: 'DOC_REQUIRED' });
    }

    await query(
      `UPDATE driver_profiles SET approval_status = 'more_info_needed', approval_notes = $1 WHERE user_id = $2`,
      [requiredDoc, driverUserId]
    );

    await query(
      `INSERT INTO driver_approval_logs (driver_user_id, admin_user_id, action, notes)
       VALUES ($1, $2, 'more_info_requested', $3)`,
      [driverUserId, adminId, requiredDoc]
    );

    const { rows: userRows } = await query('SELECT onesignal_player_id FROM users WHERE id = $1', [driverUserId]);
    if (userRows[0]?.onesignal_player_id) {
      await notify.driverMoreInfo(userRows[0].onesignal_player_id, requiredDoc);
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('requestMoreInfo error:', err.message);
    return res.status(500).json({ error: 'Request failed' });
  }
};

module.exports = {
  registerStep1, registerStep2, registerStep3, registerStep4,
  submitRegistration, getRegistrationStatus,
  getPendingDrivers, approveDriver, rejectDriver, requestMoreInfo,
};
