const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { verifyOtp, refreshToken, updateProfile, getMe } = require('../controllers/authController');
const {
  registerStep1, registerStep2, registerStep3, registerStep4,
  submitRegistration, getRegistrationStatus,
  getPendingDrivers, approveDriver, rejectDriver, requestMoreInfo,
} = require('../controllers/driverRegistrationController');
const {
  getNearbyDrivers, estimateFare, requestRide,
  acceptRide, startRide, completeRide, getRideHistory,
} = require('../controllers/rideController');
const walletController = require('../controllers/walletController');
const chargingController = require('../controllers/chargingController');
const promoController = require('../controllers/promoController');
const adminController = require('../controllers/adminController');
const {
  adminRechargeWallet, adminGetAllBalances, adminGetDriverHistory,
} = require('../controllers/walletController');
const { getComplaints, updateComplaintStatus, assignComplaint } = require('../controllers/complaintsController');
const { sendMassNotification, getNotificationHistory } = require('../controllers/notificationsController');
const { listAdmins, createAdmin, updateAdminRole } = require('../controllers/adminRBACController');

const router = express.Router();

// ────────────────────────────────────────────
// AUTH (Public & Protected)
// ────────────────────────────────────────────
router.post('/auth/verify-otp', verifyOtp);
router.post('/auth/refresh-token', refreshToken);
router.get('/auth/me', authenticate, getMe);
router.patch('/auth/profile', authenticate, updateProfile);

// ────────────────────────────────────────────
// DRIVER REGISTRATION (requires auth)
// ────────────────────────────────────────────
router.post('/driver/register/step-1', authenticate, registerStep1);
router.post('/driver/register/step-2', authenticate, registerStep2);
router.post('/driver/register/step-3', authenticate, registerStep3);
router.post('/driver/register/step-4', authenticate, registerStep4);
router.post('/driver/register/submit', authenticate, submitRegistration);
router.get('/driver/register/status', authenticate, getRegistrationStatus);

// ────────────────────────────────────────────
// PASSENGER RIDES
// ────────────────────────────────────────────
router.get('/rides/nearby-drivers', authenticate, requireRole('passenger'), getNearbyDrivers);
router.post('/rides/estimate', authenticate, estimateFare);
router.post('/rides/request', authenticate, requireRole('passenger'), requestRide);
router.get('/rides/history', authenticate, getRideHistory);
router.patch('/rides/:id/cancel', authenticate, async (req, res) => {
  const { query } = require('../config/database');
  const { id } = req.params;
  const userId = req.user.id;
  const { reason } = req.body;
  const field = req.user.role === 'driver' ? 'driver_id' : 'passenger_id';
  await query(
    `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, cancellation_reason = $2
     WHERE id = $3 AND ${field} = $4 AND status NOT IN ('completed', 'cancelled')`,
    [req.user.role, reason || null, id, userId]
  );
  res.json({ success: true });
});

// ────────────────────────────────────────────
// DRIVER OPERATIONS
// ────────────────────────────────────────────
router.patch('/driver/toggle-online', authenticate, requireRole('driver'), async (req, res) => {
  const { setDriverOnline, setDriverOffline } = require('../config/redis');
  const { query } = require('../config/database');
  const { isOnline } = req.body;
  const userId = req.user.id;
  if (isOnline) {
    const { rows } = await query('SELECT car_type, approval_status FROM driver_profiles WHERE user_id = $1', [userId]);
    if (!rows[0] || rows[0].approval_status !== 'approved') {
      return res.status(403).json({ error: 'Account not approved', code: 'DRIVER_NOT_APPROVED' });
    }
    await setDriverOnline(userId, rows[0].car_type);
    await query('UPDATE driver_profiles SET is_online = true WHERE user_id = $1', [userId]);
  } else {
    await setDriverOffline(userId);
    await query('UPDATE driver_profiles SET is_online = false WHERE user_id = $1', [userId]);
  }
  res.json({ success: true, isOnline });
});

router.patch('/rides/:id/accept', authenticate, requireRole('driver'), acceptRide);
router.patch('/rides/:id/arrive', authenticate, requireRole('driver'), async (req, res) => {
  const { query } = require('../config/database');
  await query(`UPDATE rides SET status = 'arrived', arrived_at = NOW() WHERE id = $1 AND driver_id = $2`, [req.params.id, req.user.id]);
  res.json({ success: true, status: 'arrived' });
});
router.patch('/rides/:id/start', authenticate, requireRole('driver'), startRide);
router.patch('/rides/:id/complete', authenticate, requireRole('driver'), completeRide);

