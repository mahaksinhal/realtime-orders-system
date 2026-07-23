const pool = require('../db/client');
const { generateInsight } = require('./geminiClient');
const logger = require('../utils/logger');

async function buildContextWindow({ minutes = 10 }) {
  const query = `
    SELECT id, operation, order_id, payload, emitted_at
    FROM order_events
    WHERE emitted_at >= NOW() - ($1 * INTERVAL '1 minute')
    ORDER BY id ASC;
  `;
  const result = await pool.query(query, [minutes]);
  const events = result.rows;

  const opCounts = { INSERT: 0, UPDATE: 0, DELETE: 0 };
  const orderMap = new Map(); // order_id -> final state payload
  const orderHistory = {}; // order_id -> array of status changes

  events.forEach(event => {
    opCounts[event.operation] = (opCounts[event.operation] || 0) + 1;
    const orderId = event.order_id;
    const status = event.payload?.status || 'unknown';
    const time = new Date(event.emitted_at);

    if (!orderHistory[orderId]) {
      orderHistory[orderId] = [];
    }

    if (event.operation === 'DELETE') {
      orderMap.delete(orderId);
      orderHistory[orderId].push({ status: 'deleted', time });
    } else {
      orderMap.set(orderId, { ...event.payload, lastUpdated: time });
      orderHistory[orderId].push({ status, time });
    }
  });

  const statusCounts = { pending: 0, shipped: 0, delivered: 0 };
  for (const [orderId, data] of orderMap.entries()) {
    if (statusCounts[data.status] !== undefined) {
      statusCounts[data.status]++;
    }
  }

  // Compute pending durations within the window
  const completedDurations = [];
  const activePendingOrders = [];

  for (const orderId in orderHistory) {
    const history = orderHistory[orderId];
    let pendingStartTime = null;

    history.forEach(state => {
      if (state.status === 'pending') {
        if (pendingStartTime === null) {
          pendingStartTime = state.time;
        }
      } else {
        if (pendingStartTime !== null) {
          completedDurations.push(state.time - pendingStartTime);
          pendingStartTime = null;
        }
      }
    });

    // Track active pending state if the order is still pending at window's end
    const currentStatus = orderMap.get(Number(orderId))?.status;
    if (currentStatus === 'pending' && pendingStartTime !== null) {
      activePendingOrders.push({
        orderId: Number(orderId),
        pendingStartTime,
        customerName: orderMap.get(Number(orderId))?.customer_name || 'unknown'
      });
    }
  }

  let avgPendingDuration = 0;
  if (completedDurations.length > 0) {
    avgPendingDuration = completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length;
  }

  const anomalies = [];
  const now = new Date();

  // If we have an average pending duration, flag orders that are pending 3x longer
  if (avgPendingDuration > 0) {
    activePendingOrders.forEach(order => {
      const activeDuration = now - order.pendingStartTime;
      if (activeDuration > 3 * avgPendingDuration) {
        anomalies.push({
          orderId: order.orderId,
          customerName: order.customerName,
          durationMs: activeDuration,
          avgDurationMs: avgPendingDuration,
          ratio: activeDuration / avgPendingDuration
        });
      }
    });
  }

  return {
    eventCount: events.length,
    opCounts,
    statusCounts,
    avgPendingDurationMs: avgPendingDuration,
    anomalies,
    events
  };
}

let lastInsightCache = {
  eventIdsString: '',
  insight: null
};

