const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const logger = require('./src/utils/logger');
const routes = require('./src/routes/index');
const { initSocket } = require('./src/socket/socketEngine');
const { setIo } = require('./src/controllers/rideController');
const { initFirebase } = require('./src/config/firebase');
const { pool } = require('./src/config/database');

// ────────────────────────────────────────────
// App Initialization
// ────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling'],
});

// ────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Will configure per-route if needed
}));

app.use(cors({
  origin: function (origin, callback) {
    callback(null, true);
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting — prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter limit for auth (prevent OTP brute force)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Too many auth attempts, please wait.' },
});
app.use('/api/v1/auth/', authLimiter);

// ────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────
app.use('/api/v1', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EVO Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Root route for Render health checks
app.get('/', (req, res) => {
  res.status(200).send('EVO Backend is running');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', { message: err.message, stack: err.stack, url: req.url });
  res.status(500).json({ error: 'Internal server error' });
});

// ────────────────────────────────────────────
// Initialize Services
// ────────────────────────────────────────────
const startServer = async () => {
  try {
    // Test DB connection
    await pool.query('SELECT 1');
    logger.info('✅ Database connection verified');

    // Initialize Firebase Admin
    initFirebase();

    // Initialize Socket.io engine
    initSocket(io);

    // Pass io instance to ride controller for real-time events
    setIo(io);

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 EVO Backend running on port ${PORT}`);
      logger.info(`📡 WebSocket server ready`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`⚡ ${signal} received — shutting down gracefully`);
  server.close(() => {
    pool.end(() => {
      logger.info('✅ Server and DB connections closed');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10000); // Force exit after 10s
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();

module.exports = { app, server, io };
