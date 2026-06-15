const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { verifyOtp, refreshToken, updateProfile } = require('../controllers/authController');
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

const router = express.Router();

// ────────────────────────────────────────────
// AUTH (Public)
// ────────────────────────────────────────────
router.post('/auth/verify-otp', verifyOtp);
router.post('/auth/refresh-token', refreshToken);
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

adminRouter.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'admin@evo.jo' && password === '123456') {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ userId: 1, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return res.json({ accessToken: token, user: { id: 1, name: 'Admin', role: 'admin' }});
  }
  return res.status(401).json({ error: 'كلمة المرور أو البريد الإلكتروني غير صحيح' });
});

adminRouter.use(authenticate, requireRole('admin'));

adminRouter.get('/dashboard/stats', adminController.getDashboardStats);

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

router.use('/admin', adminRouter);

module.exports = router;
