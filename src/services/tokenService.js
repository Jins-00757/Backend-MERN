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
    sameSite: 'strict', // CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
};
 
/**
 * Clear token cookie
 */
export const clearTokenCookie = (res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
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