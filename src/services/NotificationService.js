
import EventEmitter from 'events';

class NotificationService extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.subscriptions = new Map();
  }

  addConnection(userId, socket) {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, []);
    }
    this.connections.get(userId).push(socket);
  }

  removeConnection(userId, socket) {
    const sockets = this.connections.get(userId);
    if (sockets) {
      const index = sockets.indexOf(socket);
      if (index > -1) {
        sockets.splice(index, 1);
      }
    }
  }

  subscribe(userId, eventType) {
    if (!this.subscriptions.has(userId)) {
      this.subscriptions.set(userId, new Set());
    }
    this.subscriptions.get(userId).add(eventType);
  }

  unsubscribe(userId, eventType) {
    const subs = this.subscriptions.get(userId);
    if (subs) {
      subs.delete(eventType);
    }
  }

  notify(userId, eventType, data) {
    const sockets = this.connections.get(userId);
    const subscriptions = this.subscriptions.get(userId) || new Set();

    if (sockets && subscriptions.has(eventType)) {
      const notification = {
        type: eventType,
        data,
        timestamp: new Date(),
      };

      sockets.forEach((socket) => {
        if (socket.readyState === 1) { // WebSocket.OPEN
          socket.send(JSON.stringify(notification));
        }
      });
    }
  }

  broadcastToUser(userId, message) {
    const sockets = this.connections.get(userId);
    if (sockets) {
      sockets.forEach((socket) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(message));
        }
      });
    }
  }
}

export default new NotificationService();