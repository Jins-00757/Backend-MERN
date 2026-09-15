import User from '../models/User.js';
import AuditLogger from '../services/AuditLogger.js';
import { AppError } from '../middleware/errorHandler.js';
import { encryptField, decryptFieldAudited } from '../services/encryptionService.js';
import {
  generateSecret,
  generateQRCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  consumeBackupCode,
} from '../services/twoFactorService.js';
import {
  generateToken,
  setTokenCookie,
  verifyPendingTwoFactorToken,
  clearPendingTwoFactorCookie,
  getPendingTwoFactorCookieName,
} from '../services/tokenService.js';

/**
 * Shape a user document into the public profile sent to the client. Mirrors
 * auth.controller.js's toPublicProfile so /2fa/validate's response matches
 * what /login and /me return.
 */
const toPublicProfile = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  company: user.company,
  jobTitle: user.jobTitle,
  department: user.department,
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

// Uses the same AuditLogger singleton (and 'User' resourceType convention)
// every other controller's activity logging already goes through - see
// leadsController.js's recordActivity for the same pattern.
const logTwoFactorEvent = (req, { userId, action, status, errorMessage }) =>
  AuditLogger.log(action, {
    userId,
    resourceType: 'User',
    resourceId: userId,
    changes: { feature: 'twoFactorAuth' },
    status,
    errorMessage,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error('❌ Failed to write 2FA audit log:', err.message));

// ============================================================================
// SETUP - Generate a new (unconfirmed) secret + QR code
// ============================================================================

/**
 * POST /api/auth/2fa/setup
 * Protected. Generates a new TOTP secret and stores it, encrypted, as a
 * *pending* secret - it only becomes the account's active secret once
 * POST /2fa/verify-setup proves the user actually has it loaded in an
 * authenticator app.
 */
export const setupTwoFactor = async (req, res, next) => {
  try {
    if (req.user.twoFactorEnabled) {
      return next(new AppError('Two-factor authentication is already enabled', 409));
    }

    const { base32, otpauthUrl } = generateSecret(req.user.email);
    const qrCode = await generateQRCodeDataUrl(otpauthUrl);

    await User.findByIdAndUpdate(req.user._id, {
      twoFactorPendingSecret: encryptField(base32),
    });

    res.status(200).json({
      status: 'ok',
      data: {
        qrCode,
        manualEntryKey: base32,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// VERIFY SETUP - Confirm the pending secret and turn 2FA on
// ============================================================================

/**
 * POST /api/auth/2fa/verify-setup
 * Protected. Body: { token }
 * Confirms the user's authenticator app is actually producing valid codes
 * for the pending secret, then enables 2FA and issues backup codes (shown
 * to the caller exactly this once).
 */
export const verifyTwoFactorSetup = async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return next(new AppError('Verification code is required', 400));
    }

    const user = await User.findById(req.user._id).select('+twoFactorPendingSecret');

    if (!user?.twoFactorPendingSecret) {
      return next(new AppError('No two-factor setup in progress. Please start setup again.', 400));
    }

    const secret = decryptFieldAudited(user.twoFactorPendingSecret, {
      userId: user._id,
      resourceId: user._id,
      fieldName: 'twoFactorPendingSecret',
      req,
    });

    if (!verifyTotp(secret, token)) {
      return next(new AppError('Invalid verification code', 401));
    }

    const { raw: backupCodes, hashed } = generateBackupCodes();

    user.twoFactorSecret = encryptField(secret);
    user.twoFactorPendingSecret = undefined;
    user.twoFactorEnabled = true;
    user.backupCodes = hashed;
    await user.save({ validateModifiedOnly: true });

    logTwoFactorEvent(req, { userId: user._id, action: 'UPDATE', status: 'success' });

    console.log(`✅ Two-factor authentication enabled: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Two-factor authentication is now enabled',
      data: { backupCodes },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// STATUS
// ============================================================================

/**
 * GET /api/auth/2fa/status
 * Protected.
 */
export const getTwoFactorStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+backupCodes');

    const remainingBackupCodes = user?.twoFactorEnabled
      ? (user.backupCodes || []).filter((code) => !code.usedAt).length
      : 0;

    res.status(200).json({
      status: 'ok',
      data: {
        enabled: Boolean(user?.twoFactorEnabled),
        remainingBackupCodes,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// DISABLE
// ============================================================================

/**
 * POST /api/auth/2fa/disable
 * Protected. Body: { password, token } (token may be a TOTP code or a
 * backup code) - both the account password AND a current 2FA code are
 * required so a hijacked-but-not-fully-compromised session can't turn
 * protection off on its own.
 */
export const disableTwoFactor = async (req, res, next) => {
  try {
    const { password, token } = req.body;

    if (!password || !token) {
      return next(new AppError('Password and a verification code are required', 400));
    }

    const user = await User.findById(req.user._id).select(
      '+password +twoFactorSecret +backupCodes'
    );

    if (!user?.twoFactorEnabled) {
      return next(new AppError('Two-factor authentication is not enabled', 400));
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return next(new AppError('Incorrect password', 401));
    }

    const secret = decryptFieldAudited(user.twoFactorSecret, {
      userId: user._id,
      resourceId: user._id,
      fieldName: 'twoFactorSecret',
      req,
    });
    const isValidCode = verifyTotp(secret, token) || consumeBackupCode(user, token);

    if (!isValidCode) {
      return next(new AppError('Invalid verification code', 401));
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.twoFactorPendingSecret = undefined;
    user.backupCodes = undefined;
    user.lastTotpValidation = undefined;
    await user.save({ validateModifiedOnly: true });

    logTwoFactorEvent(req, { userId: user._id, action: 'UPDATE', status: 'success' });

    console.log(`✅ Two-factor authentication disabled: ${user.email}`);

    res.status(200).json({
      status: 'ok',
      message: 'Two-factor authentication has been disabled',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// REGENERATE BACKUP CODES
// ============================================================================

/**
 * POST /api/auth/2fa/backup-codes/regenerate
 * Protected. Body: { password }
 * Invalidates every existing backup code and issues a fresh set (shown to
 * the caller exactly this once).
 */
export const regenerateBackupCodes = async (req, res, next) => {
  try {
    const { password } = req.body;

    if (!password) {
      return next(new AppError('Password is required', 400));
    }

    const user = await User.findById(req.user._id).select('+password');

    if (!user?.twoFactorEnabled) {
      return next(new AppError('Two-factor authentication is not enabled', 400));
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return next(new AppError('Incorrect password', 401));
    }

    const { raw: backupCodes, hashed } = generateBackupCodes();
    user.backupCodes = hashed;
    await user.save({ validateModifiedOnly: true });

    logTwoFactorEvent(req, { userId: user._id, action: 'UPDATE', status: 'success' });

    res.status(200).json({
      status: 'ok',
      message: 'Backup codes regenerated. Your old codes no longer work.',
      data: { backupCodes },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// VALIDATE - Second step of login for 2FA-enabled accounts
// ============================================================================

/**
 * POST /api/auth/2fa/validate
 * Public route, but requires the short-lived `pending_2fa` cookie issued by
 * POST /api/auth/login after a correct password. Body: { token } or
 * { backupCode }. On success, issues the real session cookie - the same
 * one a non-2FA login would set.
 */
export const validateTwoFactor = async (req, res, next) => {
  try {
    const pendingToken = req.cookies?.[getPendingTwoFactorCookieName()];

    if (!pendingToken) {
      return next(new AppError('No pending two-factor login. Please log in again.', 401));
    }

    const decoded = verifyPendingTwoFactorToken(pendingToken);
    if (!decoded) {
      clearPendingTwoFactorCookie(res);
      return next(new AppError('Two-factor login expired. Please log in again.', 401));
    }

    const { token, backupCode } = req.body;
    if (!token && !backupCode) {
      return next(new AppError('A verification code is required', 400));
    }

    const user = await User.findById(decoded._id).select('+twoFactorSecret +backupCodes');

    if (!user || !user.twoFactorEnabled) {
      clearPendingTwoFactorCookie(res);
      return next(new AppError('Two-factor login is no longer valid. Please log in again.', 401));
    }

    const secret = decryptFieldAudited(user.twoFactorSecret, {
      userId: user._id,
      resourceId: user._id,
      fieldName: 'twoFactorSecret',
      req,
    });
    const isValid = token ? verifyTotp(secret, token) : consumeBackupCode(user, backupCode);

    if (!isValid) {
      logTwoFactorEvent(req, {
        userId: user._id,
        action: 'LOGIN',
        status: 'failure',
        errorMessage: 'Invalid 2FA code',
      });
      return next(new AppError('Invalid verification code', 401));
    }

    user.lastTotpValidation = new Date();
    user.lastLoginAt = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastActivityAt = new Date();
    await user.save({ validateModifiedOnly: true });

    clearPendingTwoFactorCookie(res);

    const sessionToken = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, sessionToken);

    logTwoFactorEvent(req, { userId: user._id, action: 'LOGIN', status: 'success' });

    res.status(200).json({
      status: 'ok',
      data: toPublicProfile(user),
    });
  } catch (error) {
    next(error);
  }
};

export default {
  setupTwoFactor,
  verifyTwoFactorSetup,
  getTwoFactorStatus,
  disableTwoFactor,
  regenerateBackupCodes,
  validateTwoFactor,
};
