import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { protect } from '../middleware/auth.js';
import {
  setupTwoFactor,
  verifyTwoFactorSetup,
  getTwoFactorStatus,
  disableTwoFactor,
  regenerateBackupCodes,
  validateTwoFactor,
} from '../controllers/twoFactor.controller.js';

/**
 * Two-Factor Authentication Routes
 * Mounted at /api/auth/2fa (see app.js - mounted before the catch-all-free
 * '/api/auth' router, same ordering reason as salesforceAuth.routes.js).
 */

const router = express.Router();

// A TOTP code is only 6 digits and a backup code has limited entropy per
// guess - both need the same brute-force protection as password login.
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many verification attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.nodeEnv === 'development',
});

// ============================================================================
// PUBLIC (requires the short-lived pending_2fa cookie, not a full session)
// ============================================================================

/**
 * POST /api/auth/2fa/validate
 * Second step of login for 2FA-enabled accounts.
 * Body: { token } or { backupCode }
 */
router.post('/validate', twoFactorLimiter, validateTwoFactor);

// ============================================================================
// PROTECTED (requires an authenticated session)
// ============================================================================

/**
 * GET /api/auth/2fa/status
 */
router.get('/status', protect, getTwoFactorStatus);

/**
 * POST /api/auth/2fa/setup
 * Generates a new (unconfirmed) secret + QR code.
 */
router.post('/setup', protect, setupTwoFactor);

/**
 * POST /api/auth/2fa/verify-setup
 * Body: { token }
 * Confirms the pending secret and enables 2FA.
 */
router.post('/verify-setup', twoFactorLimiter, protect, verifyTwoFactorSetup);

/**
 * POST /api/auth/2fa/disable
 * Body: { password, token }
 */
router.post('/disable', twoFactorLimiter, protect, disableTwoFactor);

/**
 * POST /api/auth/2fa/backup-codes/regenerate
 * Body: { password }
 */
router.post('/backup-codes/regenerate', twoFactorLimiter, protect, regenerateBackupCodes);

export default router;