async function generatePeriodicInsight() {
  try {
    const context = await buildContextWindow({ minutes: 10 });
    
    if (context.eventCount === 0) {
      return {
        text: "No activity in the last 10 minutes.",
        generatedAt: new Date().toISOString(),
        basedOnEventCount: 0
      };
    }

    // Caching layer: Avoid calling Gemini API if the exact set of events in the window hasn't changed.
    const isTestEnv = process.env.NODE_ENV === 'test';
    const eventIdsString = context.events.map(e => e.id).sort((a, b) => a - b).join(',');
    
    if (!isTestEnv && lastInsightCache.eventIdsString === eventIdsString && lastInsightCache.insight) {
      logger.info('Returning cached AI operational summary (no event changes).');
      return {
        ...lastInsightCache.insight,
        generatedAt: new Date().toISOString() // Update timestamp to show it's active
      };
    }

    const prompt = `You are an AI Order Copilot. Here is the operational summary of the last 10 minutes:
Total events: ${context.eventCount}.
Operations count: INSERTs: ${context.opCounts.INSERT || 0}, UPDATEs: ${context.opCounts.UPDATE || 0}, DELETEs: ${context.opCounts.DELETE || 0}.
Current status breakdown: Pending: ${context.statusCounts.pending || 0}, Shipped: ${context.statusCounts.shipped || 0}, Delivered: ${context.statusCounts.delivered || 0}.
Average pending duration: ${Math.round(context.avgPendingDurationMs / 1000)} seconds.
Anomalies detected: ${context.anomalies.length > 0 
  ? context.anomalies.map(a => `Order #${a.orderId} for client ${a.customerName} has been pending for ${Math.round(a.durationMs / 1000)} seconds (3x the average of ${Math.round(a.avgDurationMs / 1000)}s).`).join(' ') 
  : 'None'}.

Write a 2-3 sentence plain-English operational summary based strictly on these numbers. Do not mention any other orders or numbers not provided. Keep it professional and concise.`;

    let text = await generateInsight(prompt);

    if (!text) {
      logger.warn('Gemini API call returned null (possibly rate-limited or unconfigured). Falling back to rule-based summary.');
      
      const anomalyText = context.anomalies.length > 0
        ? `Warning: ${context.anomalies.length} latency anomalies detected (orders pending > 3x average duration).`
        : 'No pending latency anomalies were detected.';
        
      text = `Operational Summary: Over the last 10 minutes, the system processed ${context.eventCount} total events (INSERTs: ${context.opCounts.INSERT || 0}, UPDATEs: ${context.opCounts.UPDATE || 0}, DELETEs: ${context.opCounts.DELETE || 0}). There are currently ${context.statusCounts.pending || 0} orders pending, ${context.statusCounts.shipped || 0} shipped, and ${context.statusCounts.delivered || 0} delivered. ${anomalyText}`;
    }

    const newInsight = {
      text,
      generatedAt: new Date().toISOString(),
      basedOnEventCount: context.eventCount
    };

    // Cache the insight
    if (!isTestEnv) {
      lastInsightCache = {
        eventIdsString,
        insight: newInsight
      };
    }

    return newInsight;
  } catch (err) {
    logger.error('Failed to generate periodic operational insight:', err);
    return {
      text: "Error generating periodic operational summary.",
      generatedAt: new Date().toISOString(),
      basedOnEventCount: 0
    };
  }
}

async function answerQuestion(question) {
  try {
    // Pull the last 60 minutes of events capped at 500 rows
    const query = `
      SELECT id, operation, order_id, payload, emitted_at
      FROM order_events
      WHERE emitted_at >= NOW() - INTERVAL '60 minutes'
      ORDER BY id ASC
      LIMIT 500;
    `;
    const result = await pool.query(query);
    const events = result.rows;

    const minId = events.length ? events[0].id : null;
    const maxId = events.length ? events[events.length - 1].id : null;

    const contextPayload = events.map(e => ({
      id: e.id,
      operation: e.operation,
      order_id: e.order_id,
      payload: e.payload,
      emitted_at: e.emitted_at
    }));

    const prompt = `You are an AI Order Copilot. Here is the context of order events from the last 60 minutes:
${JSON.stringify(contextPayload)}

Please answer the following user question based ONLY on the provided context. If the answer is not derivable from the provided context, respond exactly with 'I don't have data for that'. Do not make up or assume anything.

User Question: ${question}`;

    let answer = await generateInsight(prompt);
    if (!answer) {
      answer = "I don't have data for that";
    }

    return {
      answer,
      eventRange: { minId, maxId }
    };
  } catch (err) {
    logger.error('Failed to answer user question via Copilot:', err);
    return {
      answer: "I don't have data for that",
      eventRange: { minId: null, maxId: null }
    };
  }
}

module.exports = {
  buildContextWindow,
  generatePeriodicInsight,
  answerQuestion
};
