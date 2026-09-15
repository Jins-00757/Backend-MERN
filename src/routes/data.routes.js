import express from 'express';
import { protect } from '../middleware/auth.js';
import { sensitiveOperationLimiter } from '../middleware/rateLimiter.js';
import {
  getOpportunities,
  getAccounts,
  getPipelineSummary,
  exportDashboardStats,
} from '../controllers/data.controller.js';

const router = express.Router();

/**
 * GET /api/data/opportunities
 * Get user's Salesforce opportunities
 */
router.get('/opportunities', protect, getOpportunities);

/**
 * GET /api/data/accounts
 * Get user's Salesforce accounts
 */
router.get('/accounts', protect, getAccounts);

/**
 * GET /api/data/pipeline-summary
 * Get sales pipeline summary by stage
 */
router.get('/pipeline-summary', protect, getPipelineSummary);

/**
 * GET /api/data/export/:format
 * Generates a dashboard-stats export (CSV or PDF) and returns a secure,
 * single-use, 1-hour download link rather than the file itself - see
 * data.controller.js's exportDashboardStats and services/downloadTokenService.js.
 */
router.get('/export/:format', protect, sensitiveOperationLimiter, exportDashboardStats);

export default router;