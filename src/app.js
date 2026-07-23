const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const pool = require('./db/client');
const logger = require('./utils/logger');
const { JWT_SECRET } = require('./middleware/auth');

const app = express();

app.use(express.json());

// Serve dashboard frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../templates/index.html'));
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      services: {
        database: 'connected'
      }
    });
  } catch (err) {
    logger.error('Health check database query failure:', err);
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed'
    });
  }
});

// Token generator endpoint for dashboard auth
app.get('/api/auth/token', (req, res) => {
  const username = req.query.username || 'John';
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// CRUD API: GET /api/orders
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, customer_name, product_name, status, updated_at FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    logger.error('Failed to query orders list:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// CRUD API: POST /api/orders
app.post('/api/orders', async (req, res) => {
  const { customer_name, product_name, status } = req.body;
  if (!customer_name || !product_name) {
    return res.status(400).json({ error: 'customer_name and product_name are required' });
  }
  const orderStatus = status || 'pending';
  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_name, product_name, status) VALUES ($1, $2, $3) RETURNING id, customer_name, product_name, status, updated_at',
      [customer_name, product_name, orderStatus]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('Failed to insert new order:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// CRUD API: PUT /api/orders/:id
app.put('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }
  try {
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, customer_name, product_name, status, updated_at',
      [status, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Failed to update order status for order ID ${id}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// CRUD API: DELETE /api/orders/:id
app.delete('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ message: `Order ${id} deleted successfully` });
  } catch (err) {
    logger.error(`Failed to delete order ID ${id}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const { authMiddleware } = require('./middleware/auth');
const { answerQuestion } = require('./ai/copilot');
const { reconstructStateAt, getEventTimeline } = require('./replay/reconstructor');

// Copilot Q&A endpoint
app.post('/copilot/ask', authMiddleware, async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  try {
    const result = await answerQuestion(question);
    res.json(result);
  } catch (err) {
    logger.error('Failed to process /copilot/ask:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Time Travel State Reconstruction endpoint
app.get('/replay/state', authMiddleware, async (req, res) => {
  const { at } = req.query;
  if (!at) {
    return res.status(400).json({ error: 'at timestamp is required' });
  }
  try {
    const result = await reconstructStateAt(at);
    res.json(result);
  } catch (err) {
    logger.error('Failed to process /replay/state:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Time Travel Timeline endpoint
app.get('/replay/timeline', authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to timestamps are required' });
  }
  try {
    const timeline = await getEventTimeline({ from, to });
    res.json(timeline);
  } catch (err) {
    logger.error('Failed to process /replay/timeline:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Time Travel Timeline range endpoint (min/max timestamps)
app.get('/replay/range', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT MIN(emitted_at) as min_time, MAX(emitted_at) as max_time FROM order_events;');
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('Failed to process /replay/range:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = app;

