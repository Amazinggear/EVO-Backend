const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient;
let redisSub;
let redisPub;

const createRedisClient = (name = 'default') => {
  const client = new Redis(process.env.REDIS_URL, {
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      logger.warn(`Redis (${name}) reconnecting in ${delay}ms...`);
      return delay;
    },
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => logger.info(`🔴 Redis (${name}) connected`));
  client.on('error', (err) => logger.error(`Redis (${name}) error:`, err.message));

  return client;
};

const getRedis = () => {
  if (!redisClient) redisClient = createRedisClient('main');
  return redisClient;
};

// Dedicated Pub/Sub clients (cannot be used for other commands)
const getRedisSub = () => {
  if (!redisSub) redisSub = createRedisClient('sub');
  return redisSub;
};

const getRedisPub = () => {
  if (!redisPub) redisPub = createRedisClient('pub');
  return redisPub;
};

// Driver location cache helpers
const DRIVER_LOCATION_TTL = 120; // 2 minutes

const setDriverLocation = async (driverId, locationData) => {
  const redis = getRedis();
  await redis.setex(
    `driver:location:${driverId}`,
    DRIVER_LOCATION_TTL,
    JSON.stringify(locationData)
  );
};

const getDriverLocation = async (driverId) => {
  const redis = getRedis();
  const data = await redis.get(`driver:location:${driverId}`);
  return data ? JSON.parse(data) : null;
};

const setDriverOnline = async (driverId, carType) => {
  const redis = getRedis();
  await redis.sadd('drivers:online', driverId);
  await redis.setex(`driver:online:${driverId}`, DRIVER_LOCATION_TTL, carType);
};

const setDriverOffline = async (driverId) => {
  const redis = getRedis();
  await redis.srem('drivers:online', driverId);
  await redis.del(`driver:online:${driverId}`);
  await redis.del(`driver:location:${driverId}`);
};

const getOnlineDrivers = async () => {
  const redis = getRedis();
  return redis.smembers('drivers:online');
};

// Publish real-time driver location to ride channel
const publishDriverLocation = async (rideId, locationData) => {
  const pub = getRedisPub();
  await pub.publish(`ride:${rideId}:location`, JSON.stringify(locationData));
};

module.exports = {
  getRedis,
  getRedisSub,
  getRedisPub,
  setDriverLocation,
  getDriverLocation,
  setDriverOnline,
  setDriverOffline,
  getOnlineDrivers,
  publishDriverLocation,
};
