

import { readFile } from 'fs/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import SalesforceService, { EXPORT_OBJECT_CONFIG } from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';
import BulkJob from '../models/BulkJob.js';
import AuditLogger from '../services/AuditLogger.js';
import { sha256Hex } from '../services/encryptionService.js';
import { cleanupUpload } from '../middleware/csvUpload.js';
import ExportService from '../services/ExportService.js';
import { createDownloadToken } from '../services/downloadTokenService.js';

/**
 * Bulk API 2.0's successfulResults/failedResults endpoints return a raw CSV
 * response body, not JSON - parse it into row objects so callers get a real
 * array (and an accurate .length) instead of a CSV string.
 */
const parseBulkResultsCsv = (csv) => {
  if (!csv || !csv.trim()) return [];
  return parseCsv(csv, { columns: true, skip_empty_lines: true });
};

// Mirrors the required-field rules already enforced by this app's own
// single-record create endpoints (see createOpportunity/createAccount/
// createContact) - a bulk `insert` is really N of those same creates, so it
// should reject the same malformed records instead of forwarding them to
// Salesforce's Bulk API and only finding out they failed minutes later.
const REQUIRED_FIELDS_BY_OBJECT = {
  Opportunity: ['Name', 'StageName', 'CloseDate', 'AccountId'],
  Account: ['Name'],
  Contact: ['LastName', 'AccountId'],
  Task: ['Subject'],
};

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

// A few genuinely useful optional columns per object, added to
// REQUIRED_FIELDS_BY_OBJECT above when building a downloadable import
// template (getImportTemplate) - enough to show the shape of a real row
// without listing every field Salesforce accepts.
const TEMPLATE_OPTIONAL_FIELDS = {
  Opportunity: ['Amount', 'Probability', 'Description'],
  Account: ['Industry', 'Phone', 'Website', 'BillingCity', 'BillingState'],
  Contact: ['FirstName', 'Email', 'Phone', 'Title'],
  Task: ['Description', 'Priority', 'ActivityDate'],
};

// Realistic placeholder values for the template's one example data row,
// keyed by field name - shared across objects since e.g. "Phone" means the
// same thing everywhere. Any column without an entry here just falls back
// to the literal word "value".
const TEMPLATE_SAMPLE_VALUES = {
  Id: '006XXXXXXXXXXXXXXX',
  Name: 'New Deal',
  StageName: 'Prospecting',
  CloseDate: '2026-12-31',
  AccountId: '001XXXXXXXXXXXXXXX',
  LastName: 'Doe',
  FirstName: 'Jane',
  Email: 'jane.doe@example.com',
  Phone: '+1-555-0100',
  Title: 'Buyer',
  Subject: 'Follow up call',
  Amount: '50000',
  Probability: '60',
  Description: 'Optional notes',
  Industry: 'Technology',
  Website: 'https://example.com',
  BillingCity: 'San Francisco',
  BillingState: 'CA',
  Priority: 'Normal',
  ActivityDate: '2026-01-15',
};

const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Validate every record before it's ever sent to Salesforce, splitting the
 * batch into what's safe to submit vs what should be rejected up front.
 *  - insert: every field in REQUIRED_FIELDS_BY_OBJECT[objectType] must be
 *    present and non-blank (same rule the single-record create endpoints use).
 *  - update / delete: each record must carry an `Id` - there's no other way
 *    to know which Salesforce record it refers to.
 *  - upsert: Salesforce allows matching on Id OR an external ID field, which
 *    this app has no way to know ahead of time, so only a basic "is this a
 *    non-empty object" sanity check applies here - Salesforce itself is the
 *    authority on whether the chosen match field is valid.
 */
