import express from 'express';
import { protect } from '../middleware/auth.js';
import {
  getOpportunities,
  getAccounts,
  getPipelineSummary,
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

export default router;