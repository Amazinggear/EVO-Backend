// src/config/firebase.js
// ══════════════════════════════════════════════════════════════════════════════
// EVO Firebase Admin SDK — v14 (Modular API)
// ══════════════════════════════════════════════════════════════════════════════

const { initializeApp, cert, getApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

let _initialized = false;
let _mock = false;

const initFirebase = () => {
  // Already initialized
  if (_initialized || getApps().length > 0) return;

  try {
    // ── Load Service Account JSON ────────────────────────────────────────────
    const serviceAccountPath = path.resolve(process.cwd(), 'firebase-service-account.json');

    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

      initializeApp({ credential: cert(serviceAccount) });

      _initialized = true;
      _mock = false;
      logger.info(`🔥 Firebase Admin initialized! Project: ${serviceAccount.project_id}`);
      logger.info(`   Account: ${serviceAccount.client_email}`);
      return;
    }

    // ── Load from .env ───────────────────────────────────────────────────────
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey && projectId !== 'your-firebase-project-id') {
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
      _initialized = true;
      _mock = false;
      logger.info(`🔥 Firebase Admin initialized from .env! Project: ${projectId}`);
      return;
    }

    // ── Mock mode ────────────────────────────────────────────────────────────
    _mock = true;
    logger.warn('⚠️  Firebase running in MOCK mode (no credentials found)');
    logger.warn('   Place firebase-service-account.json in evo-backend/ to enable OTP');

  } catch (err) {
    _mock = true;
    logger.error(`❌ Firebase init failed: ${err.message}`);
  }
};

// ── Verify Firebase Phone OTP token ─────────────────────────────────────────
const verifyFirebaseToken = async (idToken) => {
  if (_mock) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('⚠️  Firebase MOCK: bypassing token verification (development)');
      return { uid: `mock-uid-${Date.now()}`, phone_number: '+962790000000' };
    }
    throw new Error('Firebase not configured. Cannot verify OTP.');
  }

  const auth = getAuth();
  return auth.verifyIdToken(idToken);
};

// ── Get user by UID ──────────────────────────────────────────────────────────
const getFirebaseUser = async (uid) => {
  if (_mock) {
    return { uid, phoneNumber: '+962790000000', displayName: 'Dev User' };
  }
  const auth = getAuth();
  return auth.getUser(uid);
};

// ── Check if Firebase is ready ───────────────────────────────────────────────
const isFirebaseReady = () => _initialized && !_mock;

module.exports = { initFirebase, verifyFirebaseToken, getFirebaseUser, isFirebaseReady };
