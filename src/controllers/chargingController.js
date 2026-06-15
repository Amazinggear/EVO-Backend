const { query } = require('../config/database');
const axios = require('axios');
const logger = require('../utils/logger');

const OCM_API = 'https://api.openchargemap.io/v3/poi';
const OCM_KEY = process.env.OPENCHARGE_MAP_API_KEY;

// Jordan bounding box for OCM sync
const JORDAN_BOUNDS = {
  maxLat: 33.37, minLat: 29.19,
  maxLng: 39.30, minLng: 34.95,
};

/**
 * GET /api/v1/charging-stations
 * Nearby visible stations within radius
 */
const getNearbyStations = async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    // Use Haversine via SQL for accurate distance
    const { rows } = await query(
      `SELECT id, name, name_ar, lat, lng, address, address_ar,
              charger_types, total_chargers, available_chargers, operator, source,
              -- Distance in km using Haversine approximation
              (6371 * acos(
                cos(radians($1)) * cos(radians(lat)) *
                cos(radians(lng) - radians($2)) +
                sin(radians($1)) * sin(radians(lat))
              )) AS distance_km
       FROM charging_stations
       WHERE is_visible = true
       HAVING (6371 * acos(
         cos(radians($1)) * cos(radians(lat)) *
         cos(radians(lng) - radians($2)) +
         sin(radians($1)) * sin(radians(lat))
       )) <= $3
       ORDER BY distance_km ASC
       LIMIT 50`,
      [parseFloat(lat), parseFloat(lng), parseFloat(radius)]
    );

    return res.json({ stations: rows, count: rows.length });
  } catch (err) {
    logger.error('getNearbyStations error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch charging stations' });
  }
};

/**
 * GET /api/v1/charging-stations/:id
 */
const getStationById = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM charging_stations WHERE id = $1 AND is_visible = true',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Station not found' });
    return res.json({ station: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch station' });
  }
};

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

const adminListAllStations = async (req, res) => {
  try {
    const { visible, source, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const conditions = [];
    const values = [];
    let i = 1;

    if (visible !== undefined) { conditions.push(`is_visible = $${i++}`); values.push(visible === 'true'); }
    if (source) { conditions.push(`source = $${i++}`); values.push(source); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT * FROM charging_stations ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    );

    return res.json({ stations: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch stations' });
  }
};

const adminAddStation = async (req, res) => {
  try {
    const { name, nameAr, lat, lng, address, addressAr, chargerTypes, totalChargers, operator } = req.body;
    const { rows } = await query(
      `INSERT INTO charging_stations (name, name_ar, lat, lng, address, address_ar,
         charger_types, total_chargers, operator, source, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10)
       RETURNING *`,
      [name, nameAr, lat, lng, address, addressAr, chargerTypes, totalChargers, operator, req.user.id]
    );
    return res.status(201).json({ station: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add station' });
  }
};

const adminUpdateStation = async (req, res) => {
  try {
    const { id } = req.params;
    const { isVisible, isVerified, name, nameAr, availableChargers } = req.body;
    const updates = [];
    const values = [];
    let i = 1;

    if (isVisible !== undefined) { updates.push(`is_visible = $${i++}`); values.push(isVisible); }
    if (isVerified !== undefined) { updates.push(`is_verified = $${i++}`); values.push(isVerified); }
    if (name) { updates.push(`name = $${i++}`); values.push(name); }
    if (nameAr) { updates.push(`name_ar = $${i++}`); values.push(nameAr); }
    if (availableChargers !== undefined) { updates.push(`available_chargers = $${i++}`); values.push(availableChargers); }

    updates.push('updated_at = NOW()');
    values.push(id);

    const { rows } = await query(
      `UPDATE charging_stations SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ station: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update station' });
  }
};

const adminDeleteStation = async (req, res) => {
  try {
    await query('DELETE FROM charging_stations WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete station' });
  }
};

/**
 * POST /api/admin/charging-stations/sync
 * Sync all EV charging stations in Jordan from OpenChargeMap API
 */
const adminSyncFromOCM = async (req, res) => {
  try {
    logger.info('🔄 Starting OpenChargeMap sync for Jordan...');

    const response = await axios.get(OCM_API, {
      params: {
        key: OCM_KEY,
        countrycode: 'JO',
        maxresults: 1000,
        output: 'json',
        compact: true,
        verbose: false,
      },
      timeout: 30000,
    });

    const stations = response.data;
    let added = 0;
    let updated = 0;

    for (const station of stations) {
      if (!station.AddressInfo?.Latitude || !station.AddressInfo?.Longitude) continue;

      const lat = station.AddressInfo.Latitude;
      const lng = station.AddressInfo.Longitude;
      const name = station.AddressInfo.Title || 'EV Charging Station';
      const address = station.AddressInfo.AddressLine1 || station.AddressInfo.Town || '';
      const chargerTypes = station.Connections?.map(c => c.ConnectionType?.Title).filter(Boolean) || [];
      const totalChargers = station.NumberOfPoints || station.Connections?.length || 1;
      const operator = station.OperatorInfo?.Title || 'Unknown';

      const existing = await query(
        'SELECT id FROM charging_stations WHERE ocm_id = $1',
        [station.ID]
      );

      if (existing.rows[0]) {
        await query(
          `UPDATE charging_stations
           SET name=$1, lat=$2, lng=$3, address=$4, charger_types=$5,
               total_chargers=$6, operator=$7, last_synced_at=NOW(), updated_at=NOW()
           WHERE ocm_id=$8`,
          [name, lat, lng, address, chargerTypes, totalChargers, operator, station.ID]
        );
        updated++;
      } else {
        await query(
          `INSERT INTO charging_stations
             (name, lat, lng, address, charger_types, total_chargers, operator, source, ocm_id, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'opencharge_map',$8,NOW())
           ON CONFLICT DO NOTHING`,
          [name, lat, lng, address, chargerTypes, totalChargers, operator, station.ID]
        );
        added++;
      }
    }

    logger.info(`✅ OCM Sync complete: ${added} added, ${updated} updated`);
    return res.json({ success: true, added, updated, total: stations.length });
  } catch (err) {
    logger.error('OCM sync error:', err.message);
    return res.status(500).json({ error: 'Sync failed', details: err.message });
  }
};

module.exports = {
  getNearbyStations, getStationById,
  adminListAllStations, adminAddStation, adminUpdateStation, adminDeleteStation, adminSyncFromOCM,
};
