
import express from 'express';
import { verifySalesforceWebhookSignature } from '../middleware/salesforceWebhook.js';
import { webhookLimiter } from '../middleware/rateLimiter.js';
import { handleSalesforceOpportunityWebhook } from '../controllers/webhookController.js';

// Public (no `protect`) - Salesforce, not a logged-in browser, calls this.
// Authenticity is instead enforced by verifySalesforceWebhookSignature.
const router = express.Router();

router.post('/salesforce', webhookLimiter, verifySalesforceWebhookSignature, handleSalesforceOpportunityWebhook);

export default router;
