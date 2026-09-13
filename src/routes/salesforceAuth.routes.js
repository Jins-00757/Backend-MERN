import express from 'express';
import { protect } from '../middleware/auth.js';
import {
  getSalesforceAuthUrl,
  handleSalesforceCallback,
  getSalesforceStatus,
  disconnectSalesforce,
} from '../controllers/salesforce.controller.js';

/**
 * Salesforce OAuth Routes - mounted at /api/auth/salesforce
 * Handles the authorization-code + PKCE round trip described in
 * salesforce.controller.js (auth-url -> Salesforce -> callback).
 */

const router = express.Router();

// GET /api/auth/salesforce/auth-url
router.get('/auth-url', protect, getSalesforceAuthUrl);

// GET /api/auth/salesforce/callback
// Hit directly by Salesforce's redirect - never by the SPA - so it must
// stay unauthenticated (see the "SameSite=Strict" note in the controller).
router.get('/callback', handleSalesforceCallback);

// GET /api/auth/salesforce/status
router.get('/status', protect, getSalesforceStatus);

// POST /api/auth/salesforce/disconnect
router.post('/disconnect', protect, disconnectSalesforce);

export default router;
