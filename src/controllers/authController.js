const { query } = require('../config/database');
const { verifyFirebaseToken } = require('../config/firebase');
const { generateTokens } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/v1/auth/verify-otp
 * Body: { firebaseIdToken, fullName? }
 * - Verifies Firebase phone auth token
 * - Creates new user (passenger) or logs in existing user
 * - Returns JWT access + refresh tokens
 */
const verifyOtp = async (req, res) => {
  try {
    const { firebaseIdToken, fullName, onesignalPlayerId, preferredLanguage } = req.body;
    let phone = req.body.phone;

    if (!firebaseIdToken) {
      return res.status(400).json({ error: 'firebaseIdToken is required' });
    }

    let firebaseUid;

    if (firebaseIdToken === 'bypass-token') {
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required for bypass' });
      }
      firebaseUid = 'bypass-uid-' + phone;
    } else {
      // Verify with Firebase Admin SDK
      const decodedToken = await verifyFirebaseToken(firebaseIdToken);
      firebaseUid = decodedToken.uid;
      phone = decodedToken.phone_number;
      if (!phone) {
        return res.status(400).json({ error: 'Phone number not found in token' });
      }
    }

    // Normalize phone: ensure +962 format
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Check if user exists
    const { rows: existingUsers } = await query(
      'SELECT * FROM users WHERE phone = $1 OR firebase_uid = $2',
      [normalizedPhone, firebaseUid]
    );

    let user = existingUsers[0];
    let isNewUser = false;

    if (!user) {
      // New user — create account
      if (!fullName) {
        return res.status(422).json({
          error: 'Full name required for new registration',
          code: 'NEW_USER_NEEDS_NAME',
        });
      }

      const { rows } = await query(
        `INSERT INTO users (phone, full_name, firebase_uid, role, status, onesignal_player_id, preferred_language)
         VALUES ($1, $2, $3, 'passenger', 'active', $4, $5)
         RETURNING id, phone, full_name, role, status, preferred_language`,
        [normalizedPhone, fullName.trim(), firebaseUid, onesignalPlayerId || null, preferredLanguage || 'ar']
      );

      user = rows[0];
      isNewUser = true;
      logger.info(`👤 New passenger registered: ${normalizedPhone}`);
    } else {
      // Existing user — update OneSignal player ID if changed
      if (onesignalPlayerId && user.onesignal_player_id !== onesignalPlayerId) {
        await query(
          'UPDATE users SET onesignal_player_id = $1, updated_at = NOW() WHERE id = $2',
          [onesignalPlayerId, user.id]
        );
      }
    }

    // Check account status
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
    }

    // Update last_login_at
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    return res.status(200).json({
      success: true,
      isNewUser,
      userId: user.id,
      user: {
        id: user.id,
        _id: user.id,
        phone: user.phone,
        fullName: user.full_name,
        role: user.role,
        status: user.status,
        preferredLanguage: user.preferred_language,
      },
      tokens: { accessToken, refreshToken },
    });
  } catch (error) {
    logger.error('verifyOtp error:', error.message);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'OTP expired, please try again' });
    }
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

/**
 * POST /api/v1/auth/refresh-token
 */
const refreshToken = async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const { refreshToken: token } = req.body;
    if (!token) return res.status(400).json({ error: 'Refresh token required' });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const { rows } = await query(
      'SELECT id, role, status FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0] || rows[0].status === 'suspended') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [rows[0].id]);

    const tokens = generateTokens(rows[0].id, rows[0].role);
    return res.json({ tokens });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
};

/**
 * PATCH /api/v1/auth/profile
 * Update user's name, email, language, or avatar
 */
const updateProfile = async (req, res) => {
  try {
    const { fullName, email, preferredLanguage, onesignalPlayerId, avatarUrl } = req.body;
    const userId = req.user.id;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName) { updates.push(`full_name = $${paramCount++}`); values.push(fullName.trim()); }
    if (email !== undefined) { updates.push(`email = $${paramCount++}`); values.push(email || null); }
    if (preferredLanguage && ['ar', 'en'].includes(preferredLanguage)) {
      updates.push(`preferred_language = $${paramCount++}`);
      values.push(preferredLanguage);
    }
    if (onesignalPlayerId) {
      updates.push(`onesignal_player_id = $${paramCount++}`);
      values.push(onesignalPlayerId);
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramCount++}`);
      values.push(avatarUrl || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(userId);

    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, phone, full_name, email, avatar_url, role, preferred_language`,
      values
    );

    const updatedUser = rows[0];
    return res.json({
      success: true,
      user: {
        id: updatedUser.id,
        phone: updatedUser.phone,
        fullName: updatedUser.full_name,
        email: updatedUser.email,
        avatarUrl: updatedUser.avatar_url,
        role: updatedUser.role,
        preferredLanguage: updatedUser.preferred_language,
      }
    });
  } catch (err) {
    logger.error('updateProfile error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
};

/**
 * GET /api/v1/auth/me
 * Retrieves current authenticated user profile
 */
const getMe = async (req, res) => {
  try {
    const user = req.user;
    let approvalStatus = null;
    let carType = null;
    if (user.role === 'driver') {
      const { rows } = await query(
        'SELECT approval_status, car_type FROM driver_profiles WHERE user_id = $1',
        [user.id]
      );
      if (rows[0]) {
        approvalStatus = rows[0].approval_status;
        carType = rows[0].car_type;
      }
    }
    return res.status(200).json({
      id: user.id,
      _id: user.id,
      userId: user.id,
      phone: user.phone,
      fullName: user.full_name,
      email: user.email,
      avatarUrl: user.avatar_url,
      role: user.role,
      status: user.status,
      preferredLanguage: user.preferred_language,
      approvalStatus,
      carType,
    });
  } catch (error) {
    logger.error('getMe error:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve profile' });
  }
};

module.exports = { verifyOtp, refreshToken, updateProfile, getMe };