// ────────────────────────────────────────────
// WALLET (Driver - Prepaid System)
// ────────────────────────────────────────────
router.get('/wallet/balance', authenticate, requireRole('driver'), walletController.getBalance);
router.get('/wallet/transactions', authenticate, requireRole('driver'), walletController.getTransactions);
// ❌ REMOVED: /wallet/redeem-voucher (scratch cards cancelled)
// ❌ REMOVED: /wallet/withdraw (no bank payouts)

// ────────────────────────────────────────────
// CHARGING STATIONS
// ────────────────────────────────────────────
router.get('/charging-stations', authenticate, chargingController.getNearbyStations);
router.get('/charging-stations/:id', authenticate, chargingController.getStationById);

// ────────────────────────────────────────────
// PROMO CODES
// ────────────────────────────────────────────
router.post('/promo/validate', authenticate, promoController.validatePromo);

// ────────────────────────────────────────────
// ADMIN ROUTES
// ────────────────────────────────────────────
const adminRouter = express.Router();

adminRouter.post('/login', async (req, res) => {
  const { query } = require('../config/database');
  const { email, password } = req.body;
  
  // For MVP, using a hardcoded password. In production, use bcrypt and store password_hash in users table.
  if (password !== '123456') return res.status(401).json({ error: 'كلمة المرور أو البريد الإلكتروني غير صحيح' });
  
  const { rows } = await query("SELECT id, full_name, role, admin_role, status FROM users WHERE email = $1 AND role = 'admin'", [email]);
  if (!rows[0] || rows[0].status === 'suspended') return res.status(401).json({ error: 'الحساب غير موجود أو موقوف' });
  
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [rows[0].id]);
  
  const jwt = require('jsonwebtoken');
  const jwtSecret = process.env.JWT_SECRET || 'evo-jwt-secret-145555-594162-change-in-production';
  const token = jwt.sign({ userId: rows[0].id, role: 'admin' }, jwtSecret, { expiresIn: '1d' });
  return res.json({ accessToken: token, user: rows[0] });
});

adminRouter.use(authenticate, requireRole('admin', 'super_admin', 'operations', 'finance', 'support'));

adminRouter.get('/dashboard/stats', adminController.getDashboardStats);
adminRouter.get('/stats', adminController.getDashboardStats); // alias

// Users
adminRouter.get('/users', adminController.listUsers);
adminRouter.get('/users/:id', adminController.getUserDetails);
adminRouter.patch('/users/:id/status', adminController.updateUserStatus);

// Driver Approval
adminRouter.get('/drivers/pending', getPendingDrivers);
adminRouter.get('/drivers/:id/documents', adminController.getDriverDocuments);
adminRouter.post('/drivers/:id/approve', approveDriver);
adminRouter.post('/drivers/:id/reject', rejectDriver);
adminRouter.post('/drivers/:id/request-info', requestMoreInfo);

// Live tracking
adminRouter.get('/rides/live', adminController.getLiveRides);

