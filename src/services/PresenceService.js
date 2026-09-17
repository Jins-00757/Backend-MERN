
/**
 * PresenceService - in-memory tracking of who's online and who's currently
 * viewing which record, backing the Socket.IO presence layer (see
 * realtime/socketServer.js). Mirrors NotificationService's existing pattern
 * (a singleton, in-process Map) for consistency - and shares the same
 * single-instance limitation: this does not fan out across multiple server
 * processes/hosts. If this app is ever scaled horizontally, both this and
 * NotificationService would need a shared backing store (e.g. Redis, which
 * this app already runs - see config/redisClient.js) instead of local Maps.
 *
 * One user can have multiple open sockets (multiple tabs/devices) - a socket
 * id, not a user id, is the true "connection" unit, so "online" only
 * flips to false once every one of a user's sockets has disconnected.
 */
class PresenceService {
  constructor() {
    // userId -> { name, email, socketIds: Set<socketId> }
    this.users = new Map();
    // roomKey (`${resourceType}:${resourceId}`) -> Map<userId, { name, socketIds: Set<socketId> }>
    this.rooms = new Map();
  }

  /** Returns true if this is the user's first active connection (came online). */
  addUser(userId, meta, socketId) {
    let entry = this.users.get(userId);
    if (!entry) {
      entry = { ...meta, socketIds: new Set() };
      this.users.set(userId, entry);
    }
    const wasOffline = entry.socketIds.size === 0;
    entry.socketIds.add(socketId);
    return wasOffline;
  }

  /** Returns true if this was the user's last active connection (went offline). */
  removeUser(userId, socketId) {
    const entry = this.users.get(userId);
    if (!entry) return false;
    entry.socketIds.delete(socketId);
    if (entry.socketIds.size === 0) {
      this.users.delete(userId);
      return true;
    }
    return false;
  }

  getOnlineUsers() {
    return Array.from(this.users.entries()).map(([userId, entry]) => ({
      userId,
      name: entry.name,
      email: entry.email,
    }));
  }

  joinRecord(roomKey, userId, meta, socketId) {
    let room = this.rooms.get(roomKey);
    if (!room) {
      room = new Map();
      this.rooms.set(roomKey, room);
    }
    let viewer = room.get(userId);
    if (!viewer) {
      viewer = { ...meta, socketIds: new Set() };
      room.set(userId, viewer);
    }
    viewer.socketIds.add(socketId);
    return this.getRecordViewers(roomKey);
  }

  leaveRecord(roomKey, userId, socketId) {
    const room = this.rooms.get(roomKey);
    if (room) {
      const viewer = room.get(userId);
      if (viewer) {
        viewer.socketIds.delete(socketId);
        if (viewer.socketIds.size === 0) room.delete(userId);
      }
      if (room.size === 0) this.rooms.delete(roomKey);
    }
    return this.getRecordViewers(roomKey);
  }

  /**
   * Called on socket disconnect - a browser tab closing/refreshing never
   * sends an explicit 'record:leave' for whatever record it had open, so
   * this sweeps every room for the departing socket id instead of relying
   * on the client to clean up after itself.
   */
  leaveAllRecords(socketId) {
    const affectedRoomKeys = [];
    for (const [roomKey, room] of this.rooms.entries()) {
      for (const viewer of room.values()) {
        if (viewer.socketIds.has(socketId)) {
          affectedRoomKeys.push(roomKey);
          break;
        }
      }
    }

    return affectedRoomKeys.map((roomKey) => {
      const room = this.rooms.get(roomKey);
      for (const [userId, viewer] of room.entries()) {
        if (viewer.socketIds.has(socketId)) {
          viewer.socketIds.delete(socketId);
          if (viewer.socketIds.size === 0) room.delete(userId);
        }
      }
      if (room.size === 0) this.rooms.delete(roomKey);
      return { roomKey, viewers: this.getRecordViewers(roomKey) };
    });
  }

  getRecordViewers(roomKey) {
    const room = this.rooms.get(roomKey);
    if (!room) return [];
    return Array.from(room.entries()).map(([userId, viewer]) => ({ userId, name: viewer.name }));
  }
}

export default new PresenceService();
