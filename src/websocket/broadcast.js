const { clients } = require('./server');
const logger = require('../utils/logger');
const ws = require('ws');

function broadcastEvent(event) {
  const payloadStr = JSON.stringify(event);
  let broadcastCount = 0;

  for (const [wsClient, clientData] of clients.entries()) {
    if (wsClient.readyState !== ws.OPEN) {
      continue;
    }

    const { filters } = clientData;
    let isMatch = true;

    // Apply filters if defined
    if (filters && event.data) {
      if (filters.customer_name && event.data.customer_name !== filters.customer_name) {
        isMatch = false;
      }
      if (filters.order_id && event.data.id !== Number(filters.order_id)) {
        isMatch = false;
      }
      if (filters.product_name && event.data.product_name !== filters.product_name) {
        isMatch = false;
      }
      if (filters.status && event.data.status !== filters.status) {
        isMatch = false;
      }
    }

    if (isMatch) {
      try {
        wsClient.send(payloadStr);
        broadcastCount++;
      } catch (err) {
        logger.error('Failed to send broadcast payload to connection:', err);
      }
    }
  }

  logger.info(`Broadcasted event payload to ${broadcastCount} filtered WebSocket clients`);
}

module.exports = { broadcastEvent };
