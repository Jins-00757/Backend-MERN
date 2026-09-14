
import WebSocket from 'ws';
import NotificationService from '../services/NotificationService.js';
import { verifyToken } from './auth.js';

export const setupWebSocket = (server) => {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    try {
      const token = new URL(`http://localhost${req.url}`).searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const decoded = verifyToken(token);
      const userId = decoded.id;

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