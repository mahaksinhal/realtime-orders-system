#  Real-Time Orders System
the link for the live project : https://realtime-orders-app.onrender.com/

This repository implements a highly scalable real-time order update system using Node.js, PostgreSQL (LISTEN/NOTIFY), Redis (Pub/Sub), and WebSockets.

---

## 1. Architecture Overview

The system is designed for high throughput and horizontal scalability. By leveraging Redis Pub/Sub, multiple Node.js server instances can be run behind a load balancer while sharing database event broadcasts.

```text
  +------------------+
  | PostgreSQL Table |
  +--------+---------+
           | (Insert / Update / Delete)
           v
  +------------------+
  |  Trigger Function|
  +--------+---------+
           | (pg_notify)
           v
  +------------------+
  |  orders_channel  |
  +--------+---------+
           | (LISTEN)
           v
  +------------------+
  | Node.js Listener |
  +--------+---------+
           | (ioredis publish)
           v
  +------------------+
  |  Redis Pub/Sub   |
  +--------+---------+
           | (ioredis subscribe)
           v
  +------------------+
  | WebSocket Server |
  +--------+---------+
           | (Apply Client Filters & JWT Verification)
           v
  +------------------+
  |  Browser Client  |
  +------------------+
```

### Event Flow Pipeline
1. **Database Action**: A row is inserted, updated, or deleted in the `orders` table.
2. **Postgres Notification**: The database trigger function `notify_order_change` intercepts the action and broadcasts a JSON payload using `pg_notify` to the `orders_channel`.
3. **Database Listener**: A dedicated Postgres client in the Node.js process listens (`LISTEN orders_channel`) for events, receives them, and forwards them to the Redis Publisher.
4. **Redis Pub/Sub**: The publisher publishes the event to the Redis `"orders"` channel. All running application instances subscribed to this channel receive the message.
5. **WebSocket Broadcast**: Each instance parses the message and broadcasts it to its connected clients. Before sending, the client-specific filters are evaluated, ensuring clients only receive relevant updates.

---

## 2. Key Design Decisions & Scalability

- **PostgreSQL LISTEN/NOTIFY**: Replacing polling with native Postgres async notifications reduces database load and ensures sub-millisecond propagation latency.
- **Redis Pub/Sub Layer**: Enables horizontal scaling (scaling out). If you spin up multiple instances of the WebSocket server, each instance receives database updates via Redis and broadcasts them to its locally connected clients.
- **WebSocket Event Filtering**: Clients can supply subscription criteria (such as filtering by `customer_name`). Filtering occurs on the server-side, reducing unnecessary network overhead for client devices.
- **JWT Authentication**: Secure WebSocket handshakes prevent unauthorized clients from subscribing to the real-time order stream.
- **Structured Logging (Winston)**: Replaces standard `console.log` with JSON structured logging to facilitate log aggregation and monitoring.
- **Transaction-Linked Outbox Table (`order_events`)**: The database trigger function inserts events into `order_events` in the exact same transaction as it emits the `pg_notify`. This guarantees that the event outbox matches the live database state precisely and is resilient to system crashes, serving as a true append-only event source.
- **State Folded Event Sourcing**: The Time-Travel Replay engine dynamically rebuilds table state *purely* by applying the sequence of events (`INSERT`, `UPDATE`, `DELETE`) over time, never querying the live orders table. This validates the event outbox as a single source of truth.
- **LLM Grounding & Zero-Hallucination Guardrails**: The AI Copilot queries the database's `order_events` outbox to obtain deterministic aggregations, anomalies, and logs, passing this as strict context to Gemini. If the question cannot be answered using the provided context, the model is instructed to output a fallback rather than hallucinating answers.

---

## 3. Directory Structure

