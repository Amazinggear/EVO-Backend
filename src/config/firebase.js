const admin = require('firebase-admin');
const logger = require('../utils/logger');

let firebaseApp;

const initFirebase = () => {
  logger.info('🔥 MOCK Firebase Admin initialized');
  return {};
};

const verifyFirebaseToken = async (idToken) => {
  const app = initFirebase();
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  return decodedToken;
};

const getFirebaseUser = async (uid) => {
  initFirebase();
  return admin.auth().getUser(uid);
};

module.exports = { initFirebase, verifyFirebaseToken, getFirebaseUser };