const validateRecordsForImport = (objectType, operation, records) => {
  const validRecords = [];
  const invalidRecords = [];

  records.forEach((record, recordIndex) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalidRecords.push({ recordIndex, record, error: 'Row is not a valid record object' });
      return;
    }

    if (operation === 'insert') {
      const missing = (REQUIRED_FIELDS_BY_OBJECT[objectType] || []).filter((field) => isBlank(record[field]));
      if (missing.length > 0) {
        invalidRecords.push({ recordIndex, record, error: `Missing required field(s): ${missing.join(', ')}` });
        return;
      }
    } else if (operation === 'update' || operation === 'delete') {
      if (isBlank(record.Id)) {
        invalidRecords.push({ recordIndex, record, error: 'Missing required field: Id' });
        return;
      }
    }

    validRecords.push(record);
  });

  return { validRecords, invalidRecords };
};

/**
 * @route   POST /api/salesforce/bulk/create-job
 * @desc    Create a new bulk job
 * @access  Private
 */
export const createBulkJob = async (req, res) => {
  try {
    const { operation, objectType } = req.body;

    // Validation
    if (!operation || !objectType) {
      return res.status(400).json({
        success: false,
        message: 'Operation and object type are required',
      });
    }

    const validOperations = ['insert', 'update', 'upsert', 'delete'];
    const validObjects = ['Opportunity', 'Account', 'Contact', 'Task'];

    if (!validOperations.includes(operation)) {
      return res.status(400).json({
        success: false,
        message: `Invalid operation. Must be one of: ${validOperations.join(', ')}`,
      });
    }

    if (!validObjects.includes(objectType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid object type. Must be one of: ${validObjects.join(', ')}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const jobResponse = await salesforce.createBulkJob(operation, objectType);

    // Create job record in database
    const jobId = `bulk_${req.user._id}_${Date.now()}`;
    const bulkJob = new BulkJob({
      userId: req.user._id,
      jobId,
      operation,
      objectType,
      status: 'queued',
      salesforceJobId: jobResponse.id,
      startedAt: new Date(),
      createdIp: req.ip,
    });

    await bulkJob.save();

    AuditLogger.log('CREATE', {
      userId: req.user._id,
      resourceType: 'BulkJob',
      resourceId: jobId,
      changes: { operation, objectType, salesforceJobId: jobResponse.id },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk job creation:', err.message));

    res.status(201).json({
      success: true,
      message: 'Bulk job created successfully',
      data: {
        id: jobId,
        salesforceJobId: jobResponse.id,
        state: jobResponse.state,
      },
    });
  } catch (error) {
    console.error('Error creating bulk job:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Shared core of both upload endpoints below (raw JSON array and CSV file):
 * validate every record, submit only the valid ones to Salesforce, and
 * persist the outcome - including the rejected rows - on the BulkJob so
 * getBulkJobStatus/Results can report exactly what was and wasn't
 * accepted. Throws (rather than writing a response itself) so each caller
 * keeps control of its own success/error response shape and any
 * source-specific fields (sourceFileHash etc).
 */
const submitValidatedRecords = async (req, bulkJob, records, sourceMeta = {}) => {
  const { validRecords, invalidRecords } = validateRecordsForImport(
    bulkJob.objectType,
    bulkJob.operation,
    records
  );

  if (validRecords.length === 0) {
    const err = new Error('No valid records to upload - every row failed validation');
    err.status = 400;
    err.invalidRecords = invalidRecords;
    throw err;
  }

  const salesforce = new SalesforceService(req.user);
  const uploadResponse = await salesforce.uploadBulkData(bulkJob.salesforceJobId, validRecords);

  bulkJob.status = 'in_progress';
  bulkJob.totalRecords = validRecords.length;
  bulkJob.jobData = validRecords.map((record, index) => ({
    recordIndex: index,
    record,
    status: 'pending',
  }));
  bulkJob.invalidRecords = invalidRecords;
  Object.assign(bulkJob, sourceMeta);

  await bulkJob.save();
  await cacheService.delete(`bulk_status_${req.user._id}_${bulkJob.jobId}`);

  return { uploadResponse, validRecords, invalidRecords };
};

const loadQueuedBulkJob = async (jobId, userId) => {
  const bulkJob = await BulkJob.findOne({ jobId, userId });
  if (!bulkJob) {
    const err = new Error('Bulk job not found');
    err.status = 404;
    throw err;
  }
  if (bulkJob.status !== 'queued') {
    const err = new Error(`Cannot upload to job with status: ${bulkJob.status}`);
    err.status = 400;
    throw err;
  }
  return bulkJob;
};

/**
 * @route   POST /api/salesforce/bulk/:jobId/upload
 * @desc    Upload data to bulk job as a raw JSON array
 * @access  Private
 */
export const uploadBulkData = async (req, res) => {
  const { jobId } = req.params;

  try {
    const records = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Records must be a non-empty array',
      });
    }

    const bulkJob = await loadQueuedBulkJob(jobId, req.user._id);
    const { uploadResponse, validRecords, invalidRecords } = await submitValidatedRecords(req, bulkJob, records);

    AuditLogger.log('IMPORT', {
      userId: req.user._id,
      resourceType: 'BulkJob',
      resourceId: jobId,
      changes: { recordsSubmitted: validRecords.length, recordsRejected: invalidRecords.length },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk data upload:', err.message));

    res.status(200).json({
      success: true,
      message: invalidRecords.length > 0
        ? `Data uploaded with ${invalidRecords.length} row(s) rejected by validation`
        : 'Data uploaded successfully',
      data: {
        jobId,
        recordsUploaded: validRecords.length,
        recordsRejected: invalidRecords.length,
        invalidRecords,
        state: uploadResponse.state,
      },
    });
  } catch (error) {
    console.error('Error uploading bulk data:', error);
    AuditLogger.log('IMPORT', {
      userId: req.user._id,
      resourceType: 'BulkJob',
      resourceId: jobId,
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk data upload failure:', err.message));

    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      invalidRecords: error.invalidRecords,
    });
  }
};

/**
 * @route   POST /api/salesforce/bulk/:jobId/upload-file
 * @desc    Upload data to bulk job as an actual CSV file (multipart/form-data,
 *          field name "file") - see middleware/csvUpload.js for the file-type
 *          and 50MB size enforcement applied before this handler even runs.
 * @access  Private
 */
export const uploadBulkDataFile = async (req, res) => {
  const { jobId } = req.params;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'A CSV file is required (field name "file")',
      });
    }

    const bulkJob = await loadQueuedBulkJob(jobId, req.user._id);

    const fileBuffer = await readFile(req.file.path);
    const sourceFileHash = sha256Hex(fileBuffer);

    let records;
    try {
      records = parseCsv(fileBuffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } catch (parseError) {
      const err = new Error(`Could not parse CSV file: ${parseError.message}`);
      err.status = 400;
      throw err;
    }

    if (!Array.isArray(records) || records.length === 0) {
      const err = new Error('CSV file contains no data rows');
      err.status = 400;
      throw err;
    }

    const { uploadResponse, validRecords, invalidRecords } = await submitValidatedRecords(req, bulkJob, records, {
      sourceFileHash,
      sourceFileName: req.file.originalname,
      sourceFileSize: req.file.size,
    });

    AuditLogger.log('IMPORT', {
      userId: req.user._id,
      resourceType: 'BulkJob',
      resourceId: jobId,
      changes: {
        recordsSubmitted: validRecords.length,
        recordsRejected: invalidRecords.length,
        sourceFileHash,
        sourceFileName: req.file.originalname,
        sourceFileSize: req.file.size,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk CSV upload:', err.message));

    res.status(200).json({
      success: true,
      message: invalidRecords.length > 0
        ? `File uploaded with ${invalidRecords.length} row(s) rejected by validation`
        : 'File uploaded successfully',
      data: {
        jobId,
        recordsUploaded: validRecords.length,
        recordsRejected: invalidRecords.length,
        invalidRecords,
        sourceFileHash,
        state: uploadResponse.state,
      },
    });
  } catch (error) {
    console.error('Error uploading bulk CSV file:', error);
    AuditLogger.log('IMPORT', {
      userId: req.user._id,
      resourceType: 'BulkJob',
      resourceId: jobId,
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk CSV upload failure:', err.message));

    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      invalidRecords: error.invalidRecords,
    });
  } finally {
    // Always runs, success or failure - the temp file must never survive
    // past this request (see csvUpload.js's per-request random directory).
    await cleanupUpload(req);
  }
};

/**
 * @route   POST /api/salesforce/bulk/:jobId/close
 * @desc    Close and start processing bulk job
 * @access  Private
 */
export const closeBulkJob = async (req, res) => {
  try {
    const { jobId } = req.params;

    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({
        success: false,
        message: 'Bulk job not found',
      });
    }

    if (bulkJob.status !== 'in_progress') {
      return res.status(400).json({
        success: false,
        message: `Cannot close job with status: ${bulkJob.status}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const closeResponse = await salesforce.closeBulkJob(
      bulkJob.salesforceJobId
    );

    // Update job record
    bulkJob.status = 'in_progress';

    await bulkJob.save();

    // Invalidate cache
    await cacheService.delete(`bulk_status_${req.user._id}_${jobId}`);

    res.status(200).json({
      success: true,
      message: 'Bulk job closed and processing started',
      data: {
        jobId,
        state: closeResponse.state,
      },
    });
  } catch (error) {
    console.error('Error closing bulk job:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/bulk/:jobId/status
 * @desc    Get bulk job processing status
 * @access  Private
 */
export const getBulkJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const cacheKey = `bulk_status_${req.user._id}_${jobId}`;

    // Check cache (30 second TTL for status)
    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({
        success: false,
        message: 'Bulk job not found',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const statusResponse = await salesforce.getBulkJobStatus(
      bulkJob.salesforceJobId
    );

    // Update job status if complete - before building statusData below, so
    // its `status` field reflects the same call's result as `state` instead
    // of lagging one poll behind.
    if (['JobComplete', 'Failed', 'Aborted'].includes(statusResponse.state)) {
      bulkJob.status = statusResponse.state === 'JobComplete' ? 'completed' : 'failed';
      bulkJob.completedAt = new Date();
      bulkJob.stateDetail = statusResponse.stateDetail;
      await bulkJob.save();
    }

    const statusData = {
      jobId,
      status: bulkJob.status,
      salesforceJobId: bulkJob.salesforceJobId,
      state: statusResponse.state,
      totalRecords: bulkJob.totalRecords || 0,
      recordsProcessed: statusResponse.numberRecordsProcessed || 0,
      recordsFailed: statusResponse.numberRecordsFailed || 0,
      progress: bulkJob.totalRecords
        ? Math.round(
            ((statusResponse.numberRecordsProcessed || 0) /
              bulkJob.totalRecords) *
              100
          )
        : 0,
      startedAt: bulkJob.startedAt,
    };

    await cacheService.set(cacheKey, statusData, 30);

    res.status(200).json({
      success: true,
      data: statusData,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error getting bulk job status:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/bulk/:jobId/results
 * @desc    Get successful results from bulk job
 * @access  Private
 */
export const getBulkJobResults = async (req, res) => {
  try {
    const { jobId } = req.params;
    const cacheKey = `bulk_results_${req.user._id}_${jobId}`;

    // Check cache (5 minute TTL)
    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({
        success: false,
        message: 'Bulk job not found',
      });
    }

    if (bulkJob.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Cannot retrieve results for job with status: ${bulkJob.status}. Job must be completed first.`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const rawResults = await salesforce.getBulkJobResults(bulkJob.salesforceJobId);
    const results = parseBulkResultsCsv(rawResults);

    const resultData = {
      jobId,
      totalRecords: bulkJob.totalRecords,
      successfulRecords: results.length,
      failedRecords: Math.max(0, (bulkJob.totalRecords || 0) - results.length),
      records: results,
      completedAt: bulkJob.completedAt,
    };

    await cacheService.set(cacheKey, resultData, 300);

    res.status(200).json({
      success: true,
      data: resultData,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error getting bulk job results:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/bulk/:jobId/failed
 * @desc    Get failed records from bulk job
 * @access  Private
 */
export const getBulkJobFailedRecords = async (req, res) => {
  try {
    const { jobId } = req.params;
    const cacheKey = `bulk_failed_${req.user._id}_${jobId}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({
        success: false,
        message: 'Bulk job not found',
      });
    }

    if (bulkJob.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Cannot retrieve failed records for job with status: ${bulkJob.status}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const rawFailedRecords = await salesforce.getBulkJobFailedRecords(
      bulkJob.salesforceJobId
    );
    const failedRecords = parseBulkResultsCsv(rawFailedRecords);

    const failedData = {
      jobId,
      failedCount: failedRecords.length,
      records: failedRecords,
    };

    await cacheService.set(cacheKey, failedData, 300);

    res.status(200).json({
      success: true,
      data: failedData,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error getting failed records:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Shared by the two download-link endpoints below: fetch the same
 * successful/failed records the JSON endpoints already return, render them
 * as CSV, and wrap that in a secure download token instead of returning the
 * records inline - the same content-freezing/hash/expiry/single-use
 * guarantees as the dashboard-stats export (see data.controller.js).
 */
const createRecordsDownloadLink = async (req, res, { records, filenamePrefix }) => {
  const fields = records.length > 0 ? Object.keys(records[0]) : ['message'];
  const rows = records.length > 0 ? records : [{ message: 'No records' }];
  const csv = await ExportService.exportRowsToCSV(rows, fields);
  const filename = `${filenamePrefix}-${req.params.jobId}.csv`;

  const { token, fileHash, expiresAt } = await createDownloadToken({
    userId: req.user._id,
    ip: req.ip,
    filename,
    contentType: 'text/csv',
    content: csv,
  });

  AuditLogger.log('EXPORT', {
    userId: req.user._id,
    resourceType: 'BulkJob',
    resourceId: req.params.jobId,
    changes: { filename, recordCount: records.length, fileHash },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error('Failed to audit-log bulk export link creation:', err.message));

  res.status(200).json({
    success: true,
    data: { downloadUrl: `/export/download/${token}`, expiresAt, fileHash, filename },
  });
};

/**
 * @route   POST /api/salesforce/bulk/:jobId/results/download-link
 * @desc    Get a secure, single-use download link for a completed job's
 *          successful results as CSV
 * @access  Private
 */
export const createResultsDownloadLink = async (req, res) => {
  try {
    const { jobId } = req.params;
    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({ success: false, message: 'Bulk job not found' });
    }
    if (bulkJob.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Cannot retrieve results for job with status: ${bulkJob.status}. Job must be completed first.`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const rawResults = await salesforce.getBulkJobResults(bulkJob.salesforceJobId);
    const records = parseBulkResultsCsv(rawResults);

    await createRecordsDownloadLink(req, res, { records, filenamePrefix: 'bulk-results' });
  } catch (error) {
    console.error('Error creating bulk results download link:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/bulk/:jobId/failed/download-link
 * @desc    Get a secure, single-use download link for a completed job's
 *          failed records as CSV
 * @access  Private
 */
export const createFailedDownloadLink = async (req, res) => {
  try {
    const { jobId } = req.params;
    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({ success: false, message: 'Bulk job not found' });
    }
    if (bulkJob.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Cannot retrieve failed records for job with status: ${bulkJob.status}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const rawFailedRecords = await salesforce.getBulkJobFailedRecords(bulkJob.salesforceJobId);
    const records = parseBulkResultsCsv(rawFailedRecords);

    await createRecordsDownloadLink(req, res, { records, filenamePrefix: 'bulk-failed' });
  } catch (error) {
    console.error('Error creating bulk failed-records download link:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/bulk/export
 * @desc    Export every Account/Contact/Lead/Opportunity/Contract/Quote/Task
 *          record (optionally filtered by name search and/or a CreatedDate
 *          range) as a secure, single-use CSV download link - the "Export
 *          Data" tab's action. Distinct from results/failed-download-link
 *          above, which only cover the outcome of a bulk job that was just
 *          run; this pulls existing Salesforce data directly.
 * @access  Private
 */
export const exportRecords = async (req, res) => {
  try {
    const { objectType, search, dateFrom, dateTo } = req.query;

    if (!EXPORT_OBJECT_CONFIG[objectType]) {
      return res.status(400).json({
        success: false,
        message: `Invalid object type. Must be one of: ${Object.keys(EXPORT_OBJECT_CONFIG).join(', ')}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const rawRecords = await salesforce.exportObjectRecords(objectType, { search, dateFrom, dateTo });
    const records = rawRecords.map(({ attributes, ...rest }) => rest);

    if (records.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No records matched your export filters',
        data: { downloadUrl: null, recordCount: 0 },
      });
    }

    const csv = await ExportService.exportRowsToCSV(records, EXPORT_OBJECT_CONFIG[objectType].fields);
    const filename = `${objectType.toLowerCase()}-export-${Date.now()}.csv`;

    const { token, fileHash, expiresAt } = await createDownloadToken({
      userId: req.user._id,
      ip: req.ip,
      filename,
      contentType: 'text/csv',
      content: csv,
    });

    AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: objectType,
      resourceId: 'bulk-export',
      changes: { recordCount: records.length, filename, fileHash, search, dateFrom, dateTo },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log bulk export:', err.message));

    res.status(200).json({
      success: true,
      data: { downloadUrl: `/export/download/${token}`, filename, expiresAt, fileHash, recordCount: records.length },
    });
  } catch (error) {
    console.error('Error exporting records:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/bulk/template
 * @desc    A downloadable CSV template (header row + one example row) for
 *          the given object type/operation, so an import file's column
 *          headers match Salesforce field names on the first try instead of
 *          by trial and error. Static, non-sensitive content - served
 *          directly rather than through the secure download-token flow that
 *          the other CSV endpoints above use for *user-specific* export data.
 * @access  Private
 */
export const getImportTemplate = (req, res) => {
  try {
    const { objectType, operation = 'insert' } = req.query;

    if (!REQUIRED_FIELDS_BY_OBJECT[objectType]) {
      return res.status(400).json({
        success: false,
        message: `Invalid object type. Must be one of: ${Object.keys(REQUIRED_FIELDS_BY_OBJECT).join(', ')}`,
      });
    }

    if (!['insert', 'update', 'upsert', 'delete'].includes(operation)) {
      return res.status(400).json({ success: false, message: 'Invalid operation' });
    }

    const requiredFields = REQUIRED_FIELDS_BY_OBJECT[objectType];
    const optionalFields = TEMPLATE_OPTIONAL_FIELDS[objectType] || [];

    let columns;
    if (operation === 'delete') {
      columns = ['Id'];
    } else if (operation === 'update') {
      columns = ['Id', ...optionalFields.slice(0, 3)];
    } else if (operation === 'upsert') {
      columns = ['Id', ...requiredFields];
    } else {
      columns = [...requiredFields, ...optionalFields];
    }
    columns = [...new Set(columns)];

    const sampleRow = columns.map((col) => TEMPLATE_SAMPLE_VALUES[col] || 'value');
    const csv = [columns.join(','), sampleRow.map(csvCell).join(',')].join('\n');
    const filename = `${objectType.toLowerCase()}-${operation}-template.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    console.error('Error generating import template:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/bulk
 * @desc    Get all bulk jobs for user
 * @access  Private
 */
export const getBulkJobs = async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;

    const query = { userId: req.user._id };
    if (status) {
      query.status = status;
    }

    const bulkJobs = await BulkJob.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit), 500))
      .skip(Math.max(0, parseInt(offset)));

    const total = await BulkJob.countDocuments(query);

    res.status(200).json({
      success: true,
      data: bulkJobs,
      pagination: {
        total,
        limit: Math.min(parseInt(limit), 500),
        offset: Math.max(0, parseInt(offset)),
      },
    });
  } catch (error) {
    console.error('Error fetching bulk jobs:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  createBulkJob,
  uploadBulkData,
  uploadBulkDataFile,
  closeBulkJob,
  getBulkJobStatus,
  getBulkJobResults,
  getBulkJobFailedRecords,
  createResultsDownloadLink,
  createFailedDownloadLink,
  exportRecords,
  getImportTemplate,
  getBulkJobs,
};