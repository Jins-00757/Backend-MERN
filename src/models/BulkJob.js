
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

    // Data integrity / file security (see csvUpload.js, uploadBulkDataFile)
    sourceFileHash: String, // SHA-256 of the raw uploaded CSV bytes
    sourceFileName: String, // original client-supplied filename, display only - never used as a path
    sourceFileSize: Number, // bytes
    invalidRecords: [
      {
        recordIndex: Number,
        record: mongoose.Schema.Types.Mixed,
        error: String,
      },
    ], // rows rejected by per-record validation before ever reaching Salesforce
    createdIp: String,
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