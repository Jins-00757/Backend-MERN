
import express from 'express';
import { protect } from '../middleware/auth.js';
import { chatbotLimiter, groqGlobalLimiter } from '../middleware/rateLimiter.js';
import * as chatbotController from '../controllers/chatbotController.js';

const router = express.Router();

// Every route here requires a logged-in user - the assistant is an
// in-product feature, not a public endpoint.
router.use(protect);

router.get('/status', chatbotController.getStatus);
// Global limiter before per-user: a shared Groq quota being exhausted is a
// whole-app condition, so it should reject before spending a per-user slot.
router.post('/message', groqGlobalLimiter, chatbotLimiter, chatbotController.sendMessage);

export default router;
