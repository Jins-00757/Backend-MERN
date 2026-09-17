
import mongoose from 'mongoose';

/**
 * ConflictLog - every detected concurrent-edit collision on a bi-directionally
 * synced record (Opportunity, Quote, ...), whether it was resolved or not.
 * See services/conflictResolutionService.js for the detection logic that
 * populates this, and controllers/opportunitiesController.js /
 * quotesController.js for where it's wired into an update endpoint.
 *
 * This exists for two reasons beyond the immediate save flow: (1) an audit
 * trail of who overrode what when two people (or a person and a direct
 * Salesforce edit) touched the same record - "silent data corruption" is
 * exactly what a bi-directional sync risks without one; (2) an operational
 * signal - a record or field that conflicts often points at a real process
 * problem (e.g. two reps who should coordinate, or a field a Salesforce
 * automation and this app both write to).
 */
const conflictLogSchema = new mongoose.Schema(
  {
    recordType: {
      type: String,
      required: true,
      enum: ['Opportunity', 'Quote'],
    },
    recordId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    conflictingFields: [String],
    baseLastModifiedDate: Date,
    liveLastModifiedDateAtDetection: Date,
    // [{ field, baseValue, liveValue, incomingValue }] - the exact 3-way diff
    // computed at detection time (see conflictResolutionService.computeConflict).
    detectedValues: mongoose.Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['detected', 'resolved'],
      default: 'detected',
      index: true,
    },
    // The field values actually applied once the user resolved the
    // conflict (their per-field choice of "mine"/"theirs"/custom) - set when
    // status transitions to 'resolved'.
    resolution: mongoose.Schema.Types.Mixed,
    resolvedAt: Date,
  },
  { timestamps: true }
);

conflictLogSchema.index({ recordType: 1, recordId: 1, createdAt: -1 });

export default mongoose.model('ConflictLog', conflictLogSchema);
