
import { Server } from 'socket.io';
import { parseCookie as parseCookies } from 'cookie';
import { verifyToken } from '../services/tokenService.js';
import { config } from '../config/env.js';
import User from '../models/User.js';
import PresenceService from '../services/PresenceService.js';

/**
 * Real-time multi-user presence, over Socket.IO - deliberately a SEPARATE
 * server/path ('/socket.io') from the existing plain-`ws` notification
 * channel (see middleware/websocket.js, mounted at '/ws'). Both can run on
 * the same underlying HTTP server without conflict (Socket.IO and `ws`
 * negotiate independently by path), so this is purely additive: every
 * existing notification feature keeps working exactly as before, untouched.
 *
 * Authenticated the same way as every other real-time/HTTP connection in
 * this app: the httpOnly `token` cookie set by login/signup - the browser
 * attaches it to the Socket.IO handshake automatically for same-site
 * requests, same as the `ws` connection already does.
 */
export const setupSocketIO = (server) => {
  const io = new Server(server, {
    path: '/socket.io',
    cors: {
      origin: config.clientUrl,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie || '');
      const token = cookies.token;
      const decoded = token ? verifyToken(token) : null;

      if (!decoded) {
        return next(new Error('Unauthorized'));
      }

      // The JWT payload only carries _id/email/role (see tokenService.
      // generateToken) - presence needs a human-readable name for avatars/
      // tooltips, which means one extra lookup per new connection (not per
      // message), same tradeoff middleware/auth.js's protect() already makes
      // for every plain HTTP request.
      const user = await User.findById(decoded._id).select('name email isInactive').lean();
      if (!user || user.isInactive) {
        return next(new Error('Unauthorized'));
      }

      socket.userId = decoded._id;
      socket.userMeta = { name: user.name, email: user.email };
      next();
    } catch (error) {
      console.error('Socket.IO auth error:', error.message);
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, userMeta } = socket;

    const wentOnline = PresenceService.addUser(userId, userMeta, socket.id);
    if (wentOnline) {
      socket.broadcast.emit('presence:online', { userId, ...userMeta });
    }
    // Every new connection gets the full current roster, regardless of
    // whether this particular user was already online from another
    // tab/device - this is what lets a client render its initial "who's
    // online" list without a separate REST round trip.
    socket.emit('presence:roster', PresenceService.getOnlineUsers());

    // Per-record presence - joined when a user opens a record for
    // viewing/editing (e.g. QuoteBuilder, the Opportunity edit modal) so
    // everyone else looking at that same record sees "Jane is also viewing
    // this". This is a soft, informational early-warning only - the actual
    // conflict model (see services/conflictResolutionService.js) is what
    // authoritatively catches and resolves a real concurrent-edit collision
    // if two people save anyway.
    socket.on('record:join', ({ resourceType, resourceId } = {}) => {
      if (!resourceType || !resourceId) return;
      const roomKey = `${resourceType}:${resourceId}`;
      socket.join(roomKey);
      (socket.data.rooms ??= new Set()).add(roomKey);

      const viewers = PresenceService.joinRecord(roomKey, userId, userMeta, socket.id);
      io.to(roomKey).emit('record:presence', { resourceType, resourceId, viewers });
    });

    socket.on('record:leave', ({ resourceType, resourceId } = {}) => {
      if (!resourceType || !resourceId) return;
      const roomKey = `${resourceType}:${resourceId}`;
      socket.leave(roomKey);
      socket.data.rooms?.delete(roomKey);

      const viewers = PresenceService.leaveRecord(roomKey, userId, socket.id);
      io.to(roomKey).emit('record:presence', { resourceType, resourceId, viewers });
    });

    socket.on('disconnect', () => {
      const wentOffline = PresenceService.removeUser(userId, socket.id);
      if (wentOffline) {
        socket.broadcast.emit('presence:offline', { userId });
      }

      // A closed/refreshed tab never gets the chance to emit 'record:leave'
      // for whatever it had open - sweep every room this socket was in.
      PresenceService.leaveAllRecords(socket.id).forEach(({ roomKey, viewers }) => {
        const [resourceType, resourceId] = roomKey.split(':');
        io.to(roomKey).emit('record:presence', { resourceType, resourceId, viewers });
      });
    });
  });

  return io;
};
