const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * GET /api/v1/wallet/balance
 * Returns driver's prepaid wallet balance + today's stats
 * New system: Admin recharges wallet, commission deducted per ride (13%)
 */
const getBalance = async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows } = await query(
      `SELECT
         dp.wallet_balance,
         dp.total_recharged,
         dp.total_commission_paid,
         dp.car_plate,
         dp.cliq_alias,
         -- Today's stats from transactions
         COALESCE(SUM(CASE WHEN t.type = 'admin_recharge'
           AND DATE(t.created_at) = CURRENT_DATE THEN t.amount ELSE 0 END), 0) AS today_recharged,
         COALESCE(SUM(CASE WHEN t.type = 'commission_deduction'
           AND DATE(t.created_at) = CURRENT_DATE THEN t.amount ELSE 0 END), 0) AS today_commission,
         -- Today's ride count
         (SELECT COUNT(*) FROM rides r
          WHERE r.driver_id = $1
          AND DATE(r.completed_at) = CURRENT_DATE
          AND r.status = 'completed') AS today_rides
       FROM driver_profiles dp
       LEFT JOIN transactions t ON t.user_id = $1
       WHERE dp.user_id = $1
       GROUP BY dp.wallet_balance, dp.total_recharged, dp.total_commission_paid,
                dp.car_plate, dp.cliq_alias`,
      [userId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Driver profile not found' });
    }

    const data = rows[0];

    return res.json({
      walletBalance: parseFloat(data.wallet_balance).toFixed(2),
      totalRecharged: parseFloat(data.total_recharged).toFixed(2),
      totalCommissionPaid: parseFloat(data.total_commission_paid).toFixed(2),
      carPlate: data.car_plate,
      cliqAlias: data.cliq_alias,
      today: {
        rides: parseInt(data.today_rides),
        recharged: parseFloat(data.today_recharged).toFixed(2),
        commission: parseFloat(data.today_commission).toFixed(2),
      },
      // Warning: balance < 3 JOD
      lowBalanceWarning: parseFloat(data.wallet_balance) < 3.0,
    });
  } catch (err) {
    logger.error('getBalance error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
};

/**
 * GET /api/v1/wallet/transactions
 * Returns paginated wallet transaction history (recharges + commissions)
 */
const getTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const offset = (page - 1) * limit;
    const userId = req.user.id;

    const typeFilter = type && ['admin_recharge', 'commission_deduction'].includes(type)
      ? `AND t.type = $4`
      : '';

    const params = typeFilter
      ? [userId, parseInt(limit), parseInt(offset), type]
      : [userId, parseInt(limit), parseInt(offset)];

    const { rows } = await query(
      `SELECT
         t.id, t.type, t.amount, t.balance_after,
         t.description, t.description_ar,
         t.created_at,
         t.recharged_by,
         u_admin.full_name AS recharged_by_name,
         r.pickup_address, r.dropoff_address
       FROM transactions t
       LEFT JOIN rides r ON r.id = t.ride_id
       LEFT JOIN users u_admin ON u_admin.id = t.recharged_by
       WHERE t.user_id = $1 ${typeFilter}
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM transactions WHERE user_id = $1`,
      [userId]
    );

    return res.json({
      transactions: rows.map(t => ({
        id: t.id,
        type: t.type,
        amount: parseFloat(t.amount).toFixed(2),
        balanceAfter: parseFloat(t.balance_after).toFixed(2),
        description: t.description,
        descriptionAr: t.description_ar,
        createdAt: t.created_at,
        // For commissions: show ride addresses
        ridePickup: t.pickup_address,
        rideDropoff: t.dropoff_address,
        // For recharges: show admin name
        rechargedByName: t.recharged_by_name,
      })),
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    logger.error('getTransactions error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};

/**
 * POST /api/admin/wallet/recharge
 * Admin recharges a driver's prepaid wallet by car plate number
 * Body: { carPlate, amount, note? }
 */
const adminRechargeWallet = async (req, res) => {
  try {
    const { carPlate, amount, note } = req.body;
    const adminId = req.user.id;

    if (!carPlate || !amount) {
      return res.status(400).json({ error: 'carPlate and amount are required' });
    }

    const rechargeAmount = parseFloat(amount);
    if (rechargeAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Find driver by car plate
    const { rows: driverRows } = await query(
      `SELECT dp.user_id, dp.wallet_balance, dp.total_recharged, u.full_name
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.car_plate = $1 AND dp.approval_status = 'approved'`,
      [carPlate.trim().toUpperCase()]
    );

    if (!driverRows[0]) {
      return res.status(404).json({
        error: 'Driver not found or not approved',
        error_ar: 'الكابتن غير موجود أو غير معتمد',
      });
    }

    const driver = driverRows[0];
    const newBalance = parseFloat(driver.wallet_balance) + rechargeAmount;
    const newTotalRecharged = parseFloat(driver.total_recharged) + rechargeAmount;

    // Atomic: update balance + insert transaction
    await query('BEGIN');

    try {
      // Update driver wallet balance
      await query(
        `UPDATE driver_profiles
         SET wallet_balance = $1, total_recharged = $2
         WHERE user_id = $3`,
        [newBalance.toFixed(2), newTotalRecharged.toFixed(2), driver.user_id]
      );

      // Record transaction
      await query(
        `INSERT INTO transactions
           (user_id, type, amount, balance_after, description, description_ar, recharged_by)
         VALUES ($1, 'admin_recharge', $2, $3, $4, $5, $6)`,
        [
          driver.user_id,
          rechargeAmount.toFixed(2),
          newBalance.toFixed(2),
          note || `Admin recharge for plate ${carPlate}`,
          note || `شحن رصيد للوحة ${carPlate}`,
          adminId,
        ]
      );

      // Audit log
      await query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
         VALUES ($1, 'wallet_recharge', 'driver', $2, $3)`,
        [
          adminId,
          driver.user_id,
          JSON.stringify({
            carPlate,
            amount: rechargeAmount,
            newBalance,
            note,
          }),
        ]
      );

      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }

    logger.info(`💰 Admin recharged ${rechargeAmount} JOD for plate ${carPlate} (driver: ${driver.full_name})`);

    return res.json({
      success: true,
      driverName: driver.full_name,
      carPlate,
      recharged: rechargeAmount.toFixed(2),
      newBalance: newBalance.toFixed(2),
      message: `Successfully recharged ${rechargeAmount} JOD for plate ${carPlate}`,
      message_ar: `تم شحن ${rechargeAmount} دينار لسيارة ${carPlate} بنجاح`,
    });
  } catch (err) {
    logger.error('adminRechargeWallet error:', err.message);
    return res.status(500).json({ error: 'Wallet recharge failed' });
  }
};

/**
 * GET /api/admin/wallet/balances
 * Admin view: all drivers with their wallet balances and plate numbers
 */
const adminGetAllBalances = async (req, res) => {
  try {
    const { page = 1, limit = 50, lowBalance } = req.query;
    const offset = (page - 1) * limit;

    const lowBalanceFilter = lowBalance === 'true' ? 'AND dp.wallet_balance < 5' : '';

    const { rows } = await query(
      `SELECT
         u.id, u.full_name, u.phone,
         dp.car_plate, dp.car_type, dp.car_model,
         dp.wallet_balance, dp.total_recharged, dp.total_commission_paid,
         dp.is_online, dp.approval_status,
         -- Last recharge date
         (SELECT MAX(created_at) FROM transactions t
          WHERE t.user_id = dp.user_id AND t.type = 'admin_recharge') AS last_recharged_at
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.approval_status = 'approved' ${lowBalanceFilter}
       ORDER BY dp.wallet_balance ASC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM driver_profiles WHERE approval_status = 'approved' ${lowBalanceFilter}`
    );

    return res.json({
      drivers: rows.map(d => ({
        id: d.id,
        name: d.full_name,
        phone: d.phone,
        carPlate: d.car_plate,
        carType: d.car_type,
        carModel: d.car_model,
        walletBalance: parseFloat(d.wallet_balance).toFixed(2),
        totalRecharged: parseFloat(d.total_recharged).toFixed(2),
        totalCommissionPaid: parseFloat(d.total_commission_paid).toFixed(2),
        isOnline: d.is_online,
        lastRechargedAt: d.last_recharged_at,
        lowBalance: parseFloat(d.wallet_balance) < 3.0,
      })),
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    logger.error('adminGetAllBalances error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch driver balances' });
  }
};

/**
 * GET /api/admin/wallet/history/:driverId
 * Admin view: recharge + commission history for a specific driver
 */
const adminGetDriverHistory = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { page = 1, limit = 30 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await query(
      `SELECT
         t.id, t.type, t.amount, t.balance_after,
         t.description, t.description_ar, t.created_at,
         u_admin.full_name AS recharged_by_name,
         r.pickup_address, r.dropoff_address
       FROM transactions t
       LEFT JOIN users u_admin ON u_admin.id = t.recharged_by
       LEFT JOIN rides r ON r.id = t.ride_id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [driverId, parseInt(limit), parseInt(offset)]
    );

    return res.json({ transactions: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('adminGetDriverHistory error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch driver history' });
  }
};

module.exports = {
  getBalance,
  getTransactions,
  adminRechargeWallet,
  adminGetAllBalances,
  adminGetDriverHistory,
};
