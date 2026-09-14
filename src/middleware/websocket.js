
import { WebSocketServer } from 'ws';
import { parseCookie as parseCookies } from 'cookie';
import NotificationService from '../services/NotificationService.js';
import { verifyToken } from '../services/tokenService.js';

/**
 * Real-time notifications over WebSocket, authenticated the same way as the
 * rest of the app: the httpOnly `token` cookie set by login/signup (see
 * services/tokenService.js). The frontend can't read that cookie's value to
 * pass it as a `?token=` query param - it doesn't need to, since browsers
 * attach cookies to the WebSocket upgrade request automatically for
 * same-site connections.
 */
export const setupWebSocket = (server) => {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    try {
      const cookies = parseCookies(req.headers.cookie || '');
      const token = cookies.token;
      const decoded = token ? verifyToken(token) : null;

      if (!decoded) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const userId = decoded._id;

      NotificationService.addConnection(userId, ws);

      ws.on('message', (message) => {
        try {
          const parsed = JSON.parse(message);

          if (parsed.type === 'subscribe') {
            NotificationService.subscribe(userId, parsed.eventType);
          } else if (parsed.type === 'unsubscribe') {
            NotificationService.unsubscribe(userId, parsed.eventType);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      });

      ws.on('close', () => {
        NotificationService.removeConnection(userId, ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        NotificationService.removeConnection(userId, ws);
      });
    } catch (error) {
      console.error('WebSocket connection error:', error);
      ws.close(4000, 'Authentication failed');
    }
  });

  return wss;
};
