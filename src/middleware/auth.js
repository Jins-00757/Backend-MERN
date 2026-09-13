import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AppError } from './errorHandler.js';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    // Get token from cookies
    const token = req.cookies?.token;

    if (!token) {
      return next(new AppError('No token provided', 401));
    }

    // Verify token
    const decoded = jwt.verify(token, config.jwtSecret);

    // Load the full user document (not just the JWT payload) so downstream
    // controllers/services that read Salesforce tokens, role, etc. off
    // req.user always see current, complete data.
    const user = await User.findById(decoded._id);

    if (!user || user.isInactive) {
      return next(new AppError('Invalid or expired token', 401));
    }

    req.user = user;
    next();
  } catch (err) {
    next(new AppError('Invalid or expired token', 401));
  }
};