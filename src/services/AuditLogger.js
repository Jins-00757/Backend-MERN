
import AuditLog from '../models/AuditLog.js';

class AuditLogger {
  async log(action, details) {
    try {
      const logEntry = new AuditLog({
        action,
        userId: details.userId,
        resourceType: details.resourceType,
        resourceId: details.resourceId,
        eventType: details.eventType,
        title: details.title,
        message: details.message,
        changes: details.changes,
        ipAddress: details.ipAddress,
        userAgent: details.userAgent,
        status: details.status || 'success',
        errorMessage: details.errorMessage,
        timestamp: new Date(),
      });

      await logEntry.save();
      return logEntry;
    } catch (error) {
      console.error('Audit logging failed:', error);
    }
  }

  async getAuditTrail(filters = {}, pagination = {}) {
    try {
      const {
        userId,
        resourceType,
        action,
        startDate,
        endDate,
      } = filters;

      const {
        page = 1,
        limit = 50,
      } = pagination;

      const query = {};

      // resourceType/action may be a single value (existing callers) or an
      // array (the cross-entity activity feed, which wants e.g. every CRM
      // object type but only real data-changing actions - not LOGIN/EXPORT/
      // NOTIFY noise) - $in degrades to an exact match for a single-element
      // array, so this is purely additive.
      if (userId) query.userId = userId;
      if (resourceType) query.resourceType = Array.isArray(resourceType) ? { $in: resourceType } : resourceType;
      if (action) query.action = Array.isArray(action) ? { $in: action } : action;

      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      const skip = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        AuditLog.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit),
        AuditLog.countDocuments(query),
      ]);

      return {
        data: logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      throw new Error(`Audit trail retrieval failed: ${error.message}`);
    }
  }

  async getChangeSummary(resourceId, resourceType) {
    try {
      const logs = await AuditLog.find({
        resourceId,
        resourceType,
      }).sort({ timestamp: -1 });

      return logs.map((log) => ({
        timestamp: log.timestamp,
        action: log.action,
        changes: log.changes,
        userId: log.userId,
      }));
    } catch (error) {
      throw new Error(`Change summary retrieval failed: ${error.message}`);
    }
  }
}

export default new AuditLogger();