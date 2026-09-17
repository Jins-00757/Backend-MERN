import crypto from 'crypto';
import User from '../models/User.js';
import AuditLogger from '../services/AuditLogger.js';
import {
  generateToken,
  setTokenCookie,
  clearTokenCookie,
  generatePendingTwoFactorToken,
  setPendingTwoFactorCookie,
} from '../services/tokenService.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/emailService.js';
import { AppError } from '../middleware/errorHandler.js';
import { config } from '../config/env.js';

/**
 * Generate a random verification token, store its hash (never the raw
 * token) with a 24-hour expiry on `user`, and save. Mirrors the
 * forgot/reset-password token pattern below - the raw token is only ever
 * held in memory long enough to build the verification email/URL, so a
 * database leak alone can't be used to verify (or take over) an account.
 * Caller must have `user` loaded and is responsible for sending the email.
 */
const issueEmailVerificationToken = async (user) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  user.emailVerificationToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.emailVerificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await user.save({ validateModifiedOnly: true });
  return rawToken;
};

/**
 * Shape a user document into the public profile sent to the client.
 * Kept in one place so signup/login/getMe never drift out of sync.
 */
const toPublicProfile = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  company: user.company,
  jobTitle: user.jobTitle,
  department: user.department,
  territory: user.territory,
  phoneNumber: user.phoneNumber,
  bio: user.bio,
  profilePicture: user.profilePicture,
  isEmailVerified: user.isEmailVerified,
  twoFactorEnabled: user.twoFactorEnabled,
  preferences: user.preferences,
  salesforceUserId: user.salesforceUserId,
  salesforceOrgName: user.salesforceOrgName,
  isSalesforceConnected: user.isSalesforceConnected,
  salesforceConnectedAt: user.salesforceConnectedAt,
  createdAt: user.createdAt,
  lastLogin: user.lastLoginAt,
});

/**
 * Auth Controller - Professional Grade
 * Handles signup, login, logout, session management
 * Uses refactored User model with security features
 */

// ============================================================================
// SIGNUP - Create new user account
// ============================================================================

/**
 * POST /api/auth/signup
 * Create new user account with email and password
 */
export const signup = async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword, jobTitle, territory } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    // Validate input
    if (!name || !email || !password || !confirmPassword) {
      return res.status(400).json({
        status: 'error',
        message: 'All fields are required',
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        status: 'error',
        message: 'Password must be at least 8 characters',
      });
    }

    // Validate password confirmation
    if (password !== confirmPassword) {
      return res.status(400).json({
        status: 'error',
        message: 'Passwords do not match',
      });
    }

    // Validate email format (basic check, detailed validation in schema).
    // Domain suffix is {2,} (not {2,3}) - matches the fix in User.js's
    // schema-level validator, which previously rejected valid addresses on
    // longer TLDs (.info, .technology, .london, ...).
    const emailRegex = /^[\w.+-]+@\w+([.-]?\w+)*(\.\w{2,})+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'error',
        message: 'Please provide a valid email address',
      });
    }

    // Validate name length
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({
        status: 'error',
        message: 'Name must be between 2 and 100 characters',
      });
    }

    // ========================================================================
    // CHECK IF USER EXISTS
    // ========================================================================

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return next(
        new AppError('Email already registered. Please login instead.', 409)
      );
    }

    // ========================================================================
    // CREATE USER
    // ========================================================================

    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password, // Will be hashed by pre-save middleware
      role: 'user',
      isEmailVerified: false,
      // Optional profile metadata from the signup wizard's role/territory
      // steps - display-only, never affects the RBAC `role` field above,
      // which every signup gets regardless of what (if anything) was
      // picked here.
      ...(jobTitle ? { jobTitle: String(jobTitle).trim() } : {}),
      ...(territory ? { territory: String(territory).trim() } : {}),
    });

    // Save user (pre-save middleware will hash password)
    await user.save();

    console.log(`✅ New user registered: ${user.email}`);

    // ========================================================================
    // SEND VERIFICATION EMAIL (best-effort - a broken email config must
    // never block account creation; the user can always ask for a resend
    // later from their profile once email is fixed)
    // ========================================================================

    try {
      const verifyToken = await issueEmailVerificationToken(user);
      const verifyUrl = `${config.clientUrl}/verify-email?token=${verifyToken}`;
      await sendVerificationEmail({ to: user.email, name: user.name, verifyUrl });
      console.log(`✅ Verification email sent: ${user.email}`);
    } catch (emailError) {
      console.error(`❌ Failed to send verification email to ${user.email}:`, emailError.message);
    }

    // ========================================================================
    // GENERATE TOKEN & SET COOKIE
    // ========================================================================

    const token = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, token);

    // ========================================================================
    // RESPONSE
    // ========================================================================

    res.status(201).json({
      status: 'ok',
      message: 'Account created successfully',
      data: toPublicProfile(user),
    });
  } catch (error) {
    // Handle MongoDB validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors)
        .map((err) => err.message)
        .join(', ');
      return next(new AppError(messages, 400));
    }

    // Handle duplicate key error
    if (error.code === 11000) {
      return next(
        new AppError('Email already exists. Please use a different email.', 409)
      );
    }

    next(error);
  }
};

