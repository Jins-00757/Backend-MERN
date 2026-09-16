import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
 
/**
 * Generate JWT token
 */
export const generateToken = (userId, email, role) => {
  return jwt.sign(
    {
      _id: userId,
      email,
      role,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpire,
    }
  );
};
 
/**
 * Set token in httpOnly secure cookie
 */
export const setTokenCookie = (res, token) => {
  const isProduction = config.nodeEnv === 'production';

  res.cookie('token', token, {
    httpOnly: true, // Prevents JavaScript from accessing the cookie
    secure: isProduction, // HTTPS only in production
    // BUG FIX: 'strict' never sends the cookie on a cross-site request at
    // all - fine when frontend and backend share a site (e.g. both on
    // localhost, same registrable domain in different dev setups), but this
    // app is deployed as two separate origins (a Render static site + a
    // Render web service), which is genuinely cross-site. Every API call
    // was silently sent with no cookie, so every request looked
    // unauthenticated ("No token provided") despite a real, valid session
    // existing. 'None' requires `secure: true` (browsers reject it
    // otherwise), which is exactly what production already sets above.
    sameSite: isProduction ? 'none' : 'strict', // CSRF protection (relaxed only for the cross-site production deployment)
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
};

/**
 * Clear token cookie
 */
export const clearTokenCookie = (res) => {
  const isProduction = config.nodeEnv === 'production';

  res.clearCookie('token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'strict',
    path: '/',
  });
};
 
/**
 * Verify token
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return null;
  }
};

// ============================================================================
// Pending 2FA token/cookie - issued after a correct password for a
// 2FA-enabled account, in place of the real session token. Its distinct
// `purpose` claim means it can never be mistaken for (or reused as) a real
// session token even if read by code that forgot to check the cookie name,
// and its short expiry limits how long a stolen cookie is useful.
// ============================================================================

const PENDING_2FA_COOKIE = 'pending_2fa';
const PENDING_2FA_EXPIRES_IN = '5m';
const PENDING_2FA_MAX_AGE_MS = 5 * 60 * 1000;

export const generatePendingTwoFactorToken = (userId) =>
  jwt.sign({ _id: userId, purpose: '2fa_pending' }, config.jwtSecret, {
    expiresIn: PENDING_2FA_EXPIRES_IN,
  });

export const verifyPendingTwoFactorToken = (token) => {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    return decoded?.purpose === '2fa_pending' ? decoded : null;
  } catch (err) {
    return null;
  }
};

export const setPendingTwoFactorCookie = (res, token) => {
  const isProduction = config.nodeEnv === 'production';

  res.cookie(PENDING_2FA_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    // Same cross-site reasoning as setTokenCookie above - this cookie is
    // read back by a request from the (separately-hosted) frontend too.
    sameSite: isProduction ? 'none' : 'strict',
    maxAge: PENDING_2FA_MAX_AGE_MS,
    path: '/',
  });
};

export const clearPendingTwoFactorCookie = (res) => {
  const isProduction = config.nodeEnv === 'production';

  res.clearCookie(PENDING_2FA_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'strict',
    path: '/',
  });
};

export const getPendingTwoFactorCookieName = () => PENDING_2FA_COOKIE;