import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { protect } from '../middleware/auth.js';
import {
  signup,
  login,
  logout,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
} from '../controllers/auth.controller.js';

/**
 * Auth Routes - RESTful API endpoints
 * Handles user authentication and profile management
 */

const router = express.Router();

// Stricter rate limiter, scoped only to credential-guessing endpoints
// (kept local to this router so it never applies to Salesforce/data routes)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.nodeEnv === 'development',
});

// ============================================================================
// PUBLIC ROUTES (No authentication required)
// ============================================================================

/**
 * POST /api/auth/signup
 * Create new user account
 * Body: { name, email, password, confirmPassword }
 */
router.post('/signup', authLimiter, signup);

/**
 * POST /api/auth/login
 * Authenticate user and create session
 * Body: { email, password }
 */
router.post('/login', authLimiter, login);

/**
 * POST /api/auth/forgot-password
 * Request password reset token
 * Body: { email }
 */
router.post('/forgot-password', authLimiter, forgotPassword);

/**
 * POST /api/auth/reset-password
 * Reset password using reset token
 * Body: { token, newPassword, confirmPassword }
 */
router.post('/reset-password', authLimiter, resetPassword);

/**
 * POST /api/auth/verify-email
 * Confirm a user's email address using the token mailed to them
 * Body: { token }
 */
router.post('/verify-email', authLimiter, verifyEmail);

// ============================================================================
// PROTECTED ROUTES (Authentication required)
// ============================================================================

/**
 * POST /api/auth/logout
 * Clear authentication and end session
 */
router.post('/logout', protect, logout);

/**
 * GET /api/auth/me
 * Get current authenticated user's data
 */
router.get('/me', protect, getMe);

/**
 * PUT /api/auth/profile
 * Update user profile information
 * Body: { name, company, jobTitle, phoneNumber, bio, preferences }
 */
router.put('/profile', protect, updateProfile);

/**
 * POST /api/auth/change-password
 * Change user's password
 * Body: { currentPassword, newPassword, confirmPassword }
 */
router.post('/change-password', protect, changePassword);

/**
 * POST /api/auth/verify-email/resend
 * Re-send the verification email to the signed-in user
 */
router.post('/verify-email/resend', authLimiter, protect, resendVerificationEmail);

// NOTE: no catch-all route here - this router is mounted at '/api/auth' in
// app.js alongside sibling routers ('/api/auth/salesforce'). A catch-all
// would intercept and 404 those sibling paths before they ever reach their
// own router. Unmatched requests fall through to the app-level 404 handler.

export default router;