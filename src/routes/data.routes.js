import express from 'express';
import { protect } from '../middleware/auth.js';
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
 * Export Dashboard stats as CSV or PDF (format: csv | pdf)
 */
router.get('/export/:format', protect, exportDashboardStats);

export default router;