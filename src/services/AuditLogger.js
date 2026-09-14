
import AuditLog from '../models/AuditLog.js';

class AuditLogger {
  async log(action, details) {
    try {
      const logEntry = new AuditLog({
        action,
        userId: details.userId,
        resourceType: details.resourceType,
        resourceId: details.resourceId,
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

      if (userId) query.userId = userId;
      if (resourceType) query.resourceType = resourceType;
      if (action) query.action = action;

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