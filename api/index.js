const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const routes = require('../src/routes/index');
const { initFirebase } = require('../src/config/firebase');

const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/v1', routes);
app.get('/api/health', (req, res) => {
  console.log('HIT /api/health');
  res.json({ status: 'ok', serverless: true });
});

app.use((req, res, next) => {
  console.log(`Unhandled route: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Route not found' });
});

initFirebase();

module.exports = app;
