// src/config/redis.js
// ══════════════════════════════════════════════════════════════════════════════
// EVO Redis Client — Smart Fallback
// In development: uses in-memory store (no Redis server needed)
// In production:  uses Upstash Redis (free tier, serverless)
// ══════════════════════════════════════════════════════════════════════════════

const logger = require('../utils/logger');

// ── In-Memory Fallback Store ─────────────────────────────────────────────────
const _store = new Map();
const _subscribers = new Map(); // channel → Set of callbacks
let _usingMock = false;

// ── Try to connect to real Redis (Upstash or local) ──────────────────────────
let redisClient = null;
let redisSub = null;

const connectRedis = async () => {
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
  
  if (!redisUrl || redisUrl.includes('your-redis')) {
    _usingMock = true;
    logger.warn('⚡ Redis: No URL configured — using in-memory store (dev mode)');
    logger.warn('   Set REDIS_URL in .env for production (Upstash free tier recommended)');
    return;
  }

  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: redisUrl });
    redisSub = redisClient.duplicate();

    await redisClient.connect();
    await redisSub.connect();
    
    logger.info('✅ Redis connected: ' + redisUrl.substring(0, 30) + '...');
  } catch (err) {
    _usingMock = true;
    logger.warn(`⚡ Redis connect failed (${err.message}) — using in-memory fallback`);
  }
};

// ── Set driver location (lat, lng, heading) ───────────────────────────────────
const setDriverLocation = async (driverId, lat, lng, heading = 0) => {
  const key = `driver:${driverId}:location`;
  const value = JSON.stringify({ lat, lng, heading, ts: Date.now() });
  
  if (_usingMock) {
    _store.set(key, value);
    return;
  }
  await redisClient.setEx(key, 300, value); // TTL: 5 minutes
};

// ── Get driver location ───────────────────────────────────────────────────────
const getDriverLocation = async (driverId) => {
  const key = `driver:${driverId}:location`;
  
  if (_usingMock) {
    const val = _store.get(key);
    return val ? JSON.parse(val) : null;
  }
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : null;
};

// ── Mark driver as online/offline ─────────────────────────────────────────────
const setDriverOnline = async (driverId, carType) => {
  const key = `driver:${driverId}:online`;
  const value = JSON.stringify({ carType, since: Date.now() });
  
  if (_usingMock) { _store.set(key, value); return; }
  await redisClient.setEx(key, 3600, value);
};

const setDriverOffline = async (driverId) => {
  const key = `driver:${driverId}:online`;
  if (_usingMock) { _store.delete(key); return; }
  await redisClient.del(key);
};

// ── Get all online driver IDs ────────────────────────────────────────────────
const getOnlineDrivers = async () => {
  if (_usingMock) {
    const onlineIds = [];
    for (const key of _store.keys()) {
      if (key.startsWith('driver:') && key.endsWith(':online')) {
        const parts = key.split(':');
        onlineIds.push(parts[1]);
      }
    }
    return onlineIds;
  }
  
  // For real Redis
  try {
    const keys = await redisClient.keys('driver:*:online');
    return keys.map(k => k.split(':')[1]);
  } catch (err) {
    logger.error('Redis getOnlineDrivers error:', err.message);
    return [];
  }
};

// ── Publish driver location update to ride subscribers ────────────────────────
const publishDriverLocation = async (channel, data) => {
  if (_usingMock) {
    // In-memory pub/sub
    const subs = _subscribers.get(channel);
    if (subs) {
      subs.forEach(cb => cb(JSON.stringify(data)));
    }
    return;
  }
  await redisClient.publish(channel, JSON.stringify(data));
};

// ── Get Redis sub client (for Socket.io subscriptions) ────────────────────────
const getRedisSub = () => {
  if (_usingMock) {
    // Return a mock sub object
    return {
      subscribe: (channel, callback) => {
        if (!_subscribers.has(channel)) _subscribers.set(channel, new Set());
        _subscribers.get(channel).add(callback);
      },
      unsubscribe: (channel, callback) => {
        const subs = _subscribers.get(channel);
        if (subs) subs.delete(callback);
      },
    };
  }
  return redisSub;
};

module.exports = {
  connectRedis,
  setDriverLocation,
  getDriverLocation,
  setDriverOnline,
  setDriverOffline,
  getOnlineDrivers,
  publishDriverLocation,
  getRedisSub,
};
