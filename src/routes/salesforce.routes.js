import express from 'express';
import {
  getSalesforceAuthUrl,
  handleSalesforceCallback,
  disconnectSalesforce,
  getSalesforceStatus,
} from '../controllers/salesforce.controller.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Get authorization URL
router.get('/auth-url', protect, getSalesforceAuthUrl);

// Handle OAuth callback - Salesforce redirects here via a top-level GET
// navigation, so this cannot be a POST route or require the session cookie
// (see handleSalesforceCallback for how the user is identified instead).
router.get('/callback', handleSalesforceCallback);

router.get('/status', protect, getSalesforceStatus);

// Disconnect Salesforce (requires authentication)
router.post('/disconnect', protect, disconnectSalesforce);

export default router;