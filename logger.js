const pino = require('pino');

// Structured JSON logging. In production (behind systemd/journald) plain JSON is
// ideal; in dev, pretty-print if pino-pretty is available.
const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
});

module.exports = logger;