// Admin rides list (paginated)
adminRouter.get('/rides', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { status, from, to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const values = [];
    let i = 1;

    if (status) { conditions.push(`r.status = $${i++}`); values.push(status); }
    if (from) { conditions.push(`r.created_at >= $${i++}`); values.push(from); }
    if (to) { conditions.push(`r.created_at <= $${i++}`); values.push(to + ' 23:59:59'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT r.id, r.status, r.car_type, r.distance_km, r.total_fare, r.commission_amount,
              r.created_at, r.completed_at,
              pu.full_name as passenger_name,
              du.full_name as driver_name,
              dp.car_plate, dp.car_model,
              r.pickup_address as pickup_area, r.dropoff_address as dropoff_area
       FROM rides r
       JOIN users pu ON pu.id = r.passenger_id
       LEFT JOIN users du ON du.id = r.driver_id
       LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN r.status='completed' THEN r.total_fare ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN r.status='completed' THEN r.commission_amount ELSE 0 END), 0) as total_commission
       FROM rides r ${where}`,
      values
    );

    const total = parseInt(countRows[0].total);
    const formattedRides = rows.map(r => ({
      ...r,
      ride_number: `EVO-${r.id.toString().slice(0, 5).toUpperCase()}`,
      fare: parseFloat(r.total_fare) || 0,
      commission: parseFloat(r.commission_amount) || parseFloat((r.total_fare * 0.13).toFixed(3)),
      distance_km: parseFloat(r.distance_km) || 0,
    }));

    return res.json({
      rides: formattedRides,
      total,
      page: parseInt(page),
      total_pages: Math.ceil(total / limit),
      summary: {
        total_rides: total,
        total_revenue: parseFloat(countRows[0].total_revenue),
        total_commission: parseFloat(countRows[0].total_commission),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch rides', details: err.message });
  }
});

// Admin drivers list
adminRouter.get('/drivers', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { status, search } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (status && status !== 'all') { conditions.push(`dp.approval_status = $${i++}`); values.push(status); }
    if (search) { conditions.push(`(u.full_name ILIKE $${i} OR u.phone ILIKE $${i} OR dp.car_plate ILIKE $${i})`); values.push(`%${search}%`); i++; }

    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT u.id, u.full_name, u.phone,
              dp.car_type, dp.car_model, dp.car_plate, dp.approval_status,
              dp.rating, dp.wallet_balance, dp.total_rides, dp.cliq_alias,
              dp.national_id_number, dp.license_number,
              dp.national_id_front_url, dp.national_id_back_url,
              dp.personal_photo_url, dp.license_photo_url, dp.criminal_clearance_url,
              u.created_at
       FROM users u
       JOIN driver_profiles dp ON dp.user_id = u.id
       WHERE u.role = 'driver' ${where}
       ORDER BY u.created_at DESC`,
      values
    );

    const formatted = rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      car_type: r.car_type,
      car_model: r.car_model,
      car_plate: r.car_plate,
      approval_status: r.approval_status,
      rating: parseFloat(r.rating) || 0,
      wallet_balance: parseFloat(r.wallet_balance) || 0,
      total_rides: parseInt(r.total_rides) || 0,
      cliq_alias: r.cliq_alias,
      national_id_number: r.national_id_number,
      license_number: r.license_number,
      national_id_front_url: r.national_id_front_url,
      national_id_back_url: r.national_id_back_url,
      personal_photo_url: r.personal_photo_url,
      license_photo_url: r.license_photo_url,
      criminal_clearance_url: r.criminal_clearance_url,
      created_at: r.created_at,
    }));

    return res.json({ drivers: formatted, total: formatted.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch drivers', details: err.message });
  }
});

// Pricing
adminRouter.get('/pricing', adminController.getPricing);
adminRouter.patch('/pricing/:carType', adminController.updatePricing);

// Surge zones
adminRouter.get('/surge-zones', adminController.getSurgeZones);
adminRouter.post('/surge-zones', adminController.createSurgeZone);
adminRouter.patch('/surge-zones/:id', adminController.updateSurgeZone);

// Promo codes
adminRouter.get('/promo-codes', adminController.listPromoCodes);
adminRouter.post('/promo-codes', adminController.createPromoCode);
adminRouter.patch('/promo-codes/:id', adminController.updatePromoCode);
adminRouter.delete('/promo-codes/:id', adminController.deletePromoCode);

// Wallet Management (Admin recharges driver wallets by plate number)
adminRouter.post('/wallet/recharge', adminRechargeWallet);
adminRouter.get('/wallet/balances', adminGetAllBalances);
adminRouter.get('/wallet/history/:driverId', adminGetDriverHistory);

// Charging stations
adminRouter.get('/charging-stations', chargingController.adminListAllStations);
adminRouter.post('/charging-stations', chargingController.adminAddStation);
adminRouter.patch('/charging-stations/:id', chargingController.adminUpdateStation);
adminRouter.delete('/charging-stations/:id', chargingController.adminDeleteStation);
adminRouter.post('/charging-stations/sync', chargingController.adminSyncFromOCM);

// Financials
adminRouter.get('/financials/summary', adminController.getFinancialSummary);
adminRouter.get('/financials/transactions', adminController.getAllTransactions);
// ❌ REMOVED: /payouts/process (no bank payouts)
adminRouter.get('/audit-logs', adminController.getAuditLogs);

// Complaints
adminRouter.get('/complaints', getComplaints);
adminRouter.patch('/complaints/:id/status', updateComplaintStatus);
adminRouter.patch('/complaints/:id/assign', assignComplaint);

// Notifications
adminRouter.post('/notifications/send', sendMassNotification);
adminRouter.get('/notifications/history', getNotificationHistory);

// Admin Management (RBAC)
adminRouter.get('/admins', listAdmins);
adminRouter.post('/admins', createAdmin);
adminRouter.patch('/admins/:id/role', updateAdminRole);

// Backup
adminRouter.get('/backup/export', async (req, res) => {
  const { performBackup } = require('../utils/backupService');
  try {
    if (req.user.admin_role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const data = await performBackup();
    res.setHeader('Content-disposition', 'attachment; filename=evo_backup.json');
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Backup failed' });
  }
});

router.use('/admin', adminRouter);

module.exports = router;
