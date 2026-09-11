import crypto from 'crypto';
import User from '../models/User.js';
import { generateToken, setTokenCookie, clearTokenCookie } from '../services/tokenService.js';
import { AppError } from '../middleware/errorHandler.js';

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
  phoneNumber: user.phoneNumber,
  profilePicture: user.profilePicture,
  preferences: user.preferences,
  salesforceUserId: user.salesforceUserId,
  salesforceOrgName: user.salesforceOrgName,
  isSalesforceConnected: user.isSalesforceConnected,
  createdAt: user.createdAt,
  lastLogin: user.lastLogin,
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
    const { name, email, password, confirmPassword } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    // Check all required fields
    if (!name || !email || !password) {
      return next(
        new AppError('Name, email, and password are required', 400)
      );
    }

    // Validate password strength
    if (password.length < 8) {
      return next(
        new AppError('Password must be at least 8 characters', 400)
      );
    }

    // Validate password confirmation
    if (password !== confirmPassword) {
      return next(
        new AppError('Passwords do not match', 400)
      );
    }

    // Validate email format (basic check, detailed validation in schema)
    const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
      return next(
        new AppError('Please provide a valid email address', 400)
      );
    }

    // Validate name length
    if (name.length < 2 || name.length > 100) {
      return next(
        new AppError('Name must be between 2 and 100 characters', 400)
      );
    }

    // ========================================================================
    // CHECK IF USER EXISTS
    // ========================================================================

    const existingUser = await User.findByEmail(email);
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
      passwordHash: password, // Will be hashed by pre-save middleware
      role: 'user',
      isEmailVerified: false,
    });

    // Save user (pre-save middleware will hash password)
    await user.save();

    console.log(`✅ New user registered: ${user.email}`);

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
 * POST /api/auth/login
 * Authenticate user and create session
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    if (!email || !password) {
      return next(
        new AppError('Email and password are required', 400)
      );
    }

    // ========================================================================
    // FIND USER
    // ========================================================================

    // Include password field for comparison
    const user = await User.findByEmail(email).select('+passwordHash +lockUntil +loginAttempts');

    if (!user || !user.isActive) {
      return next(
        new AppError('Invalid email or password', 401)
      );
    }

    // ========================================================================
    // CHECK ACCOUNT LOCK
    // ========================================================================

    if (user.checkAccountLock()) {
      return next(
        new AppError(
          `Account is locked due to multiple failed login attempts. Please try again in 30 minutes.`,
          429
        )
      );
    }

    // ========================================================================
    // VERIFY PASSWORD
    // ========================================================================

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      // Record failed login attempt
      await user.recordFailedLogin();

      return next(
        new AppError('Invalid email or password', 401)
      );
    }

    // ========================================================================
    // RECORD SUCCESSFUL LOGIN
    // ========================================================================

    await user.recordSuccessfulLogin(req.ip, req.get('user-agent'));

    console.log(`✅ User logged in: ${user.email}`);

    // ========================================================================
    // GENERATE TOKEN & SET COOKIE
    // ========================================================================

    const token = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, token);

    // ========================================================================
    // RESPONSE
    // ========================================================================

    res.status(200).json({
      status: 'ok',
      message: 'Logged in successfully',
      data: toPublicProfile(user),
    });
  } catch (error) {
    next(error);
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
    // req.user is set by protect middleware
    if (!req.user || !req.user._id) {
      return next(
        new AppError('User not found in request', 401)
      );
    }

    const user = await User.findById(req.user._id);

    if (!user || !user.isActive) {
      return next(
        new AppError('User not found or account is inactive', 404)
      );
    }

    res.status(200).json({
      status: 'ok',
      data: toPublicProfile(user),
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
    const { name, company, jobTitle, phoneNumber, bio, preferences } = req.body;

    // ========================================================================
    // VALIDATION
    // ========================================================================

    if (name && (name.length < 2 || name.length > 100)) {
      return next(
        new AppError('Name must be between 2 and 100 characters', 400)
      );
    }

    if (bio && bio.length > 500) {
      return next(
        new AppError('Bio must not exceed 500 characters', 400)
      );
    }

    // ========================================================================
    // UPDATE USER
    // ========================================================================

    const updateData = {};

    if (name) updateData.name = name.trim();
    if (company) updateData.company = company.trim();
    if (jobTitle) updateData.jobTitle = jobTitle.trim();
    if (phoneNumber) updateData.phoneNumber = phoneNumber.trim();
    if (bio) updateData.bio = bio.trim();
    if (preferences) updateData.preferences = preferences;

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

    const user = await User.findById(req.user._id).select('+passwordHash');

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

    const user = await User.findByEmail(email);

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

    console.log(`✅ Password reset token generated: ${user.email}`);

    // ========================================================================
    // TODO: Send email with reset link
    // In production, send email to user.email with:
    // ${process.env.CLIENT_URL}/reset-password?token=${resetToken}
    // ========================================================================

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
};