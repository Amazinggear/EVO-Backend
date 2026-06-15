const { query } = require('../config/database');
const { getOnlineDrivers, getDriverLocation } = require('../config/redis');
const { calculateFare, haversineDistance } = require('../utils/fareCalculator');
const { sendRideRequestToDriver, notifyPassengerDriverAccepted, broadcastRideStatus } = require('../socket/socketEngine');
const { notify } = require('../config/onesignal');
const logger = require('../utils/logger');

let ioInstance; // Set from server.js

const setIo = (io) => { ioInstance = io; };

/**
 * GET /api/v1/rides/nearby-drivers
 * Find online drivers within 5km radius of pickup point
 */
const getNearbyDrivers = async (req, res) => {
  try {
    const { lat, lng, carType, radius = 5 } = req.query;

    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    // Get all online driver IDs from Redis
    const onlineDriverIds = await getOnlineDrivers();
    if (onlineDriverIds.length === 0) return res.json({ drivers: [], count: 0 });

    // Get their locations from Redis cache
    const driversWithLocation = [];
    for (const driverId of onlineDriverIds) {
      const location = await getDriverLocation(driverId);
      if (!location) continue;

      const distanceKm = haversineDistance(
        parseFloat(lat), parseFloat(lng),
        location.lat, location.lng
      );

      if (distanceKm <= parseFloat(radius)) {
        driversWithLocation.push({ driverId, ...location, distanceKm: parseFloat(distanceKm.toFixed(2)) });
      }
    }

    // Fetch driver profile details from DB
    if (driversWithLocation.length === 0) return res.json({ drivers: [], count: 0 });

    const driverIds = driversWithLocation.map(d => d.driverId);
    const placeholders = driverIds.map((_, i) => `$${i + 1}`).join(',');

    const { rows: profiles } = await query(
      `SELECT dp.user_id, dp.car_type, dp.car_model, dp.car_image_url, dp.rating, dp.total_rides,
              u.full_name
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.user_id IN (${placeholders}) AND dp.approval_status = 'approved'
       ${carType ? `AND dp.car_type = '${carType}'` : ''}`,
      driverIds
    );

    const profileMap = Object.fromEntries(profiles.map(p => [p.user_id, p]));

    const result = driversWithLocation
      .filter(d => profileMap[d.driverId])
      .map(d => ({
        ...profileMap[d.driverId],
        lat: d.lat,
        lng: d.lng,
        heading: d.heading,
        distanceKm: d.distanceKm,
        etaMin: Math.ceil((d.distanceKm / 30) * 60), // rough ETA at 30km/h avg speed
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return res.json({ drivers: result, count: result.length });
  } catch (err) {
    logger.error('getNearbyDrivers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch nearby drivers' });
  }
};

/**
 * POST /api/v1/rides/estimate
 * Calculate fare estimate for a route
 */
const estimateFare = async (req, res) => {
  try {
    const { carType, distanceKm, durationMin, pickupLat, pickupLng, promoCode } = req.body;

    // Get active pricing from DB (may have been updated by admin)
    const { rows: pricingRows } = await query(
      'SELECT * FROM pricing_config WHERE car_type = $1 AND is_active = true',
      [carType]
    );
    const pricingConfig = pricingRows[0] || null;

    // Check for surge zone
    let surgeMultiplier = 1.0;
    if (pickupLat && pickupLng) {
      const { rows: surgeRows } = await query(
        `SELECT surge_multiplier FROM surge_zones
         WHERE is_active = true
           AND (active_from IS NULL OR active_from <= NOW())
           AND (active_until IS NULL OR active_until >= NOW())
           AND ST_Contains(polygon::geometry, ST_Point($1, $2))
         ORDER BY surge_multiplier DESC LIMIT 1`,
        [pickupLng, pickupLat]
      );
      if (surgeRows[0]) surgeMultiplier = parseFloat(surgeRows[0].surge_multiplier);
    }

    // Validate promo code if provided
    let promoData = null;
    if (promoCode) {
      const { rows: promoRows } = await query(
        `SELECT * FROM promo_codes
         WHERE code = $1 AND is_active = true
           AND valid_from <= NOW() AND valid_until >= NOW()
           AND (max_total_uses IS NULL OR current_total_uses < max_total_uses)`,
        [promoCode.toUpperCase()]
      );

      if (promoRows[0]) {
        const promo = promoRows[0];
        // Check car type restriction
        if (promo.applicable_car_types && !promo.applicable_car_types.includes(carType)) {
          return res.json({ promoError: 'This code is not valid for the selected car type' });
        }
        // Check per-user limit
        const { rows: usageRows } = await query(
          `SELECT COUNT(*) FROM promo_code_usages WHERE promo_code_id = $1 AND user_id = $2`,
          [promo.id, req.user.id]
        );
        if (parseInt(usageRows[0].count) >= promo.max_per_user) {
          return res.json({ promoError: 'You have already used this code' });
        }
        promoData = {
          id: promo.id,
          code: promo.code,
          discountType: promo.discount_type,
          discountValue: parseFloat(promo.discount_value),
          maxDiscountJod: promo.max_discount_jod ? parseFloat(promo.max_discount_jod) : null,
          minFareJod: parseFloat(promo.min_fare_jod),
        };
      } else {
        return res.json({ promoError: 'Invalid or expired promo code' });
      }
    }

    // Calculate fare
    const fareBreakdown = calculateFare({
      carType,
      distanceKm: parseFloat(distanceKm),
      durationMin: parseFloat(durationMin),
      surgeMultiplier,
      promoCode: promoData,
      pricingConfig: pricingConfig ? {
        baseFare: parseFloat(pricingConfig.base_fare),
        perKmRate: parseFloat(pricingConfig.per_km_rate),
        perMinRate: parseFloat(pricingConfig.per_min_rate),
        minFare: parseFloat(pricingConfig.min_fare),
        commissionPct: parseFloat(pricingConfig.commission_pct),
        co2Factor: 0.21,
      } : null,
    });

    return res.json({
      ...fareBreakdown,
      surgeActive: surgeMultiplier > 1.0,
      promoApplied: promoData ? promoData.code : null,
    });
  } catch (err) {
    logger.error('estimateFare error:', err.message);
    return res.status(500).json({ error: 'Failed to calculate fare' });
  }
};

/**
 * POST /api/v1/rides/request
 * Request a ride — find nearest driver and send request
 */
const requestRide = async (req, res) => {
  try {
    const {
      carType,
      pickupLat, pickupLng, pickupAddress, pickupAddressAr,
      dropoffLat, dropoffLng, dropoffAddress, dropoffAddressAr,
      distanceKm, durationMin, promoCodeId,
      subtotal, discountAmount, totalFare, co2SavedKg,
      surgeMultiplier = 1.0,
      baseFare, perKmRate, perMinRate,
      tariffType, // 'day' | 'night' — for ev_taxi only
    } = req.body;

    // Payment is ALWAYS cash in new model
    const paymentMethod = 'cash';
    const passengerId = req.user.id;

    const { rows } = await query(
      `INSERT INTO rides (
        passenger_id, pickup_lat, pickup_lng, pickup_address, pickup_address_ar,
        dropoff_lat, dropoff_lng, dropoff_address, dropoff_address_ar,
        car_type, payment_method, status,
        distance_km, duration_min, base_fare, per_km_rate, per_min_rate,
        surge_multiplier, subtotal, promo_code_id, discount_amount, total_fare, co2_saved_kg,
        tariff_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'cash','searching',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING id`,
      [
        passengerId, pickupLat, pickupLng, pickupAddress, pickupAddressAr,
        dropoffLat, dropoffLng, dropoffAddress, dropoffAddressAr,
        carType,
        distanceKm, durationMin, baseFare, perKmRate, perMinRate,
        surgeMultiplier, subtotal, promoCodeId || null, discountAmount || 0, totalFare, co2SavedKg,
        tariffType || null,
      ]
    );

    const rideId = rows[0].id;

    // Find nearest available driver
    const onlineDriverIds = await getOnlineDrivers();
    let nearestDriver = null;
    let minDistance = Infinity;

    // Define primary and fallback categories for this request
    const primaryCategories = [carType];
    let fallbackCategories = [];

    if (carType === 'ev_mini') {
      fallbackCategories = ['ev_sedan', 'ev_taxi', 'ev_suv'];
    } else if (carType === 'ev_sedan') {
      fallbackCategories = ['ev_taxi', 'ev_suv'];
    }

    // Step 1: Search in primary categories first
    for (const driverId of onlineDriverIds) {
      const loc = await getDriverLocation(driverId);
      if (!loc) continue;

      const { rows: driverRows } = await query(
        `SELECT dp.user_id, dp.wallet_balance, dp.car_type, u.onesignal_player_id FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         WHERE dp.user_id = $1 AND dp.car_type = ANY($2)
           AND dp.approval_status = 'approved'
           AND dp.wallet_balance >= 3.00`,
        [driverId, primaryCategories]
      );
      if (!driverRows[0]) continue;

      const dist = haversineDistance(pickupLat, pickupLng, loc.lat, loc.lng);
      if (dist < minDistance) {
        minDistance = dist;
        nearestDriver = { ...driverRows[0], lat: loc.lat, lng: loc.lng, distanceKm: dist };
      }
    }

    // Step 2: If no primary driver found, search in fallback categories (upgrade logic)
    if (!nearestDriver && fallbackCategories.length > 0) {
      minDistance = Infinity;
      for (const driverId of onlineDriverIds) {
        const loc = await getDriverLocation(driverId);
        if (!loc) continue;

        const { rows: driverRows } = await query(
          `SELECT dp.user_id, dp.wallet_balance, dp.car_type, u.onesignal_player_id FROM driver_profiles dp
           JOIN users u ON u.id = dp.user_id
           WHERE dp.user_id = $1 AND dp.car_type = ANY($2)
             AND dp.approval_status = 'approved'
             AND dp.wallet_balance >= 3.00`,
          [driverId, fallbackCategories]
        );
        if (!driverRows[0]) continue;

        const dist = haversineDistance(pickupLat, pickupLng, loc.lat, loc.lng);
        if (dist < minDistance) {
          minDistance = dist;
          nearestDriver = { ...driverRows[0], lat: loc.lat, lng: loc.lng, distanceKm: dist };
        }
      }
    }

    if (!nearestDriver) {
      // No driver available — update ride status
      await query(`UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE id = $1`, [rideId]);
      return res.status(404).json({
        error: 'No drivers available nearby. Please try again.',
        error_ar: 'لا يوجد كباتن متاحون قريبين. يرجى المحاولة مجدداً.',
      });
    }

    // Send ride request to driver via Socket.io
    if (ioInstance) {
      sendRideRequestToDriver(ioInstance, nearestDriver.user_id, {
        rideId,
        pickupLat, pickupLng, pickupAddress, pickupAddressAr,
        dropoffLat, dropoffLng, dropoffAddress, dropoffAddressAr,
        carType, totalFare, distanceKm, durationMin,
        passengerName: req.user.full_name,
      });
    }

    return res.status(201).json({
      success: true,
      rideId,
      status: 'searching',
      message: 'Ride requested. Waiting for driver...',
      message_ar: 'تم إرسال طلب الرحلة. بانتظار الكابتن...',
    });
  } catch (err) {
    logger.error('requestRide error:', err.message);
    return res.status(500).json({ error: 'Failed to request ride' });
  }
};

/**
 * PATCH /api/v1/rides/:id/accept (Driver)
 */
const acceptRide = async (req, res) => {
  try {
    const { id: rideId } = req.params;
    const driverId = req.user.id;

    const { rows } = await query(
      `UPDATE rides SET driver_id = $1, status = 'accepted', accepted_at = NOW()
       WHERE id = $2 AND status = 'searching'
       RETURNING passenger_id, pickup_lat, pickup_lng, pickup_address, car_type, total_fare`,
      [driverId, rideId]
    );

    if (!rows[0]) return res.status(409).json({ error: 'Ride no longer available' });

    const ride = rows[0];

    // Get driver info to send to passenger
    const { rows: driverRows } = await query(
      `SELECT dp.car_model, dp.car_plate, dp.car_type, dp.rating, dp.car_image_url,
              u.full_name, u.onesignal_player_id
       FROM driver_profiles dp JOIN users u ON u.id = dp.user_id WHERE dp.user_id = $1`,
      [driverId]
    );

    const driverLoc = await getDriverLocation(driverId);

    // Notify passenger via Socket.io
    if (ioInstance) {
      notifyPassengerDriverAccepted(ioInstance, ride.passenger_id, {
        rideId,
        driver: { ...driverRows[0], ...driverLoc },
        status: 'accepted',
      });
    }

    // Update ride status to arriving
    await query(`UPDATE rides SET status = 'arriving' WHERE id = $1`, [rideId]);

    return res.json({ success: true, rideId, status: 'arriving' });
  } catch (err) {
    logger.error('acceptRide error:', err.message);
    return res.status(500).json({ error: 'Failed to accept ride' });
  }
};

/**
 * PATCH /api/v1/rides/:id/start (Driver)
 */
const startRide = async (req, res) => {
  try {
    const { id: rideId } = req.params;
    const driverId = req.user.id;

    const { rows } = await query(
      `UPDATE rides SET status = 'in_progress', started_at = NOW()
       WHERE id = $1 AND driver_id = $2 AND status = 'arrived'
       RETURNING passenger_id`,
      [rideId, driverId]
    );

    if (!rows[0]) return res.status(409).json({ error: 'Cannot start ride in current state' });

    if (ioInstance) {
      broadcastRideStatus(ioInstance, rows[0].passenger_id, driverId, 'in_progress', { rideId });
    }

    return res.json({ success: true, status: 'in_progress' });
  } catch (err) {
    logger.error('startRide error:', err.message);
    return res.status(500).json({ error: 'Failed to start ride' });
  }
};

/**
 * PATCH /api/v1/rides/:id/complete (Driver)
 * Prepaid system:
 *   - Driver collects cash directly from passenger
 *   - We deduct 13% commission from driver's prepaid wallet_balance
 *   - Record as 'commission_deduction' transaction
 */
const completeRide = async (req, res) => {
  try {
    const { id: rideId } = req.params;
    const driverId = req.user.id;

    const { rows } = await query(
      `UPDATE rides
       SET status = 'completed', completed_at = NOW(), commission_deducted = true
       WHERE id = $1 AND driver_id = $2 AND status = 'in_progress'
       RETURNING *`,
      [rideId, driverId]
    );

    if (!rows[0]) return res.status(409).json({ error: 'Cannot complete ride in current state' });

    const ride = rows[0];

    // Get pricing config for commission (unified 13%)
    const { rows: pricing } = await query(
      'SELECT commission_pct FROM pricing_config WHERE car_type = $1',
      [ride.car_type]
    );
    const commissionPct = pricing[0] ? parseFloat(pricing[0].commission_pct) : 13;
    
    // Subtotal is the full fare before promo. Discount is the promo amount.
    // Driver gets 100% of subtotal minus commissionPct.
    // So app commission is (subtotal * commissionPct) - discount_amount
    const subtotal = ride.subtotal ? parseFloat(ride.subtotal) : parseFloat(ride.total_fare);
    const discountAmount = ride.discount_amount ? parseFloat(ride.discount_amount) : 0;
    
    const baseCommission = parseFloat((subtotal * commissionPct / 100).toFixed(2));
    const commission = parseFloat((baseCommission - discountAmount).toFixed(2));

    // Get current driver wallet balance
    const { rows: walletRows } = await query(
      'SELECT wallet_balance, total_commission_paid FROM driver_profiles WHERE user_id = $1',
      [driverId]
    );
    const currentBalance = parseFloat(walletRows[0].wallet_balance);
    const newBalance = parseFloat((currentBalance - commission).toFixed(2));
    const newTotalCommission = parseFloat(
      ((parseFloat(walletRows[0].total_commission_paid) || 0) + commission).toFixed(2)
    );

    await query('BEGIN');
    try {
      // Deduct commission from prepaid wallet
      await query(
        `UPDATE driver_profiles
         SET wallet_balance = $1, total_commission_paid = $2,
             total_rides = total_rides + 1
         WHERE user_id = $3`,
        [newBalance, newTotalCommission, driverId]
      );

      // Record commission deduction transaction
      await query(
        `INSERT INTO transactions
           (user_id, ride_id, type, amount, balance_after, description, description_ar)
         VALUES ($1, $2, 'commission_deduction', $3, $4,
           'EVO commission 13%', 'عمولة EVO 13%')`,
        [driverId, rideId, commission, newBalance]
      );

      // Update ride commission_amount
      await query(
        'UPDATE rides SET commission_amount = $1 WHERE id = $2',
        [commission, rideId]
      );

      await query('COMMIT');
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }

    // Notify passenger via OneSignal + Socket.io
    const { rows: passengerRows } = await query(
      'SELECT onesignal_player_id FROM users WHERE id = $1',
      [ride.passenger_id]
    );
    if (passengerRows[0]?.onesignal_player_id) {
      await notify.rideCompleted(
        passengerRows[0].onesignal_player_id,
        ride.total_fare,
        ride.co2_saved_kg
      );
    }

    if (ioInstance) {
      broadcastRideStatus(ioInstance, ride.passenger_id, driverId, 'completed', {
        rideId,
        totalFare: ride.total_fare,
        co2SavedKg: ride.co2_saved_kg,
        paymentMethod: 'cash',
      });
    }

    logger.info(`✅ Ride ${rideId} completed. Commission deducted: ${commission} JOD from driver ${driverId} (new balance: ${newBalance} JOD)`);

    return res.json({
      success: true,
      status: 'completed',
      totalFare: ride.total_fare,
      commission,
      newWalletBalance: newBalance,
      co2SavedKg: ride.co2_saved_kg,
      // Driver collects cash from passenger, commission auto-deducted from wallet
      message_ar: `اكتملت الرحلة. تم خصم ${commission} د.أ عمولة من محفظتك. رصيدك: ${newBalance} د.أ`,
    });
  } catch (err) {
    logger.error('completeRide error:', err.message);
    return res.status(500).json({ error: 'Failed to complete ride' });
  }
};

/**
 * GET /api/v1/rides/history
 */
const getRideHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const userId = req.user.id;
    const role = req.user.role;

    const field = role === 'driver' ? 'driver_id' : 'passenger_id';

    const { rows } = await query(
      `SELECT r.id, r.status, r.car_type, r.pickup_address, r.pickup_address_ar,
              r.dropoff_address, r.dropoff_address_ar,
              r.total_fare, r.co2_saved_kg, r.distance_km, r.duration_min,
              r.payment_method, r.created_at, r.completed_at,
              u.full_name as other_party_name
       FROM rides r
       JOIN users u ON u.id = ${role === 'driver' ? 'r.passenger_id' : 'r.driver_id'}
       WHERE r.${field} = $1 AND r.status IN ('completed', 'cancelled')
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({ rides: rows, page, limit });
  } catch (err) {
    logger.error('getRideHistory error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch ride history' });
  }
};

module.exports = { setIo, getNearbyDrivers, estimateFare, requestRide, acceptRide, startRide, completeRide, getRideHistory };
