const logger = require('../utils/logger');

// MOCK DATABASE FOR NOW
// We use this because Postgres is not installed on the user's Windows machine.
class MockPool {
  on(event, cb) {
    if (event === 'connect') cb();
  }
  query() { return Promise.resolve({ rows: [] }); }
  connect() { return Promise.resolve({ release: () => {}, query: () => Promise.resolve({ rows: [] }) }); }
  end(cb) { if(cb) cb(); }
}

const pool = new MockPool();

pool.on('connect', () => {
  logger.info('📦 MOCK PostgreSQL connected');
});

const query = async (text, params) => {
  const start = Date.now();
  try {
    let rows = [];

    // Dashboard Stats
    if (text.includes('AS rides_today')) {
      rows = [{
        rides_today: '45',
        completed_today: '40',
        revenue_today: '120.5',
        total_passengers: '250',
        total_drivers: '60',
        pending_approvals: '5',
        active_rides: '4'
      }];
    } 
    // Users List
    else if (text.includes('FROM users')) {
      if (text.includes('COUNT(*)')) {
        rows = [{ count: '1' }];
      } else if (text.includes('WHERE id = $1') && params[0] === 1) {
        rows = [{
          id: 1, phone: '0790000000', full_name: 'Admin', email: 'admin@evo.jo', 
          role: 'admin', status: 'active', preferred_language: 'ar', created_at: new Date()
        }];
      } else {
        rows = [{
          id: 1, phone: '0790000000', full_name: 'كابتن محمد', email: 'driver@evo.jo', 
          role: 'driver', status: 'active', preferred_language: 'ar', created_at: new Date()
        }];
      }
    }
    // Pricing
    else if (text.includes('FROM pricing_config')) {
      rows = [
        { car_type: 'ev_mini', base_fare: 0.48, per_km: 0.34, min_fare: 1.20 },
        { car_type: 'ev_taxi', base_fare: 0.45, per_km: 0.316, min_fare: 1.20 },
        { car_type: 'ev_sedan', base_fare: 0.48, per_km: 0.34, min_fare: 1.30 },
        { car_type: 'ev_suv', base_fare: 0.49, per_km: 0.35, min_fare: 1.50 },
        { car_type: 'ev_luxury', base_fare: 0.50, per_km: 0.36, min_fare: 1.75 },
      ];
    }
    else if (text === 'SELECT 1') {
      rows = [{ '?column?': 1 }];
    }

    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Slow query (${duration}ms): ${text}`);
    }
    return { rows };
  } catch (err) {
    logger.error('Database query error:', { text, params, error: err.message });
    throw err;
  }
};

const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
