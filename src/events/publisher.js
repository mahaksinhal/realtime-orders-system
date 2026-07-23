const Redis = require('ioredis');
const logger = require('../utils/logger');
const EventEmitter = require('events');

// Global event bus for in-memory fallback
if (!global.localEventBus) {
  global.localEventBus = new EventEmitter();
}
const localEventBus = global.localEventBus;

let redis;
let useFallback = false;

function getRedisClient() {
  if (useFallback) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) {
          logger.warn('Redis Publisher connection failed. Falling back to in-memory event bus.');
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
      logger.error('Redis Publisher Client Error:', err.message);
    });

    redis.on('connect', () => {
      logger.info('Connected to Redis as Publisher');
      useFallback = false;
    });
  }
  return redis;
}

async function publishEvent(event) {
  if (useFallback) {
    logger.info('Publishing order event to local in-memory event bus');
    localEventBus.emit('orders', event);
    return;
  }

  const client = getRedisClient();
  if (useFallback || !client) {
    logger.info('Publishing order event to local in-memory event bus');
    localEventBus.emit('orders', event);
    return;
  }

  const channel = 'orders';
  try {
    const payloadStr = JSON.stringify(event);
    await client.publish(channel, payloadStr);
    logger.info(`Published order event to Redis channel "${channel}"`);
  } catch (err) {
    logger.error('Failed to publish event to Redis, falling back to local bus:', err);
    localEventBus.emit('orders', event);
  }
}

module.exports = { publishEvent, getRedisClient };
