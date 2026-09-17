
import { soqlEscape } from './salesforceService.js';
import ConflictLog from '../models/ConflictLog.js';
import AuditLogger from '../services/AuditLogger.js';

/**
 * Conflict Resolution Model for the bi-directional Salesforce sync.
 *
 * The problem: this app and Salesforce (via its own UI, or another
 * integration) can both write the same record. Blindly PATCHing whatever a
 * user's edit form had loaded - the app's behavior before this file existed
 * - silently overwrites anything anyone else changed in between, with no
 * trace it ever happened. That is the "silent data corruption" a
 * bi-directional integration is guaranteed to hit without a real model.
 *
 * The model here is optimistic concurrency control with a field-level
 * three-way merge, not last-write-wins and not a hard lock:
 *   1. Every edit form captures the record's LastModifiedDate at load time
 *      (the "base") and the base value of each field it's about to change.
 *   2. On save, the field checks whether the live LastModifiedDate is newer
 *      than that base. If not, nothing else has touched the record - apply
 *      the change immediately, no extra Salesforce round trip needed beyond
 *      the one this check already made.
 *   3. If it IS newer, each field being changed is compared three ways:
 *      base (what the user started from), live (what's there now), and
 *      incoming (what the user wants to set it to).
 *        - live === base            -> nobody else touched this field; safe
 *                                       to apply the user's change.
 *        - live === incoming        -> coincidentally the same outcome;
 *                                       nothing to resolve.
 *        - otherwise                -> a genuine conflict: two different
 *                                       values were written to the same
 *                                       field from a common ancestor. This
 *                                       is surfaced to the user rather than
 *                                       silently picking a winner.
 *   4. A record with conflicts is never partially saved - the whole update
 *      is rejected (409) with the conflicting fields, so the caller can
 *      resolve them (see markConflictResolved) and retry with the same
 *      endpoint, rather than ending up with some fields silently merged and
 *      others silently dropped.
 */

// Loose-equality comparison for values that arrive in different shapes from
// the two sides of this sync (Salesforce sends Amount as a number but a form
// field's "unchanged" value might be a numeric string; CloseDate/
// ExpirationDate are plain Salesforce Date fields so a string compare is
// exact, but this still normalizes them defensively).
const normalizeForCompare = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate) && /^\d{4}-\d{2}-\d{2}/.test(trimmed)) return asDate;

  return trimmed;
};

const valuesEqual = (a, b) => normalizeForCompare(a) === normalizeForCompare(b);

/**
 * Pure diff logic, exported separately so it can be exercised directly in
 * tests without a live Salesforce connection (see checkConflict below for
 * the version that actually fetches the live record).
 */
export const computeConflict = ({ baseLastModifiedDate, liveRecord, baseValues, changedFields }) => {
  const liveModified = new Date(liveRecord.LastModifiedDate).getTime();
  const baseModified = new Date(baseLastModifiedDate).getTime();

  if (!(liveModified > baseModified)) {
    return { status: 'clean', changes: changedFields };
  }

  const conflicts = [];
  const safeChanges = {};

  for (const field of Object.keys(changedFields)) {
    const baseValue = baseValues?.[field];
    const liveValue = liveRecord[field];
    const incomingValue = changedFields[field];

    if (valuesEqual(liveValue, baseValue) || valuesEqual(liveValue, incomingValue)) {
      safeChanges[field] = incomingValue;
    } else {
      conflicts.push({ field, baseValue, liveValue, incomingValue });
    }
  }

  if (conflicts.length > 0) {
    return { status: 'conflict', conflicts, liveRecord };
  }

  // Every field resolved safely, but the record *did* change elsewhere
  // (some field not in this update, or one that coincidentally matched) -
  // worth telling the caller a merge happened, even though nothing needs
  // manual resolution.
  return { status: 'merged', changes: safeChanges, liveRecord };
};

/**
 * checkConflict - fetches the live record (scoped to only the fields being
 * changed, whitelisted against `updatableFields` so a client can never widen
 * this dynamic SELECT to an arbitrary column - field *names* aren't
 * parameterizable in SOQL the way values are via soqlEscape) and runs
 * computeConflict against it.
 *
 * Returns one of:
 *   { status: 'no-baseline', changes }  - caller sent no baseLastModifiedDate
 *                                          (e.g. an older client); nothing to
 *                                          check against, proceed as-is.
 *   { status: 'deleted' }               - the record no longer exists.
 *   { status: 'clean' | 'merged', changes, liveRecord? }
 *   { status: 'conflict', conflicts, liveRecord }
 */
export const checkConflict = async ({ salesforce, objectType, recordId, updatableFields, baseLastModifiedDate, baseValues, changedFields }) => {
  if (!baseLastModifiedDate) {
    return { status: 'no-baseline', changes: changedFields };
  }

  const fieldsToCheck = Object.keys(changedFields).filter((field) => updatableFields.includes(field));
  const selectFields = ['Id', 'LastModifiedDate', ...fieldsToCheck];
  const soql = `SELECT ${selectFields.join(', ')} FROM ${objectType} WHERE Id = '${soqlEscape(recordId)}'`;

  const result = await salesforce.query(soql);
  if (result.records.length === 0) {
    return { status: 'deleted' };
  }

  return computeConflict({ baseLastModifiedDate, liveRecord: result.records[0], baseValues, changedFields });
};

export const logConflict = async ({ objectType, recordId, userId, conflicts, baseLastModifiedDate, liveLastModifiedDate, ipAddress, userAgent }) => {
  const log = await ConflictLog.create({
    recordType: objectType,
    recordId,
    userId,
    conflictingFields: conflicts.map((c) => c.field),
    baseLastModifiedDate: new Date(baseLastModifiedDate),
    liveLastModifiedDateAtDetection: new Date(liveLastModifiedDate),
    detectedValues: conflicts,
    status: 'detected',
  });

  AuditLogger.log('UPDATE', {
    userId,
    resourceType: objectType,
    resourceId: recordId,
    eventType: `${objectType.toLowerCase()}.conflict_detected`,
    title: 'Edit conflict detected',
    message: `A concurrent edit conflict was detected on: ${conflicts.map((c) => c.field).join(', ')}`,
    changes: { conflictingFields: conflicts.map((c) => c.field) },
    status: 'failure',
    errorMessage: 'Concurrent edit conflict',
    ipAddress,
    userAgent,
  }).catch((err) => console.error('Failed to audit-log conflict detection:', err.message));

  return log;
};

export const markConflictResolved = (conflictLogId, resolution) => {
  if (!conflictLogId) return;
  ConflictLog.findByIdAndUpdate(conflictLogId, {
    status: 'resolved',
    resolution,
    resolvedAt: new Date(),
  }).catch((err) => console.error('Failed to mark conflict resolved:', err.message));
};

export const buildConflictResponse = ({ objectType, recordId, conflictLogId, conflicts, liveRecord }) => ({
  success: false,
  code: 'CONFLICT',
  message: `This ${objectType.toLowerCase()} was changed by someone else since you loaded it. Review the differences below.`,
  data: {
    conflictLogId,
    recordType: objectType,
    recordId,
    conflicts,
    liveRecord,
    liveLastModifiedDate: liveRecord.LastModifiedDate,
  },
});

export const buildDeletedConflictResponse = (objectType, recordId) => ({
  success: false,
  code: 'CONFLICT_DELETED',
  message: `This ${objectType.toLowerCase()} was deleted by someone else since you loaded it.`,
  data: { recordType: objectType, recordId },
});
