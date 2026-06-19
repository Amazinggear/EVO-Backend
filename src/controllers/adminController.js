const { query } = require('../config/database');
const { getOnlineDrivers, getDriverLocation } = require('../config/redis');
const logger = require('../utils/logger');

const getDashboardStats = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM rides WHERE DATE(created_at) = CURRENT_DATE) AS rides_today,
        (SELECT COUNT(*) FROM rides WHERE DATE(created_at) = CURRENT_DATE AND status = 'completed') AS completed_today,
        (SELECT COALESCE(SUM(total_fare), 0) FROM rides WHERE DATE(created_at) = CURRENT_DATE AND status = 'completed') AS revenue_today,
        (SELECT COUNT(*) FROM users WHERE role = 'passenger') AS total_passengers,
        (SELECT COUNT(*) FROM users WHERE role = 'driver') AS total_drivers,
        (SELECT COUNT(*) FROM driver_profiles WHERE approval_status = 'pending') AS pending_approvals,
        (SELECT COUNT(*) FROM rides WHERE status IN ('searching','accepted','arriving','arrived','in_progress')) AS active_rides
    `);

    const onlineDrivers = await getOnlineDrivers();

    return res.json({ ...rows[0], online_drivers: onlineDrivers.length });
  } catch (err) {
    logger.error('getDashboardStats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

const listUsers = async (req, res) => {
  try {
    const { role, status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const values = [];
    let i = 1;

    if (role) { conditions.push(`role = $${i++}`); values.push(role); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (search) { conditions.push(`(full_name ILIKE $${i} OR phone ILIKE $${i})`); values.push(`%${search}%`); i++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT id, phone, full_name, email, role, admin_role, status, preferred_language, passenger_rating, cancellation_count, last_login_at, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    );

    const { rows: countRows } = await query(`SELECT COUNT(*) FROM users ${where}`, values);
    return res.json({ users: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
};

const getUserDetails = async (req, res) => {
  try {
    const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!userRows[0]) return res.status(404).json({ error: 'User not found' });

    let profile = null;
    let documents = [];
    if (userRows[0].role === 'driver') {
      const { rows: dpRows } = await query('SELECT * FROM driver_profiles WHERE user_id = $1', [req.params.id]);
      profile = dpRows[0];
      const { rows: docRows } = await query('SELECT * FROM driver_documents WHERE driver_user_id = $1', [req.params.id]);
      documents = docRows;
    }

    return res.json({ user: userRows[0], profile, documents });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;
    const validStatuses = ['active', 'suspended'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    await query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'user', $3, $4)`,
      [req.user.id, `${status}_user`, id, JSON.stringify({ status })]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update status' });
  }
};

const getDriverDocuments = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM driver_documents WHERE driver_user_id = $1',
      [req.params.id]
    );
    return res.json({ documents: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch documents' });
  }
};

const getLiveRides = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT r.id, r.status, r.car_type, r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng,
             r.pickup_address, r.dropoff_address, r.total_fare,
             pu.full_name as passenger_name, pu.phone as passenger_phone,
             r.driver_id, du.full_name as driver_name, du.phone as driver_phone,
             dp.current_lat as driver_lat, dp.current_lng as driver_lng,
             dp.car_model, dp.car_plate, r.accepted_at
      FROM rides r
      JOIN users pu ON pu.id = r.passenger_id
      LEFT JOIN users du ON du.id = r.driver_id
      LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id
      WHERE r.status IN ('searching','accepted','arriving','arrived','in_progress')
      ORDER BY r.created_at DESC
    `);

    // Enrich with Redis (live location)
    const enrichedRides = await Promise.all(rows.map(async (ride) => {
      if (ride.driver_id) {
        const liveLoc = await getDriverLocation(ride.driver_id).catch(() => null);
        if (liveLoc) {
          ride.driver_lat = parseFloat(liveLoc.lat);
          ride.driver_lng = parseFloat(liveLoc.lng);
          ride.driver_heading = parseFloat(liveLoc.heading) || 0;
        }
      }
      return ride;
    }));

    // Get all online drivers from Redis
    const onlineDriverIds = await getOnlineDrivers();
    const onlineDrivers = [];

    if (onlineDriverIds.length > 0) {
      const placeholders = onlineDriverIds.map((_, idx) => `$${idx + 1}`).join(',');
      const { rows: profiles } = await query(
        `SELECT dp.user_id as id, dp.car_type, dp.car_model, dp.car_plate, dp.rating, dp.wallet_balance, dp.total_rides,
                u.full_name as name, u.phone
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         WHERE dp.user_id IN (${placeholders})`,
        onlineDriverIds
      );

      for (const p of profiles) {
        const loc = await getDriverLocation(p.id).catch(() => null);
        const activeRide = enrichedRides.find(r => r.driver_id === p.id);

        onlineDrivers.push({
          id: p.id,
          name: p.name,
          phone: p.phone,
          carType: p.car_type,
          carPlate: p.car_plate,
          lat: loc ? parseFloat(loc.lat) : 31.9539,
          lng: loc ? parseFloat(loc.lng) : 35.9106,
          heading: loc ? parseFloat(loc.heading) || 0 : 0,
          speed: loc ? parseFloat(loc.speed) || 0 : 0,
          status: activeRide ? (activeRide.status === 'in_progress' ? 'in_ride' : 'arriving') : 'online',
          walletBalance: parseFloat(p.wallet_balance) || 0,
          rideId: activeRide ? activeRide.id : undefined,
          lastSeen: 'نشط الآن',
        });
      }
    }

    return res.json({ rides: enrichedRides, drivers: onlineDrivers, count: enrichedRides.length });
  } catch (err) {
    logger.error('getLiveRides error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch live rides' });
  }
};

const getPricing = async (req, res) => {
  const { rows } = await query('SELECT * FROM pricing_config ORDER BY car_type');
  return res.json({ pricing: rows });
};

const updatePricing = async (req, res) => {
  try {
    const { carType } = req.params;
    const { baseFare, perKmRate, perMinRate, minFare, commissionPct } = req.body;
    const { rows } = await query(
      `UPDATE pricing_config
       SET base_fare=$1, per_km_rate=$2, per_min_rate=$3, min_fare=$4,
           commission_pct=$5, updated_by=$6, updated_at=NOW()
       WHERE car_type=$7 RETURNING *`,
      [baseFare, perKmRate, perMinRate, minFare, commissionPct, req.user.id, carType]
    );
    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, details)
       VALUES ($1, 'update_pricing', 'pricing_config', $2)`,
      [req.user.id, JSON.stringify({ carType, baseFare, perKmRate, perMinRate, commissionPct })]
    );
    return res.json({ pricing: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update pricing' });
  }
};

