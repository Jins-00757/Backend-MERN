import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export const generateToken = (userId, email, role) => {
  return jwt.sign(
    { _id: userId, email, role },
    config.jwtSecret,
    { expiresIn: config.jwtExpire }
  );
};

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return null;
  }
};

// Set token in httpOnly cookie
export const setTokenCookie = (res, token) => {
  res.cookie('auth_token', token, {
    httpOnly: true,                    // Cannot be accessed by JavaScript (prevents XSS theft)
    secure: !config.isDev,             // HTTPS only in production
    sameSite: 'strict',                // CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
    path: '/',
  });
};

// Clear token cookie
export const clearTokenCookie = (res) => {
  res.clearCookie('auth_token', { path: '/' });
};