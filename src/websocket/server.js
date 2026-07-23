const ws = require('ws');
const url = require('url');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth');

// Map to track active client connections and their subscription filters
const clients = new Map();

function initWebSocketServer(server) {
  const wss = new ws.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    // Check pathname to only intercept WebSocket connections intended for /ws
    if (pathname !== '/ws') {
      return;
    }

    const parsedUrl = url.parse(request.url, true);
    let token = parsedUrl.query.token;

    // Standard fallback: parse from Sec-WebSocket-Protocol header
    if (!token && request.headers['sec-websocket-protocol']) {
      token = request.headers['sec-websocket-protocol'].trim();
    }

    try {
      const decoded = verifyToken(token);
      wss.handleUpgrade(request, socket, head, (wsClient) => {
        wss.emit('connection', wsClient, request, decoded);
      });
    } catch (err) {
      logger.warn(`WS connection upgrade rejected: ${err.message}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (wsClient, request, user) => {
    logger.info(`WebSocket client connected. User: ${user.username || 'unknown'}`);
    
    // Track connection with default empty filter set
    clients.set(wsClient, { filters: {}, user });

    // Send a welcome message
    wsClient.send(JSON.stringify({ type: 'INFO', message: 'Successfully connected and authenticated' }));

    wsClient.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'SUBSCRIBE') {
          const clientData = clients.get(wsClient);
          if (clientData) {
            clientData.filters = payload.filters || {};
            logger.info(`Client updated subscription filters: ${JSON.stringify(clientData.filters)}`);
            wsClient.send(JSON.stringify({ type: 'ACK', filters: clientData.filters }));
          }
        }
      } catch (err) {
        logger.error('Failed to parse client message:', err);
      }
    });

    wsClient.on('close', () => {
      logger.info('WebSocket client disconnected');
      clients.delete(wsClient);
    });

    wsClient.on('error', (err) => {
      logger.error('WebSocket client error:', err);
      clients.delete(wsClient);
    });
  });

  return wss;
}

module.exports = { initWebSocketServer, clients };