const getSurgeZones = async (req, res) => {
  const { rows } = await query('SELECT id, zone_name, zone_name_ar, surge_multiplier, active_from, active_until, is_active FROM surge_zones ORDER BY created_at DESC');
  return res.json({ zones: rows });
};

const createSurgeZone = async (req, res) => {
  try {
    const { zoneName, zoneNameAr, polygonGeoJson, surgeMultiplier, activeFrom, activeUntil } = req.body;
    const { rows } = await query(
      `INSERT INTO surge_zones (zone_name, zone_name_ar, polygon, surge_multiplier, active_from, active_until, created_by)
       VALUES ($1, $2, ST_GeomFromGeoJSON($3), $4, $5, $6, $7) RETURNING id, zone_name, surge_multiplier`,
      [zoneName, zoneNameAr, JSON.stringify(polygonGeoJson), surgeMultiplier, activeFrom, activeUntil, req.user.id]
    );
    return res.status(201).json({ zone: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create surge zone' });
  }
};

const updateSurgeZone = async (req, res) => {
  try {
    const { isActive, surgeMultiplier, activeUntil } = req.body;
    const { id } = req.params;
    const updates = [];
    const values = [];
    let i = 1;

    if (isActive !== undefined) { updates.push(`is_active = $${i++}`); values.push(isActive); }
    if (surgeMultiplier) { updates.push(`surge_multiplier = $${i++}`); values.push(surgeMultiplier); }
    if (activeUntil) { updates.push(`active_until = $${i++}`); values.push(activeUntil); }

    values.push(id);
    const { rows } = await query(
      `UPDATE surge_zones SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ zone: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update surge zone' });
  }
};

const getFinancialSummary = async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = from && to ? `AND created_at BETWEEN '${from}' AND '${to}'` : '';

    const { rows } = await query(`
      SELECT
        COALESCE(SUM(CASE WHEN type='ride_payment' THEN amount ELSE 0 END), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN type='commission_deduction' THEN amount ELSE 0 END), 0) AS total_commission,
        COALESCE(SUM(CASE WHEN type='payout' THEN amount ELSE 0 END), 0) AS total_payouts,
        COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END), 0) AS total_refunds,
        COUNT(DISTINCT user_id) AS unique_earners
      FROM transactions WHERE 1=1 ${dateFilter}
    `);

    return res.json({ summary: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch financial summary' });
  }
};

const getAllTransactions = async (req, res) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const typeFilter = type ? `AND t.type = '${type}'` : '';

    const { rows } = await query(
      `SELECT t.*, u.full_name, u.phone, u.role FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE 1=1 ${typeFilter}
       ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ transactions: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};

const processPayouts = async (req, res) => {
  try {
    const { transactionIds } = req.body; // Array of transaction IDs to mark as processed
    // In production: integrate with banking API (Arab Bank / Jordan Ahli)
    // For MVP: mark as processed in DB
    await query(
      `UPDATE transactions SET reference = CONCAT('PROCESSED-', id::text)
       WHERE id = ANY($1::uuid[]) AND type = 'payout'`,
      [transactionIds]
    );
    return res.json({ success: true, processed: transactionIds.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process payouts' });
  }
};

const getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const { rows } = await query(
      `SELECT al.*, u.full_name as admin_name FROM admin_audit_logs al
       JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ logs: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
};

module.exports = {
  getDashboardStats, listUsers, getUserDetails, updateUserStatus, getDriverDocuments,
  getLiveRides, getPricing, updatePricing,
  getSurgeZones, createSurgeZone, updateSurgeZone,
  listPromoCodes: require('./promoController').listPromoCodes,
  createPromoCode: require('./promoController').createPromoCode,
  updatePromoCode: require('./promoController').updatePromoCode,
  deletePromoCode: require('./promoController').deletePromoCode,
  getFinancialSummary, getAllTransactions, processPayouts, getAuditLogs,
};
