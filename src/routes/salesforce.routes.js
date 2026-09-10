import express from 'express';
import {
  getSalesforceAuthUrl,
  handleSalesforceCallback,
  disconnectSalesforce,
} from '../controllers/salesforce.controller.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Get authorization URL
router.get('/authorize', getSalesforceAuthUrl);

// Handle OAuth callback
router.post('/callback', handleSalesforceCallback);

// Disconnect Salesforce (requires authentication)
router.post('/disconnect', protect, disconnectSalesforce);

export default router;