require('dotenv').config();

const pool = require('../src/db/client');
const { reconstructStateAt } = require('../src/replay/reconstructor');

beforeEach(async () => {
  await pool.query('DELETE FROM orders;');
  await pool.query('DELETE FROM order_events;');
});

afterAll(async () => {
  await pool.end();
});

test('reconstructStateAt accurately folds state using sequence of INSERT, UPDATE, and DELETE events', async () => {
  const t_insert = new Date('2026-07-23T10:00:00.000Z');
  const t_checkpoint1 = new Date('2026-07-23T10:05:00.000Z');
  const t_update = new Date('2026-07-23T10:10:00.000Z');
  const t_checkpoint2 = new Date('2026-07-23T10:15:00.000Z');
  const t_delete = new Date('2026-07-23T10:20:00.000Z');
  const t_checkpoint3 = new Date('2026-07-23T10:25:00.000Z');

  // 1. Seed INSERT event (t = 10:00)
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at)
     VALUES ('INSERT', 501, '{"id": 501, "customer_name": "Dave", "product_name": "Tablet", "status": "pending", "updated_at": "2026-07-23T10:00:00.000Z"}', $1);`,
    [t_insert.toISOString()]
  );

  // 2. Seed UPDATE event (t = 10:10)
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at)
     VALUES ('UPDATE', 501, '{"id": 501, "customer_name": "Dave", "product_name": "Tablet", "status": "shipped", "updated_at": "2026-07-23T10:10:00.000Z"}', $1);`,
    [t_update.toISOString()]
  );

  // 3. Seed DELETE event (t = 10:20)
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at)
     VALUES ('DELETE', 501, '{"id": 501, "customer_name": "Dave", "product_name": "Tablet", "status": "shipped", "updated_at": "2026-07-23T10:10:00.000Z"}', $1);`,
    [t_delete.toISOString()]
  );

  // Checkpoint 1: Verify order exists in 'pending' status
  const state1 = await reconstructStateAt(t_checkpoint1.toISOString());
  expect(state1.eventCount).toBe(1);
  expect(state1.orders.length).toBe(1);
  expect(state1.orders[0].id).toBe(501);
  expect(state1.orders[0].status).toBe('pending');
  expect(state1.orders[0].customer_name).toBe('Dave');

  // Checkpoint 2: Verify order status was updated to 'shipped'
  const state2 = await reconstructStateAt(t_checkpoint2.toISOString());
  expect(state2.eventCount).toBe(2);
  expect(state2.orders.length).toBe(1);
  expect(state2.orders[0].id).toBe(501);
  expect(state2.orders[0].status).toBe('shipped');

  // Checkpoint 3: Verify order is deleted
  const state3 = await reconstructStateAt(t_checkpoint3.toISOString());
  expect(state3.eventCount).toBe(3);
  expect(state3.orders.length).toBe(0);
});
