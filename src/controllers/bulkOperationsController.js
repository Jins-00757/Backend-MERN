

import { parse as parseCsv } from 'csv-parse/sync';
import SalesforceService from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';
import BulkJob from '../models/BulkJob.js';

/**
 * Bulk API 2.0's successfulResults/failedResults endpoints return a raw CSV
 * response body, not JSON - parse it into row objects so callers get a real
 * array (and an accurate .length) instead of a CSV string.
 */
const parseBulkResultsCsv = (csv) => {
  if (!csv || !csv.trim()) return [];
  return parseCsv(csv, { columns: true, skip_empty_lines: true });
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
    });

    await bulkJob.save();

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
 * @route   POST /api/salesforce/bulk/:jobId/upload
 * @desc    Upload data to bulk job
 * @access  Private
 */
export const uploadBulkData = async (req, res) => {
  try {
    const { jobId } = req.params;
    const records = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Records must be a non-empty array',
      });
    }

    // Get bulk job from database
    const bulkJob = await BulkJob.findOne({ jobId, userId: req.user._id });

    if (!bulkJob) {
      return res.status(404).json({
        success: false,
        message: 'Bulk job not found',
      });
    }

    if (bulkJob.status !== 'queued') {
      return res.status(400).json({
        success: false,
        message: `Cannot upload to job with status: ${bulkJob.status}`,
      });
    }

    const salesforce = new SalesforceService(req.user);
    const uploadResponse = await salesforce.uploadBulkData(
      bulkJob.salesforceJobId,
      records
    );

    // Update job record
    bulkJob.status = 'in_progress';
    bulkJob.totalRecords = records.length;
    bulkJob.jobData = records.map((record, index) => ({
      recordIndex: index,
      record,
      status: 'pending',
    }));

    await bulkJob.save();

    // Invalidate cache
    await cacheService.delete(`bulk_status_${req.user._id}_${jobId}`);

    res.status(200).json({
      success: true,
      message: 'Data uploaded successfully',
      data: {
        jobId,
        recordsUploaded: records.length,
        state: uploadResponse.state,
      },
    });
  } catch (error) {
    console.error('Error uploading bulk data:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
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
  closeBulkJob,
  getBulkJobStatus,
  getBulkJobResults,
  getBulkJobFailedRecords,
  getBulkJobs,
};