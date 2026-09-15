import express from 'express';
import { protect } from '../middleware/auth.js';
import { downloadExport, getDownloadHistory } from '../controllers/exportController.js';

/**
 * Generic redemption endpoint for the single-use, 1-hour download links
 * created by data.controller.js (dashboard export) and
 * bulkOperationsController.js (bulk job results/failed records) - see
 * services/downloadTokenService.js for the token lifecycle.
 */
const router = express.Router();

// Must be registered before '/download/:token' - otherwise Express would
// match this path with token='history'.
router.get('/history', protect, getDownloadHistory);
router.get('/download/:token', protect, downloadExport);

export default router;
