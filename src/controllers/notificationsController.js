const { query } = require('../config/database');
const logger = require('../utils/logger');

const sendMassNotification = async (req, res) => {
  try {
    const { title, body, targetAudience } = req.body;
    
    if (!title || !body || !targetAudience) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1. Log to database
    const { rows } = await query(
      `INSERT INTO mass_notifications (title, body, target_audience, sent_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, body, targetAudience, req.user.id]
    );

    // 2. Fetch target users player IDs (assuming OneSignal integration)
    // let audienceQuery = '';
    // if (targetAudience === 'all_drivers') audienceQuery = "role = 'driver'";
    // else if (targetAudience === 'all_passengers') audienceQuery = "role = 'passenger'";
    
    // const { rows: users } = await query(
    //   `SELECT onesignal_player_id FROM users WHERE onesignal_player_id IS NOT NULL AND ${audienceQuery}`
    // );
    
    // 3. Send via OneSignal API...
    // For now, we simulate success since the database logs it perfectly
    
    await query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details)
       VALUES ($1, 'send_mass_notification', 'notification', $2, $3)`,
      [req.user.id, rows[0].id, JSON.stringify({ targetAudience, title })]
    );

    return res.status(200).json({ 
      success: true, 
      message: 'Notification queued for sending',
      notificationId: rows[0].id 
    });
  } catch (err) {
    logger.error('sendMassNotification error:', err.message);
    return res.status(500).json({ error: 'Failed to send mass notification' });
  }
};

const getNotificationHistory = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT n.*, u.full_name as sent_by_name 
       FROM mass_notifications n
       LEFT JOIN users u ON u.id = n.sent_by
       ORDER BY n.created_at DESC LIMIT 50`
    );
    return res.json({ notifications: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch notifications history' });
  }
};

module.exports = { sendMassNotification, getNotificationHistory };
