const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * POST /api/v1/promo/validate
 * Validate a promo code and return discount info without applying
 */
const validatePromo = async (req, res) => {
  try {
    const { code, carType, estimatedFare } = req.body;
    const userId = req.user.id;

    if (!code) return res.status(400).json({ error: 'Promo code required' });

    const { rows } = await query(
      `SELECT * FROM promo_codes
       WHERE code = $1 AND is_active = true
         AND valid_from <= NOW() AND valid_until >= NOW()
         AND (max_total_uses IS NULL OR current_total_uses < max_total_uses)`,
      [code.toUpperCase().trim()]
    );

    if (!rows[0]) {
      return res.json({ valid: false, error: 'Invalid or expired code', error_ar: 'الكود غير صالح أو منتهي الصلاحية' });
    }

    const promo = rows[0];

    // Car type restriction
    if (promo.applicable_car_types?.length && !promo.applicable_car_types.includes(carType)) {
      return res.json({
        valid: false,
        error: `This code is only valid for: ${promo.applicable_car_types.join(', ')}`,
        error_ar: 'هذا الكود صالح لأنواع معينة من السيارات فقط',
      });
    }

    // Per-user limit
    const { rows: usageRows } = await query(
      `SELECT COUNT(*) FROM promo_code_usages WHERE promo_code_id = $1 AND user_id = $2`,
      [promo.id, userId]
    );
    if (parseInt(usageRows[0].count) >= promo.max_per_user) {
      return res.json({ valid: false, error: 'You have already used this code', error_ar: 'لقد استخدمت هذا الكود سابقاً' });
    }

    // Min fare check
    if (estimatedFare && parseFloat(estimatedFare) < parseFloat(promo.min_fare_jod)) {
      return res.json({
        valid: false,
        error: `Minimum ride fare for this code is ${promo.min_fare_jod} JOD`,
        error_ar: `الحد الأدنى للرحلة لاستخدام هذا الكود هو ${promo.min_fare_jod} دينار`,
      });
    }

    // Calculate discount
    let discountAmount = 0;
    if (estimatedFare) {
      const fare = parseFloat(estimatedFare);
      if (promo.discount_type === 'percentage') {
        const raw = fare * (parseFloat(promo.discount_value) / 100);
        discountAmount = promo.max_discount_jod ? Math.min(raw, parseFloat(promo.max_discount_jod)) : raw;
      } else {
        discountAmount = Math.min(parseFloat(promo.discount_value), fare);
      }
      discountAmount = parseFloat(discountAmount.toFixed(2));
    }

    return res.json({
      valid: true,
      promoId: promo.id,
      code: promo.code,
      discountType: promo.discount_type,
      discountValue: parseFloat(promo.discount_value),
      maxDiscountJod: promo.max_discount_jod ? parseFloat(promo.max_discount_jod) : null,
      discountAmount,
      validUntil: promo.valid_until,
    });
  } catch (err) {
    logger.error('validatePromo error:', err.message);
    return res.status(500).json({ error: 'Validation failed' });
  }
};

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

const listPromoCodes = async (req, res) => {
  try {
    const { active, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = active !== undefined ? [`is_active = ${active === 'true'}`] : [];
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT pc.*, u.full_name as created_by_name,
              (SELECT COUNT(*) FROM promo_code_usages pcu WHERE pcu.promo_code_id = pc.id) as actual_uses
       FROM promo_codes pc
       LEFT JOIN users u ON u.id = pc.created_by
       ${where} ORDER BY pc.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ promoCodes: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch promo codes' });
  }
};

const createPromoCode = async (req, res) => {
  try {
    const {
      code, discountType, discountValue, maxDiscountJod, minFareJod,
      maxTotalUses, maxPerUser, applicableCarTypes, validFrom, validUntil,
    } = req.body;

    const { rows } = await query(
      `INSERT INTO promo_codes
         (code, discount_type, discount_value, max_discount_jod, min_fare_jod,
          max_total_uses, max_per_user, applicable_car_types, valid_from, valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        code.toUpperCase().trim(), discountType, discountValue,
        maxDiscountJod || null, minFareJod || 0,
        maxTotalUses || null, maxPerUser || 1,
        applicableCarTypes || null, validFrom, validUntil, req.user.id,
      ]
    );
    return res.status(201).json({ promoCode: rows[0] });
  } catch (err) {
    if (err.constraint === 'unique_promo_code') {
      return res.status(409).json({ error: 'Code already exists' });
    }
    return res.status(500).json({ error: 'Failed to create promo code' });
  }
};

const updatePromoCode = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, validUntil, maxTotalUses } = req.body;
    const updates = [];
    const values = [];
    let i = 1;

    if (isActive !== undefined) { updates.push(`is_active = $${i++}`); values.push(isActive); }
    if (validUntil) { updates.push(`valid_until = $${i++}`); values.push(validUntil); }
    if (maxTotalUses) { updates.push(`max_total_uses = $${i++}`); values.push(maxTotalUses); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(id);
    const { rows } = await query(
      `UPDATE promo_codes SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ promoCode: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update promo code' });
  }
};

const deletePromoCode = async (req, res) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM promo_codes WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete promo code' });
  }
};

module.exports = { validatePromo, listPromoCodes, createPromoCode, updatePromoCode, deletePromoCode };
