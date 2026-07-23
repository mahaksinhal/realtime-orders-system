const Redis = require('ioredis');
const logger = require('../utils/logger');
const { broadcastEvent } = require('../websocket/broadcast');
const EventEmitter = require('events');

if (!global.localEventBus) {
  global.localEventBus = new EventEmitter();
}
const localEventBus = global.localEventBus;

let redis;
let useFallback = false;

async function startSubscriber() {
  // Listen to local event bus in parallel/fallback
  localEventBus.on('orders', (event) => {
    if (useFallback) {
      logger.info('Subscriber received event from local in-memory event bus');
      broadcastEvent(event);
    }
  });

  redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 2) {
        logger.warn('Redis Subscriber connection failed. Falling back to in-memory event bus.');
        useFallback = true;
        if (redis) {
          redis.disconnect();
          redis = null;
        }
        return null; // stop retrying
      }
      return 1000;
    }
  });

  redis.on('error', (err) => {
    logger.error('Redis Subscriber Client Error:', err.message);
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis as Subscriber');
    useFallback = false;
  });

  redis.on('message', (channel, message) => {
    if (channel === 'orders' && !useFallback) {
      try {
        const event = JSON.parse(message);
        logger.info(`Received event from Redis channel "${channel}"`);
        broadcastEvent(event);
      } catch (err) {
        logger.error('Failed to process message from Redis pub/sub:', err);
      }
    }
  });

  try {
    await redis.subscribe('orders');
    logger.info('Subscribed to Redis channel "orders"');
  } catch (err) {
    logger.error('Failed to subscribe to Redis orders channel, running in fallback mode');
    useFallback = true;
  }
}

module.exports = { startSubscriber };