// ============================================================================
// LOGIN - Authenticate user with email and password
// ============================================================================

/**
 * LOGIN - Authenticate user with email and password
 */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Please provide email and password',
      });
    }

    // Find user by email and include password field (select: false by default)
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password',
      });
    }

    // Ensure password field exists in database
    if (!user.password) {
      console.error('❌ User password not found in database');
      return res.status(500).json({
        status: 'error',
        message: 'Authentication failed - please try again or reset your password',
      });
    }

    // Check if user is active
    if (user.isInactive === true) {
      return res.status(403).json({
        status: 'error',
        message: 'Account is inactive. Please contact support.',
      });
    }

    // Compare passwords - FIX: Ensure both arguments exist
    let isPasswordMatch = false;
    try {
      isPasswordMatch = await user.comparePassword(password);
    } catch (compareError) {
      console.error('❌ Password comparison error:', compareError);
      return res.status(500).json({
        status: 'error',
        message: 'Authentication failed',
      });
    }

    if (!isPasswordMatch) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password',
      });
    }

    // 2FA-enabled accounts don't get a real session yet - a correct
    // password alone only earns a short-lived "pending" cookie. The real
    // session is issued by POST /api/auth/2fa/validate once the TOTP/backup
    // code checks out (see twoFactor.controller.js).
    if (user.twoFactorEnabled) {
      const pendingToken = generatePendingTwoFactorToken(user._id);
      setPendingTwoFactorCookie(res, pendingToken);

      return res.status(200).json({
        status: 'pending_2fa',
        message: 'Enter your authenticator code to finish signing in',
      });
    }

    // Create JWT token and set the httpOnly cookie (shared with signup so
    // both flows produce an identical, consistently-configured cookie)
    const token = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, token);

    // Update login timestamp - bookkeeping only, nothing in the response
    // below depends on this write completing (the in-memory `user` object
    // already reflects these fields regardless of when the save resolves).
    // Not awaited, so a login response is never delayed by an extra DB round
    // trip purely for stats - same fire-and-forget pattern already used for
    // audit logging elsewhere in this file (see deleteAccount above).
    user.lastLoginAt = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastActivityAt = new Date();
    user.save().catch((err) => console.error('❌ Failed to record login timestamp:', err.message));

    res.status(200).json({
      status: 'ok',
      data: toPublicProfile(user),
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Login failed',
    });
  }
};



// ============================================================================
// LOGOUT - Clear session
// ============================================================================

/**
 * POST /api/auth/logout
 * Clear authentication token and end session
 */
