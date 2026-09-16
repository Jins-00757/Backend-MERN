
import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        'CREATE',
        'READ',
        'UPDATE',
        'DELETE',
        'LOGIN',
        'LOGOUT',
        'EXPORT',
        'IMPORT',
        'NOTIFY',
      ],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    resourceType: String,
    resourceId: String,
    // Domain-specific event key (e.g. 'lead.converted', 'opportunity.closed')
    // and the same human-readable title/message NotificationService.notify()
    // broadcasts live over WebSocket - persisting them here too means a
    // historical entry (fetched later via getAuditTrail) and a live event
    // render through the exact same code on the frontend, with no need to
    // reconstruct "what happened" from `changes` after the fact. Optional/
    // unindexed since older rows predate this and simply won't have them.
    eventType: String,
    title: String,
    message: String,
    changes: mongoose.Schema.Types.Mixed,
    ipAddress: String,
    userAgent: String,
    status: {
      type: String,
      enum: ['success', 'failure'],
      default: 'success',
    },
    errorMessage: String,
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Indexes
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });
auditLogSchema.index({ action: 1 });

export default mongoose.model('AuditLog', auditLogSchema);