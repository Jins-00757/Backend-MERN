
import express from 'express';
import { protect } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { salesforceLimiter } from '../middleware/rateLimiter.js';
import * as saasMetricsController from '../controllers/saasMetricsController.js';

/**
 * SaaS Metrics Routes - Day 7: ARR forecasting, churn prediction, customer
 * health scoring, and expansion opportunities for the SaaS/Technology
 * industry vertical. Sibling of analytics.routes.js.
 */

const router = express.Router();

router.use(protect);
router.use(salesforceLimiter);

router.get(
  '/arr-forecast',
  authorize(['read:all']),
  saasMetricsController.getArrForecast
);

router.get(
  '/churn-risk',
  authorize(['read:all']),
  saasMetricsController.getChurnRisk
);

router.get(
  '/customer-health',
  authorize(['read:all']),
  saasMetricsController.getCustomerHealth
);

router.get(
  '/expansion-opportunities',
  authorize(['read:all']),
  saasMetricsController.getExpansionOpportunities
);

export default router;
