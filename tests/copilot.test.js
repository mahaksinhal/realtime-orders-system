require('dotenv').config();

const pool = require('../src/db/client');
const { buildContextWindow, generatePeriodicInsight } = require('../src/ai/copilot');
const geminiClient = require('../src/ai/geminiClient');

// Mock the Gemini API client
jest.mock('../src/ai/geminiClient', () => ({
  generateInsight: jest.fn()
}));

beforeEach(async () => {
  // Clear orders first (which fires delete triggers into order_events), then clear events
  await pool.query('DELETE FROM orders;');
  await pool.query('DELETE FROM order_events;');
  jest.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

test('buildContextWindow aggregates counts and flags pending status anomalies correctly', async () => {

  // Seed Order 1 (Completed pending state: pending duration of 10s)
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at) VALUES 
    ('INSERT', 101, '{"status": "pending", "customer_name": "Alice"}', NOW() - INTERVAL '70 seconds'),
    ('UPDATE', 101, '{"status": "shipped", "customer_name": "Alice"}', NOW() - INTERVAL '60 seconds');`
  );

  // Seed Order 2 (Completed pending state: pending duration of 20s)
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at) VALUES 
    ('INSERT', 102, '{"status": "pending", "customer_name": "Bob"}', NOW() - INTERVAL '70 seconds'),
    ('UPDATE', 102, '{"status": "shipped", "customer_name": "Bob"}', NOW() - INTERVAL '50 seconds');`
  );

  // Seed Order 3 (Anomaly: still pending at t0, meaning pending duration is 70s)
  // This is greater than 3x the average (15s) of completed pending states
  await pool.query(
    `INSERT INTO order_events (operation, order_id, payload, emitted_at) VALUES 
    ('INSERT', 103, '{"status": "pending", "customer_name": "Charlie"}', NOW() - INTERVAL '70 seconds');`
  );

  const context = await buildContextWindow({ minutes: 10 });

  expect(context.eventCount).toBe(5);
  expect(context.opCounts.INSERT).toBe(3);
  expect(context.opCounts.UPDATE).toBe(2);
  expect(context.statusCounts.pending).toBe(1);
  expect(context.statusCounts.shipped).toBe(2);
  
  // Completed durations: 10s and 20s -> Average is 15s (15000ms)
  expect(context.avgPendingDurationMs).toBe(15000);

  // Anomaly: Order 103 has been pending for ~70s which is > 3 * 15s = 45s.
  expect(context.anomalies.length).toBe(1);
  expect(context.anomalies[0].orderId).toBe(103);
  expect(context.anomalies[0].customerName).toBe('Charlie');
});

test('generatePeriodicInsight skips calling Gemini when there are zero events in the window', async () => {
  geminiClient.generateInsight.mockResolvedValue('Sample Insight Response');

  const insight = await generatePeriodicInsight();

  expect(insight.basedOnEventCount).toBe(0);
  expect(insight.text).toBe('No activity in the last 10 minutes.');
  expect(geminiClient.generateInsight).not.toHaveBeenCalled();
});
