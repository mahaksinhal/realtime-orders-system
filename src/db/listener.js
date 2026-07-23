const { Client } = require('pg');
const logger = require('../utils/logger');
const { publishEvent } = require('../events/publisher');

let client;

async function startListener() {
  client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  client.on('notification', async (msg) => {
    logger.info(`Postgres notification received on channel "${msg.channel}"`);
    try {
      const payload = JSON.parse(msg.payload);
      await publishEvent(payload);
    } catch (err) {
      logger.error('Failed to process pg notification payload:', err);
    }
  });

  client.on('error', (err) => {
    logger.error('Postgres listener client error:', err);
    // Attempt reconnection
    setTimeout(startListener, 5000);
  });

  try {
    await client.connect();
    await client.query('LISTEN orders_channel;');
    logger.info('Subscribed to Postgres channel "orders_channel"');
  } catch (err) {
    logger.error('Failed to connect Postgres listener, retrying in 5s:', err);
    setTimeout(startListener, 5000);
  }
}

async function stopListener() {
  if (client) {
    await client.end();
  }
}

module.exports = { startListener, stopListener };
