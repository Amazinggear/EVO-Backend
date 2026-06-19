const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { verifyFirebaseToken } = require('../config/firebase');
const logger = require('../utils/logger');

/**
 * Middleware: verify JWT token
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB on each request (catches suspended accounts)
    const { rows } = await query(
      'SELECT id, phone, full_name, email, avatar_url, role, admin_role, status, onesignal_player_id, preferred_language FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = rows[0];

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    logger.error('Auth middleware error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Middleware: require specific role or admin_role
 */
const requireRole = (...roles) => (req, res, next) => {
  const hasRole = roles.includes(req.user?.role) || roles.includes(req.user?.admin_role) || req.user?.admin_role === 'super_admin';
  if (!hasRole) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

/**
 * Middleware: driver must be approved to go online
 */
const requireApprovedDriver = async (req, res, next) => {
  if (req.user.role !== 'driver') {
    return res.status(403).json({ error: 'Driver account required' });
  }

  const { rows } = await query(
    'SELECT approval_status FROM driver_profiles WHERE user_id = $1',
    [req.user.id]
  );

  if (!rows[0] || rows[0].approval_status !== 'approved') {
    return res.status(403).json({
      error: 'Driver account not yet approved',
      code: 'DRIVER_NOT_APPROVED',
      approval_status: rows[0]?.approval_status || 'not_registered',
    });
  }

  next();
};

/**
 * Generate JWT tokens
 */
const generateTokens = (userId, role) => {
  const accessToken = jwt.sign({ userId, role }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
  const refreshToken = jwt.sign({ userId, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: '30d',
  });
  return { accessToken, refreshToken };
};

module.exports = { authenticate, requireRole, requireApprovedDriver, generateTokens };
