const { query } = require('../config/database');
const logger = require('../utils/logger');

const listAdmins = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, full_name, email, phone, role, admin_role, status, last_login_at, created_at 
       FROM users WHERE role = 'admin' ORDER BY created_at DESC`
    );
    return res.json({ admins: rows });
  } catch (err) {
    logger.error('listAdmins error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch admins' });
  }
};

const createAdmin = async (req, res) => {
  try {
    const { fullName, email, phone, adminRole } = req.body;
    
    if (req.user.admin_role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admins can create new admins' });
    }

    const { rows } = await query(
      `INSERT INTO users (full_name, email, phone, role, admin_role, status)
       VALUES ($1, $2, $3, 'admin', $4, 'active') RETURNING id, full_name, admin_role`,
      [fullName, email, phone, adminRole]
    );

    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
       VALUES ($1, 'create_admin', 'user', $2, $3)`,
      [req.user.id, rows[0].id, JSON.stringify({ adminRole })]
    );

    return res.status(201).json({ success: true, admin: rows[0] });
  } catch (err) {
    if (err.message.includes('unique_phone')) {
      return res.status(400).json({ error: 'Phone number already exists' });
    }
    return res.status(500).json({ error: 'Failed to create admin' });
  }
};

const updateAdminRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminRole, status } = req.body;

    if (req.user.admin_role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admins can modify admins' });
    }

    const updates = [];
    const values = [];
    let i = 1;

    if (adminRole) { updates.push(`admin_role = $${i++}`); values.push(adminRole); }
    if (status) { updates.push(`status = $${i++}`); values.push(status); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} AND role = 'admin' RETURNING id, full_name, admin_role, status`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: 'Admin not found' });

    return res.json({ success: true, admin: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update admin' });
  }
};

module.exports = { listAdmins, createAdmin, updateAdminRole };
