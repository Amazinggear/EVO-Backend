require('dotenv').config();
const { query } = require('./src/config/database');

async function createDummyDriver() {
  const phone = '+962781865578';
  
  try {
    console.log('Creating dummy driver account...');
    
    // Check if user exists
    const { rows: existing } = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    let userId;
    
    if (existing.length > 0) {
      userId = existing[0].id;
      // Update to active driver
      await query(`UPDATE users SET role = 'driver', status = 'active', full_name = 'كابتن تجريبي' WHERE id = $1`, [userId]);
      console.log('Updated existing user to active driver.');
    } else {
      // Create new user
      const { rows } = await query(`
        INSERT INTO users (phone, full_name, role, status, firebase_uid)
        VALUES ($1, 'كابتن تجريبي', 'driver', 'active', $2)
        RETURNING id
      `, [phone, `bypass-uid-${phone}`]);
      userId = rows[0].id;
      console.log('Created new active driver user.');
    }

    // Check if driver profile exists
    const { rows: profileExisting } = await query('SELECT id FROM driver_profiles WHERE user_id = $1', [userId]);
    
    if (profileExisting.length > 0) {
      // Update profile
      await query(`
        UPDATE driver_profiles 
        SET approval_status = 'approved', is_online = false, car_type = 'ev_sedan'
        WHERE user_id = $1
      `, [userId]);
      console.log('Updated existing driver profile to approved.');
    } else {
      // Create profile
      await query(`
        INSERT INTO driver_profiles (
          user_id, 
          national_id_number, 
          national_id_front_url, 
          national_id_back_url, 
          personal_photo_url, 
          license_number, 
          license_photo_url, 
          criminal_clearance_url, 
          car_model, 
          car_plate, 
          car_type, 
          approval_status, 
          is_online,
          cliq_alias
        )
        VALUES (
          $1, 
          '9876543210', 
          'http://example.com/front.jpg', 
          'http://example.com/back.jpg', 
          'http://example.com/photo.jpg', 
          'LIC-123456', 
          'http://example.com/lic.jpg', 
          'http://example.com/clearance.jpg', 
          'Tesla Model 3', 
          '10-12345', 
          'ev_sedan', 
          'approved', 
          false,
          'DUMMY-CLIQ'
        )
      `, [userId]);
      console.log('Created new approved driver profile.');
    }
    
    // Create dummy passenger account
    const passengerPhone = '+962781865579';
    const { rows: existingPassenger } = await query('SELECT id FROM users WHERE phone = $1', [passengerPhone]);
    if (existingPassenger.length > 0) {
      await query(`UPDATE users SET role = 'passenger', status = 'active', full_name = 'راكب تجريبي' WHERE id = $1`, [existingPassenger[0].id]);
      console.log('Updated existing user to active passenger.');
    } else {
      await query(`
        INSERT INTO users (phone, full_name, role, status, firebase_uid)
        VALUES ($1, 'راكب تجريبي', 'passenger', 'active', $2)
      `, [passengerPhone, `bypass-uid-${passengerPhone}`]);
      console.log('Created new active passenger user.');
    }
    
    console.log('✅ Dummy driver and passenger accounts successfully set up!');
    process.exit(0);
  } catch (e) {
    console.error('Error creating dummy accounts:', e);
    process.exit(1);
  }
}

createDummyDriver();
