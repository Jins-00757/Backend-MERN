
import express from 'express';
import { protect } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { salesforceLimiter } from '../middleware/rateLimiter.js';
import * as analyticsController from '../controllers/analyticsController.js';

const router = express.Router();

router.use(protect);
router.use(salesforceLimiter);

router.get(
  '/pipeline-health',
  authorize(['read:all']),
  analyticsController.getPipelineHealth
);

router.get(
  '/forecast',
  authorize(['read:all']),
  analyticsController.getForecast
);

router.get(
  '/risks',
  authorize(['read:all']),
  analyticsController.getDealRisks
);

router.get(
  '/team-performance',
  authorize(['manage:team']),
  analyticsController.getTeamPerformance
);

router.get(
  '/revenue-trend',
  authorize(['read:all']),
  analyticsController.getRevenueTrend
);

// Export any of the reports above as CSV/PDF - team-performance additionally
// requires manage:team, checked inside the controller since the report type
// is a query param rather than the route itself.
router.get(
  '/export/:format',
  authorize(['read:all']),
  analyticsController.exportAnalytics
);

export default router;