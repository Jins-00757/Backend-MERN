
import express from 'express';
import { protect } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { groqGlobalLimiter, aiActionsLimiter, salesforceCrudLimiter } from '../middleware/rateLimiter.js';
import * as aiActionsController from '../controllers/aiActionsController.js';
import * as aiToolsController from '../controllers/aiToolsController.js';

const router = express.Router();

// Every route here requires a logged-in user and shares the same two
// Groq-quota-protecting limiters as the chat widget (see rateLimiter.js).
router.use(protect);
router.use(groqGlobalLimiter, aiActionsLimiter);

router.post('/quotes/:id/draft-email', aiActionsController.draftQuoteEmail);
router.post('/quotes/:id/risk', aiActionsController.getQuoteRisk);
router.post('/quotes/discount-justification', aiActionsController.draftQuoteDiscountJustification);
router.post('/accounts/:id/activity-summary', aiActionsController.getAccountActivitySummary);
router.post('/opportunities/exec-summary', aiActionsController.generateExecSummary);
router.post('/search/parse-query', aiActionsController.parseSearchQuery);

// ========================================================================
// CRM ACTIONS ASSISTANT - Groq function calling. Chatting and getting a
// proposed action back only needs the same baseline every role above
// already has (inherits router-level protect/limiters). Actually executing
// a proposed action is a real Salesforce write, so it's additionally gated
// behind the same canWrite permission a manual quote status change requires
// (see salesforce.routes.js) and the same per-user Salesforce write limiter
// every other mutating Salesforce call in this app shares.
// ========================================================================
const canWrite = authorize(['write:own', 'write:team', 'write:all']);

router.post('/assistant/message', aiToolsController.sendActionMessage);
router.post('/assistant/confirm', canWrite, salesforceCrudLimiter, aiToolsController.confirmAction);

export default router;