export const logout = async (req, res, next) => {
  try {
    clearTokenCookie(res);

    console.log(`✅ User logged out: ${req.user?.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// GET CURRENT USER - Retrieve authenticated user data
// ============================================================================

/**
 * GET /api/auth/me
 * Get current authenticated user's data
 * Protected route - requires valid token
 */
export const getMe = async (req, res, next) => {
  try {
    // req.user is already the freshly-loaded, non-inactive user document -
    // protect() (see middleware/auth.js) just fetched it this same request
    // and already rejects a missing/inactive user before this handler ever
    // runs. Re-fetching it here was a second, redundant DB round trip on
    // every single call to this endpoint - and since the frontend calls it
    // on every app load to restore a session (see AuthProvider.jsx), that
    // extra query ran on every page load for every user, not just login.
    if (!req.user || !req.user._id) {
      return next(
        new AppError('User not found in request', 401)
      );
    }

    res.status(200).json({
      status: 'ok',
      data: toPublicProfile(req.user),
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// UPDATE PROFILE - Update user profile information
// ============================================================================

/**
 * PUT /api/auth/profile
 * Update user profile (name, company, job title, etc.)
 * Protected route
 */
export const updateProfile = async (req, res, next) => {
  try {
    const { name, company, jobTitle, department, territory, phoneNumber, bio, profilePicture, preferences } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    // `name` is the one field that can never be legitimately cleared (every
    // user must have one), so it alone still requires a non-empty value when
    // sent. Every other text field below now accepts an empty string as an
    // explicit "clear this" - see the `!== undefined` checks below, which
    // replaced the old truthy checks that silently ignored an edit-to-blank.
    if (name !== undefined && (name.length < 2 || name.length > 100)) {
      return next(
        new AppError('Name must be between 2 and 100 characters', 400)
      );
    }

    if (bio && bio.length > 500) {
      return next(
        new AppError('Bio must not exceed 500 characters', 400)
      );
    }

    if (profilePicture && !/^https?:\/\/\S+$/i.test(profilePicture)) {
      return next(
        new AppError('Profile picture must be a valid http(s) URL', 400)
      );
    }

    // ========================================================================
    // UPDATE USER
    // ========================================================================

    const updateData = {};

    // BUG FIX: every field below used to be gated on `if (field)` - a
    // falsy-but-explicit edit (clearing "Company" back to an empty string,
    // say) was silently dropped, so the old value stuck around no matter
    // what the form submitted. `!== undefined` still leaves fields the
    // caller didn't mention at all untouched (e.g. Navbar's notifications-only
    // preferences update below), it just stops treating "" as "no change".
    if (name !== undefined) updateData.name = name.trim();
    if (company !== undefined) updateData.company = company.trim();
    if (jobTitle !== undefined) updateData.jobTitle = jobTitle.trim();
    if (department !== undefined) updateData.department = department.trim();
    if (territory !== undefined) updateData.territory = territory.trim();
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber.trim();
    if (bio !== undefined) updateData.bio = bio.trim();
    if (profilePicture !== undefined) updateData.profilePicture = profilePicture.trim();

    // Merge rather than replace `preferences` wholesale - a caller updating
    // just one setting (e.g. the notifications toggle in Navbar.jsx sending
    // only { notifications: { email } }) must not blow away unrelated
    // preferences like theme/timezone/dateFormat that it never mentioned.
    if (preferences) {
      const current = req.user.toObject().preferences || {};
      updateData.preferences = {
        ...current,
        ...preferences,
        notifications: {
          ...current.notifications,
          ...preferences.notifications,
        },
      };
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      {
        new: true,
        runValidators: true,
      }
    );

    console.log(`✅ Profile updated: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Profile updated successfully',
      data: user.toJSON(),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors)
        .map((err) => err.message)
        .join(', ');
      return next(new AppError(messages, 400));
    }

    next(error);
  }
};

// ============================================================================
// CHANGE PASSWORD - Update user password
// ============================================================================

