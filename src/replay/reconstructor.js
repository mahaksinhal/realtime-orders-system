const pool = require('../db/client');
const logger = require('../utils/logger');

/**
 * Reconstructs the state of the orders table at a specific past timestamp
 * by replaying the sequence of emitted order_events in memory.
 * 
 * @param {string} timestamp - ISO timestamp
 * @returns {Promise<{orders: Array, eventCount: number}>}
 */
async function reconstructStateAt(timestamp) {
  try {
    const query = `
      SELECT id, operation, order_id, payload, emitted_at
      FROM order_events
      WHERE emitted_at <= $1
      ORDER BY id ASC;
    `;
    const result = await pool.query(query, [timestamp]);
    const events = result.rows;

    const stateMap = new Map();

    // Replay events sequentially to fold state in memory
    events.forEach(event => {
      const orderId = event.order_id;
      if (event.operation === 'DELETE') {
        stateMap.delete(orderId);
      } else {
        // Upsert state using event payload details
        stateMap.set(orderId, {
          id: orderId,
          customer_name: event.payload.customer_name,
          product_name: event.payload.product_name,
          status: event.payload.status,
          updated_at: event.payload.updated_at
        });
      }
    });

    return {
      orders: Array.from(stateMap.values()),
      eventCount: events.length
    };
  } catch (err) {
    logger.error(`Error reconstructing state at ${timestamp}:`, err);
    throw err;
  }
}

/**
 * Fetches the sequence of order_events in a specific time window.
 * Primarily used by the frontend playback/scrubber UI.
 * 
 * @param {object} params
 * @param {string} params.from - Start ISO timestamp
 * @param {string} params.to - End ISO timestamp
 * @returns {Promise<Array>}
 */
async function getEventTimeline({ from, to }) {
  try {
    const query = `
      SELECT id, operation, order_id, payload, emitted_at
      FROM order_events
      WHERE emitted_at >= $1 AND emitted_at <= $2
      ORDER BY id ASC
      LIMIT 1000;
    `;
    const result = await pool.query(query, [from, to]);
    return result.rows;
  } catch (err) {
    logger.error('Error fetching event timeline:', err);
    throw err;
  }
}

module.exports = {
  reconstructStateAt,
  getEventTimeline
};
