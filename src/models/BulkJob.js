
import mongoose from 'mongoose';

const bulkJobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    jobId: {
      type: String,
      unique: true,
      required: true,
    },
    operation: {
      type: String,
      enum: ['insert', 'update', 'upsert', 'delete'],
      required: true,
    },
    objectType: {
      type: String,
      enum: ['Opportunity', 'Account', 'Contact', 'Task'],
      required: true,
    },
    status: {
      type: String,
      enum: [
        'queued',
        'in_progress',
        'completed',
        'failed',
        'aborted',
      ],
      default: 'queued',
    },
    totalRecords: Number,
    successfulRecords: {
      type: Number,
      default: 0,
    },
    failedRecords: {
      type: Number,
      default: 0,
    },
    recordsProcessed: {
      type: Number,
      default: 0,
    },
    jobData: [
      {
        recordIndex: Number,
        record: mongoose.Schema.Types.Mixed,
        sfId: String,
        status: String,
        error: String,
      },
    ],
    salesforceJobId: String, // Reference to Salesforce Bulk API job
    stateDetail: String,
    duration: Number, // milliseconds
    startedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
bulkJobSchema.index({ userId: 1, createdAt: -1 });
bulkJobSchema.index({ jobId: 1 });
bulkJobSchema.index({ status: 1 });

export default mongoose.model('BulkJob', bulkJobSchema);