/**
 * EVO Real-Time Sync Engine
 * The Heartbeat System — Zero-Lag Driver ↔ Passenger Location Sync
 *
 * Architecture:
 * Driver GPS → Socket.io → Redis Pub/Sub channel (ride:{id}:location)
 * → Passenger subscribes → Animated marker update
 * Latency target: < 200ms end-to-end
 */

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const {
  setDriverLocation,
  getDriverLocation,
  setDriverOnline,
  setDriverOffline,
  publishDriverLocation,
  getRedisSub,
} = require('../config/redis');
const {
  isValidLocationUpdate,
  isWithinArrivalDistance,
} = require('../utils/fareCalculator');
const { notify } = require('../config/onesignal');
const logger = require('../utils/logger');

// Track which socket is subscribed to which Redis channel
const socketRideChannels = new Map(); // socketId → channelName

const initSocket = (io) => {
  // Authenticate every socket connection with JWT
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query(
        'SELECT id, role, status, onesignal_player_id FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (!rows[0] || rows[0].status === 'suspended') {
        return next(new Error('Account not authorized'));
      }

      socket.user = rows[0];
      logger.info(`🔌 Socket connected: ${socket.user.role} ${socket.user.id.slice(0, 8)}`);
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id: userId, role } = socket.user;

    // ────────────────────────────────────────────
    // DRIVER EVENTS
    // ────────────────────────────────────────────
    if (role === 'driver') {
      /**
       * Driver goes online
       * Payload: { carType }
       */
      socket.on('driver:go-online', async ({ carType }) => {
        try {
          await setDriverOnline(userId, carType);
          await query(
            'UPDATE driver_profiles SET is_online = true, last_location_update = NOW() WHERE user_id = $1',
            [userId]
          );
          socket.emit('driver:status', { online: true });
          logger.info(`🟢 Driver online: ${userId.slice(0, 8)}`);
        } catch (err) {
          logger.error('driver:go-online error:', err.message);
        }
      });

      /**
       * Driver goes offline
       */
      socket.on('driver:go-offline', async () => {
        try {
          await setDriverOffline(userId);
          await query(
            'UPDATE driver_profiles SET is_online = false WHERE user_id = $1',
            [userId]
          );
          socket.emit('driver:status', { online: false });
          logger.info(`🔴 Driver offline: ${userId.slice(0, 8)}`);
        } catch (err) {
          logger.error('driver:go-offline error:', err.message);
        }
      });

      /**
       * Driver location update — THE CORE OF ZERO-LAG SYNC
       * Payload: { lat, lng, heading, speed, rideId? }
       * Emitted every 5s (in-ride: every 3s)
       */
      socket.on('driver:location-update', async ({ lat, lng, heading, speed, rideId }) => {
        try {
          const now = Date.now();
          const locationData = { lat, lng, heading, speed, timestamp: now, driverId: userId };

          // Validate: reject GPS spoofing / impossible jumps
          const prevLocation = await getDriverLocation(userId);
          if (prevLocation) {
            const valid = isValidLocationUpdate(
              prevLocation.lat, prevLocation.lng, prevLocation.timestamp,
              lat, lng, now
            );
            if (!valid) {
              logger.warn(`🚨 GPS spoof attempt from driver ${userId.slice(0, 8)}`);
              return;
            }
          }

          // Cache driver location in Redis (TTL: 2 min)
          await setDriverLocation(userId, locationData);

          // Update DB (less frequently — every 30s via batching would be ideal,
          // but here we update directly for MVP simplicity)
          await query(
            `UPDATE driver_profiles
             SET current_lat = $1, current_lng = $2, current_heading = $3, last_location_update = NOW()
             WHERE user_id = $4`,
            [lat, lng, heading || 0, userId]
          );

          // If driver is on an active ride → publish to Redis Pub/Sub channel
          if (rideId) {
            await publishDriverLocation(rideId, locationData);

            // Check if driver arrived at pickup (< 50m)
            const { rows: rideRows } = await query(
              `SELECT status, pickup_lat, pickup_lng, passenger_id,
                      u.onesignal_player_id
               FROM rides r
               JOIN users u ON u.id = r.passenger_id
               WHERE r.id = $1 AND r.driver_id = $2`,
              [rideId, userId]
            );

            const ride = rideRows[0];
            if (ride?.status === 'arriving') {
              const arrived = isWithinArrivalDistance(lat, lng, ride.pickup_lat, ride.pickup_lng);
              if (arrived) {
                // Update ride status → 'arrived'
                await query(
                  `UPDATE rides SET status = 'arrived', arrived_at = NOW() WHERE id = $1`,
                  [rideId]
                );

                // Notify passenger via Socket.io (real-time) + OneSignal (push)
                io.to(`passenger:${ride.passenger_id}`).emit('driver:arrived', { rideId });
                if (ride.onesignal_player_id) {
                  await notify.driverArrived(ride.onesignal_player_id);
                }

                // Notify driver app
                socket.emit('ride:status-changed', { rideId, status: 'arrived' });

                logger.info(`📍 Driver arrived for ride ${rideId.slice(0, 8)}`);
              }
            }
          }
        } catch (err) {
          logger.error('driver:location-update error:', err.message);
        }
      });
    }

    // ────────────────────────────────────────────
    // PASSENGER EVENTS
    // ────────────────────────────────────────────
    if (role === 'passenger') {
      /**
       * Passenger subscribes to driver location for a specific ride
       * Payload: { rideId }
       */
      socket.on('passenger:track-ride', async ({ rideId }) => {
        try {
          // Verify passenger owns this ride
          const { rows } = await query(
            'SELECT id FROM rides WHERE id = $1 AND passenger_id = $2',
            [rideId, userId]
          );
          if (!rows[0]) {
            return socket.emit('error', { message: 'Ride not found' });
          }

          // Join personal room for targeted events
          socket.join(`passenger:${userId}`);

          // Subscribe to Redis Pub/Sub channel for this ride
          const channel = `ride:${rideId}:location`;
          const redisSub = getRedisSub();

          redisSub.subscribe(channel, (err) => {
            if (err) {
              logger.error('Redis subscribe error:', err.message);
              return;
            }
            logger.info(`👁️ Passenger ${userId.slice(0, 8)} tracking ride ${rideId.slice(0, 8)}`);
          });

          // Forward Redis messages to this specific passenger socket
          redisSub.on('message', (ch, message) => {
            if (ch === channel) {
              const locationData = JSON.parse(message);
              socket.emit('driver:location', locationData);
            }
          });

          // Track channel for cleanup on disconnect
          socketRideChannels.set(socket.id, { channel, redisSub });
        } catch (err) {
          logger.error('passenger:track-ride error:', err.message);
        }
      });
    }

    // ────────────────────────────────────────────
    // SHARED EVENTS
    // ────────────────────────────────────────────

    // Join personal notification room (both passenger and driver)
    socket.join(`user:${userId}`);
    socket.join(`${role}:${userId}`);

    socket.on('disconnect', async (reason) => {
      logger.info(`🔌 Socket disconnected: ${role} ${userId.slice(0, 8)} (${reason})`);

      // Clean up Redis subscription
      const trackingInfo = socketRideChannels.get(socket.id);
      if (trackingInfo) {
        trackingInfo.redisSub.unsubscribe(trackingInfo.channel).catch(() => {});
        socketRideChannels.delete(socket.id);
      }

      // Mark driver offline if disconnected unexpectedly
      if (role === 'driver') {
        await setDriverOffline(userId).catch(() => {});
        await query(
          'UPDATE driver_profiles SET is_online = false WHERE user_id = $1',
          [userId]
        ).catch(() => {});
      }
    });
  });

  logger.info('⚡ Socket.io real-time engine initialized');
  return io;
};

/**
 * Send a ride request to a driver via Socket.io
 * Called from the ride matching service
 */
const sendRideRequestToDriver = (io, driverUserId, rideData) => {
  io.to(`driver:${driverUserId}`).emit('ride:new-request', rideData);
};

/**
 * Notify passenger that driver accepted their ride
 */
const notifyPassengerDriverAccepted = (io, passengerUserId, rideData) => {
  io.to(`passenger:${passengerUserId}`).emit('driver:accepted', rideData);
};

/**
 * Broadcast ride status change to both driver and passenger
 */
const broadcastRideStatus = (io, passengerUserId, driverUserId, status, extra = {}) => {
  const payload = { status, ...extra };
  io.to(`passenger:${passengerUserId}`).emit('ride:status-changed', payload);
  if (driverUserId) {
    io.to(`driver:${driverUserId}`).emit('ride:status-changed', payload);
  }
};

module.exports = { initSocket, sendRideRequestToDriver, notifyPassengerDriverAccepted, broadcastRideStatus };