/**
 * POST /api/auth/change-password
 * Change user's password
 * Protected route - requires current password
 */
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    if (!currentPassword || !newPassword || !confirmPassword) {
      return next(
        new AppError('Current password and new password are required', 400)
      );
    }

    if (newPassword.length < 8) {
      return next(
        new AppError('New password must be at least 8 characters', 400)
      );
    }

    if (newPassword !== confirmPassword) {
      return next(
        new AppError('New passwords do not match', 400)
      );
    }

    if (currentPassword === newPassword) {
      return next(
        new AppError('New password must be different from current password', 400)
      );
    }

    // ========================================================================
    // VERIFY CURRENT PASSWORD
    // ========================================================================

    const user = await User.findById(req.user._id).select('+password');

    if (!user) {
      return next(
        new AppError('User not found', 404)
      );
    }

    const isPasswordValid = await user.comparePassword(currentPassword);

    if (!isPasswordValid) {
      return next(
        new AppError('Current password is incorrect', 401)
      );
    }

    // ========================================================================
    // UPDATE PASSWORD
    // ========================================================================

    await user.resetPassword(newPassword);

    console.log(`✅ Password changed: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Password changed successfully',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// FORGOT PASSWORD - Request password reset token
// ============================================================================

/**
 * POST /api/auth/forgot-password
 * Request password reset token (sent via email)
 * Public route
 */
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return next(
        new AppError('Email is required', 400)
      );
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      // For security, don't reveal if email exists
      return res.status(200).json({
        status: 'ok',
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    }

    // ========================================================================
    // GENERATE RESET TOKEN
    // ========================================================================

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await user.save();

    // ========================================================================
    // SEND RESET EMAIL
    // ========================================================================

    const resetUrl = `${config.clientUrl}/reset-password?token=${resetToken}`;

    try {
      await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });
      console.log(`✅ Password reset email sent: ${user.email}`);
    } catch (emailError) {
      // The token is useless without the email that carries it - clear it
      // so it doesn't linger as a valid-but-unreachable reset path, and
      // let the user try again once email delivery is fixed.
      user.passwordResetToken = undefined;
      user.passwordResetExpiry = undefined;
      await user.save();

      console.error(`❌ Failed to send password reset email to ${user.email}:`, emailError.message);

      return next(
        new AppError('Could not send password reset email. Please try again shortly.', 500)
      );
    }

    res.status(200).json({
      status: 'ok',
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// RESET PASSWORD - Verify token and reset password
// ============================================================================

/**
 * POST /api/auth/reset-password
 * Reset password using reset token
 * Public route
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return next(
        new AppError('Token and new password are required', 400)
      );
    }

    if (newPassword !== confirmPassword) {
      return next(
        new AppError('Passwords do not match', 400)
      );
    }

    if (newPassword.length < 8) {
      return next(
        new AppError('Password must be at least 8 characters', 400)
      );
    }

    // ========================================================================
    // FIND USER BY TOKEN
    // ========================================================================

    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return next(
        new AppError('Password reset token is invalid or has expired', 400)
      );
    }

    // ========================================================================
    // RESET PASSWORD
    // ========================================================================

    await user.resetPassword(newPassword);

    console.log(`✅ Password reset: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Password reset successfully. Please login with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// VERIFY EMAIL - Confirm a user's email address via a mailed token
// ============================================================================

/**
 * POST /api/auth/verify-email
 * Body: { token }
 * Public route - the token itself proves the request came from the mailed
 * link, so this deliberately does not require an active session (the user
 * may be opening the link in a different browser/device than they signed
 * up in).
 */
export const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return next(new AppError('Verification token is required', 400));
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return next(
        new AppError('Verification link is invalid or has expired. Please request a new one.', 400)
      );
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpiry = undefined;
    await user.save({ validateModifiedOnly: true });

    console.log(`✅ Email verified: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Email verified successfully.',
      data: toPublicProfile(user),
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// RESEND VERIFICATION EMAIL
// ============================================================================

/**
 * POST /api/auth/verify-email/resend
 * Protected route - re-issues a fresh token for the signed-in user and
 * re-sends the verification email (e.g. after correcting a typo'd address,
 * or because the original link expired).
 */
export const resendVerificationEmail = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    if (user.isEmailVerified) {
      return res.status(200).json({
        status: 'ok',
        message: 'This email address is already verified.',
      });
    }

    const verifyToken = await issueEmailVerificationToken(user);
    const verifyUrl = `${config.clientUrl}/verify-email?token=${verifyToken}`;

    try {
      await sendVerificationEmail({ to: user.email, name: user.name, verifyUrl });
      console.log(`✅ Verification email resent: ${user.email}`);
    } catch (emailError) {
      // Same reasoning as forgotPassword - a token nobody can reach is
      // worse than no token, so don't leave it dangling on failure.
      user.emailVerificationToken = undefined;
      user.emailVerificationExpiry = undefined;
      await user.save({ validateModifiedOnly: true });

      console.error(`❌ Failed to resend verification email to ${user.email}:`, emailError.message);

      return next(
        new AppError('Could not send verification email. Please try again shortly.', 500)
      );
    }

    res.status(200).json({
      status: 'ok',
      message: 'Verification email sent. Please check your inbox.',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// DELETE ACCOUNT - Deactivate the signed-in user's own account
// ============================================================================

/**
 * POST /api/auth/delete-account
 * Deactivates the caller's own account (soft delete, via the existing
 * `isInactive` flag - both `protect` and `login` already reject an
 * inactive user, so this immediately and completely locks the account
 * out). Never a hard delete: the record and everything that references it
 * (AuditLog entries, Team.managerId/members, BulkJob history) stays
 * intact, so nothing else in the app is left pointing at a row that no
 * longer exists.
 * Protected route - requires the current password, same confirmation
 * changePassword above requires for its own account-level mutation.
 */
export const deleteAccount = async (req, res, next) => {
  try {
    const { password } = req.body;

    if (!password) {
      return next(
        new AppError('Password is required to delete your account', 400)
      );
    }

    const user = await User.findById(req.user._id).select('+password');

    if (!user) {
      return next(new AppError('User not found', 404));
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return next(new AppError('Incorrect password', 401));
    }

    user.isInactive = true;
    await user.save({ validateModifiedOnly: true });

    clearTokenCookie(res);

    AuditLogger.log('DELETE', {
      userId: user._id,
      resourceType: 'User',
      resourceId: user._id,
      changes: { isInactive: true },
      status: 'success',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('❌ Failed to audit-log account deletion:', err.message));

    console.log(`✅ Account deactivated: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Your account has been deactivated.',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

export default {
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
  deleteAccount,
};