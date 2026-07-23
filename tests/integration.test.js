require('dotenv').config();

jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  const emitter = new EventEmitter();
  return class MockRedis extends EventEmitter {
    constructor() {
      super();
    }
    async publish(channel, message) {
      emitter.emit('message', channel, message);
      return 1;
    }
    async subscribe(channel) {
      emitter.on('message', (ch, msg) => {
        this.emit('message', ch, msg);
      });
      return 1;
    }
    async quit() {
      return 'OK';
    }
    on(event, handler) {
      if (event === 'connect') {
        process.nextTick(handler);
      } else {
        super.on(event, handler);
      }
    }
  };
});

const http = require('http');
const request = require('supertest');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const pool = require('../src/db/client');
const { initWebSocketServer } = require('../src/websocket/server');
const { startListener, stopListener } = require('../src/db/listener');
const { startSubscriber } = require('../src/events/subscriber');
const { JWT_SECRET } = require('../src/middleware/auth');
const { getRedisClient } = require('../src/events/publisher');

let server;
let wss;
let wsClient;
const PORT = 8085;

beforeAll(async () => {
  server = http.createServer(app);
  wss = initWebSocketServer(server);

  // Initialize DB listener and Redis subscriber
  await startListener();
  await startSubscriber();

  await new Promise((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.close();
  }
  
  // Close database pool connection
  await pool.end();
  await stopListener();

  // Close Redis connection
  const redisClient = getRedisClient();
  if (redisClient) {
    await redisClient.quit();
  }

  // Close server and socket
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => wss.close(resolve));
});

test('Should receive WebSocket notification on order insertion', async () => {
  const token = jwt.sign({ username: 'TestUser' }, JWT_SECRET);
  
  // Connect WebSocket client
  wsClient = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);

  await new Promise((resolve, reject) => {
    wsClient.on('open', resolve);
    wsClient.on('error', reject);
  });

  const messagePromise = new Promise((resolve) => {
    wsClient.on('message', (data) => {
      const payload = JSON.parse(data.toString());
      // Skip welcome/info messages
      if (payload.type === 'INFO') return;
      resolve(payload);
    });
  });

  // Create order via Express API
  const orderData = {
    customer_name: 'TestCustomer',
    product_name: 'TestProduct',
    status: 'pending'
  };

  const response = await request(app)
    .post('/api/orders')
    .send(orderData);

  expect(response.status).toBe(201);
  expect(response.body.customer_name).toBe(orderData.customer_name);

  // Wait for the WebSocket message to arrive
  const wsMessage = await messagePromise;
  expect(wsMessage.operation).toBe('INSERT');
  expect(wsMessage.data.customer_name).toBe(orderData.customer_name);
  expect(wsMessage.data.product_name).toBe(orderData.product_name);
});
