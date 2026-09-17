
import express from 'express';
import { protect } from '../middleware/auth.js';
import { groqGlobalLimiter, aiActionsLimiter } from '../middleware/rateLimiter.js';
import * as aiActionsController from '../controllers/aiActionsController.js';

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

export default router;
