
import express from 'express';
import { protect } from '../middleware/auth.js';
import { generalLimiter } from '../middleware/rateLimiter.js';
import * as searchController from '../controllers/searchController.js';

const router = express.Router();

router.use(protect);
router.use(generalLimiter);

router.get('/opportunities', searchController.search);
router.get('/suggestions', searchController.getSuggestions);
router.get('/export/:format', searchController.exportData);

export default router;