```text
realtime-orders-system/
├── db/
│   └── trigger.sql          # Postgres schema, outbox table, and pg_notify triggers
├── src/
│   ├── ai/
│   │   ├── geminiClient.js  # Thin HTTP-based wrapper for Gemini API
│   │   └── copilot.js       # Context window builder & operational summary generator
│   ├── db/
│   │   ├── client.js        # pg connection pool client
│   │   └── listener.js      # pg_notify LISTEN listener
│   ├── events/
│   │   ├── publisher.js     # Redis publisher client
│   │   └── subscriber.js    # Redis subscriber client
│   ├── middleware/
│   │   └── auth.js          # JWT authentication middleware
│   ├── replay/
│   │   └── reconstructor.js # Event sourcing folding and timeline scrubbing engine
│   ├── utils/
│   │   └── logger.js        # Winston structured logging utility
│   ├── websocket/
│   │   ├── server.js        # WebSocket server & JWT handshake
│   │   └── broadcast.js     # Event filtering & websocket broadcast
│   ├── app.js               # Express application routes & endpoints
│   └── index.js             # Server entry point and periodic insights scheduler
├── templates/
│   └── index.html           # Redesigned interactive glassmorphic frontend
├── tests/
│   ├── integration.test.js  # End-to-end WebSocket integration tests
│   ├── copilot.test.js      # Unit tests for AI Copilot anomaly detection
│   └── replay.test.js       # Unit tests for event-sourcing state reconstruction
├── Dockerfile               # Production Docker container definition
├── docker-compose.yml       # Local orchestration stack
├── package.json             # Node dependencies and npm scripts
└── .env                     # Local environment configurations
```

---

## 4. Setup & Running

### Environment Configuration
Create a `.env` file in the root directory (based on `.env.example`):
```env
PORT=8000
DATABASE_URL=postgresql://postgres:good23luck@localhost:5432/realtime_orders
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=super-secret-key-123
LOG_LEVEL=info
GEMINI_API_KEY=your-actual-gemini-api-key
INSIGHT_INTERVAL_MS=60000
```

### Option A: Local Setup
1. **Database Schema & Triggers**:
   Run the SQL file on your Postgres database:
   ```bash
   psql -U postgres -d realtime_orders -f db/trigger.sql
   ```
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Start the Application**:
   ```bash
   npm start
   ```

### Option B: Docker Compose
The docker-compose setup automatically provisions PostgreSQL (initializing the triggers from `db/trigger.sql`), Redis, and the Node.js application:
```bash
docker-compose up --build
```

---

## 5. Verification & Testing

### Automated Tests
Run the entire Jest integration and unit test suite:
```bash
npm test
```

### Manual Testing
1. Visit `http://localhost:8000/`.
2. Connect to the WebSocket (the page will automatically request a JWT and authenticate).
3. Insert or update an order via the dashboard creation form.
4. Set a filter (e.g. `Filter by Customer: Alice`) in the **WS Event Filters** card and submit a new order for `Bob` vs. `Alice` to verify server-side filtering.

---

## 6. Premium Features Demonstration Guide

### Feature 1: AI Order Copilot (Grounded Operational Insight)
- **What it does**: Periodically computes operational metrics (operation counts, status breakdowns, pending durations, and pending anomalies) from the database event outbox. It formats these metrics as a prompt for Gemini to generate a professional, natural-language business summary which is broadcast to all WebSocket clients.
- **Interactive Grounded Q&A**: Users can submit custom questions. The backend queries the last 60 minutes of events and instructs Gemini to answer *only* from that structured JSON context, returning the response alongside the specific event ID range for full auditable verification.
- **How to demo it**:
  1. Set a valid `GEMINI_API_KEY` in `.env` and start the server.
  2. Open the dashboard. Every 60 seconds (configurable via `INSIGHT_INTERVAL_MS`), the "AI Order Copilot" section on the right will update with a new operational summary (e.g. "Operations remained steady over the last 10 minutes with 4 orders processed...").
  3. Type a question in the "Ask operational questions" field: `How many orders did Alice place in the last hour?`
  4. Click **Ask AI**. The response will display the exact answer based strictly on events, accompanied by the audited range: `Audited Event ID range: 14 - 18`.

### Feature 2: Time-Travel Replay Debugger (Event-Sourcing Verification)
- **What it does**: Replays past database mutations sequentially in-memory to reconstruct the orders table state at *any* specific past second. It also exposes a timeline of events to drive step-by-step playback.
- **How to demo it**:
  1. Open the **Time Travel Debugger** panel in the center of the dashboard.
  2. Drag the **Scrubber Slider** backward. The dashboard enters historical view, displaying an amber banner: `⚠️ Showing Historical Reconstructed State`.
  3. As you scrub, the table updates to display the exact orders that existed at that precise timestamp.
  4. Select a speed (e.g. `2x Speed`) and click **Play**. The engine will step through events one by one, incrementally modifying the orders grid and pulsing/flashing the updated order card's border to visualize history as a recording playback.
  5. Click **Reset to Live** to return to the active real-time WebSocket event stream.

---

## 7. Contributors

- **Mahak Sinhal** (Lead Developer)

