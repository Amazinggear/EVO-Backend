const OneSignal = require('@onesignal/node-onesignal');
const logger = require('../utils/logger');

let client = null;
const APP_ID = process.env.ONESIGNAL_APP_ID || '';

try {
  const configuration = OneSignal.createConfiguration ? OneSignal.createConfiguration({
    restApiKey: process.env.ONESIGNAL_REST_API_KEY,
  }) : null;
  if (configuration) {
    client = new OneSignal.DefaultApi(configuration);
  }
} catch (e) {
  logger.warn('OneSignal initialization failed or mocked');
}

/**
 * Send push notification to specific players (devices)
 * @param {string[]} playerIds - OneSignal player IDs
 * @param {string} headingEn - Title in English
 * @param {string} headingAr - Title in Arabic
 * @param {string} contentEn - Body in English
 * @param {string} contentAr - Body in Arabic
 * @param {object} data - Extra data payload
 */
const sendPushNotification = async ({
  playerIds,
  headingEn,
  headingAr,
  contentEn,
  contentAr,
  data = {},
}) => {
  try {
    const notification = new OneSignal.Notification();
    notification.app_id = APP_ID;
    notification.include_player_ids = playerIds;
    notification.headings = { en: headingEn, ar: headingAr };
    notification.contents = { en: contentEn, ar: contentAr };
    notification.data = data;
    notification.priority = 10;

    const response = await client.createNotification(notification);
    logger.info('OneSignal notification sent:', response.id);
    return response;
  } catch (error) {
    logger.error('OneSignal error:', error.message);
    // Non-fatal — don't crash the app if push fails
  }
};

// Predefined notification templates
const notify = {
  driverApproved: async (playerId) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'Account Approved! 🎉',
      headingAr: 'تم اعتماد حسابك! 🎉',
      contentEn: 'Welcome to EVO! You can now go online and start accepting rides.',
      contentAr: 'مرحباً بك في EVO! يمكنك الآن البدء بالعمل وقبول الرحلات.',
      data: { type: 'driver_approved' },
    }),

  driverRejected: async (playerId, reason) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'Application Update',
      headingAr: 'تحديث على طلبك',
      contentEn: `Your application was not approved. Reason: ${reason}`,
      contentAr: `للأسف تم رفض طلبك. السبب: ${reason}`,
      data: { type: 'driver_rejected', reason },
    }),

  driverMoreInfo: async (playerId, requiredDoc) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'Additional Documents Needed',
      headingAr: 'نحتاج منك مستندات إضافية',
      contentEn: `Please re-upload: ${requiredDoc}`,
      contentAr: `يرجى إعادة رفع: ${requiredDoc}`,
      data: { type: 'more_info_needed', required_doc: requiredDoc },
    }),

  rideRequest: async (playerId, rideData) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'New Ride Request! 🚗',
      headingAr: 'طلب رحلة جديد! 🚗',
      contentEn: `Pickup: ${rideData.pickupAddress}`,
      contentAr: `نقطة الاستلام: ${rideData.pickupAddressAr || rideData.pickupAddress}`,
      data: { type: 'ride_request', ride_id: rideData.id },
    }),

  driverArrived: async (playerId) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'Driver Has Arrived! 📍',
      headingAr: 'وصل الكابتن! 📍',
      contentEn: 'Your driver is waiting for you at the pickup location.',
      contentAr: 'الكابتن ينتظرك عند نقطة الاستلام.',
      data: { type: 'driver_arrived' },
    }),

  rideCompleted: async (playerId, fare, co2) =>
    sendPushNotification({
      playerIds: [playerId],
      headingEn: 'Ride Completed ✅',
      headingAr: 'اكتملت رحلتك ✅',
      contentEn: `Total: ${fare} JOD | CO₂ Saved: ${co2} kg`,
      contentAr: `المجموع: ${fare} دينار | CO₂ موفّر: ${co2} كجم`,
      data: { type: 'ride_completed' },
    }),
};

module.exports = { sendPushNotification, notify };
