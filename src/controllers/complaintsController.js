const { query } = require('../config/database');
const logger = require('../utils/logger');

const getComplaints = async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const values = [];
    let i = 1;

    if (status) { conditions.push(`c.status = $${i++}`); values.push(status); }
    if (type) { conditions.push(`c.type = $${i++}`); values.push(type); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const { rows } = await query(
      `SELECT c.*, 
              u.full_name as complainant_name, u.phone as complainant_phone,
              tu.full_name as target_name, tu.phone as target_phone,
              au.full_name as agent_name
       FROM complaints c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users tu ON tu.id = c.target_id
       LEFT JOIN users au ON au.id = c.assigned_to
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    );

    const { rows: countRows } = await query(`SELECT COUNT(*) FROM complaints c ${where}`, values);

    return res.json({ complaints: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) {
    logger.error('getComplaints error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch complaints' });
  }
};

const updateComplaintStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution_notes } = req.body;
    
    const { rows } = await query(
      `UPDATE complaints 
       SET status = COALESCE($1, status), 
           resolution_notes = COALESCE($2, resolution_notes)
       WHERE id = $3 RETURNING *`,
      [status, resolution_notes, id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    
    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
       VALUES ($1, 'update_complaint', 'complaint', $2, $3)`,
      [req.user.id, id, JSON.stringify({ status, resolution_notes })]
    );

    return res.json({ success: true, complaint: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update complaint' });
  }
};

const assignComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_to } = req.body;

    const { rows } = await query(
      'UPDATE complaints SET assigned_to = $1 WHERE id = $2 RETURNING *',
      [assigned_to, id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Complaint not found' });

    return res.json({ success: true, complaint: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to assign complaint' });
  }
};

module.exports = { getComplaints, updateComplaintStatus, assignComplaint };
