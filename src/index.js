// Load environment variables first
require('dotenv').config();

const http = require('http');
const app = require('./app');
const logger = require('./utils/logger');
const { initWebSocketServer } = require('./websocket/server');
const { startListener } = require('./db/listener');
const { startSubscriber } = require('./events/subscriber');

const { runMigrations } = require('./db/migrate');

const PORT = process.env.PORT || 8000;

async function startServer() {
  // Run DB schema migrations
  await runMigrations();

  const server = http.createServer(app);

  // Initialize WebSocket Server
  initWebSocketServer(server);

  // Start Database Listener (LISTEN orders_channel)
  await startListener();

  // Start Redis Subscriber (Subscribe to 'orders')
  await startSubscriber();

  // Initialize AI Order Copilot Insights if API key is present
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY is not set. AI Order Copilot periodic insights are disabled.');
  } else {
    const { generatePeriodicInsight } = require('./ai/copilot');
    const { broadcastEvent } = require('./websocket/broadcast');
    const intervalMs = Number(process.env.INSIGHT_INTERVAL_MS) || 60000;

    logger.info(`AI Order Copilot enabled. Scheduling periodic summaries every ${intervalMs}ms.`);

    setInterval(async () => {
      try {
        const insight = await generatePeriodicInsight();
        if (insight) {
          logger.info('Broadcasting periodic operational insight to all clients.');
          broadcastEvent({
            type: 'insight',
            text: insight.text,
            generatedAt: insight.generatedAt,
            basedOnEventCount: insight.basedOnEventCount
          });
        }
      } catch (err) {
        logger.error('Failed to run periodic operational insight loop:', err);
      }
    }, intervalMs);
  }

  server.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start application server:', err);
  process.exit(1);
});
