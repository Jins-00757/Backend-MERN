
import mongoose from 'mongoose';

const syncLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    syncType: {
      type: String,
      enum: [
        'opportunities',
        'accounts',
        'contacts',
        'all',
        'manual',
        'automatic',
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed', 'partial'],
      default: 'pending',
    },
    recordsProcessed: {
      type: Number,
      default: 0,
    },
    recordsCreated: {
      type: Number,
      default: 0,
    },
    recordsUpdated: {
      type: Number,
      default: 0,
    },
    recordsDeleted: {
      type: Number,
      default: 0,
    },
    recordsSkipped: {
      type: Number,
      default: 0,
    },
    // Named syncErrors (not `errors`) - Mongoose reserves `errors` for its
    // own document-validation state, and shadowing it produces the
    // "reserved schema pathname" warning plus unpredictable reads.
    syncErrors: [
      {
        recordId: String,
        field: String,
        error: String,
        timestamp: Date,
      },
    ],
    duration: Number, // milliseconds
    startedAt: Date,
    completedAt: Date,
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
syncLogSchema.index({ userId: 1, createdAt: -1 });
syncLogSchema.index({ userId: 1, status: 1 });

export default mongoose.model('SyncLog', syncLogSchema);