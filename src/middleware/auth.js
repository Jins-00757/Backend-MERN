import { verifyToken } from '../services/tokenService.js';
import { AppError } from './errorHandler.js';

export const protect = (req, res, next) => {
  const token = req.cookies.auth_token;

  if (!token) {
    return next(new AppError('Unauthorized: No token provided', 401));
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new AppError('Unauthorized: Invalid or expired token', 401));
  }

  // Attach user to request object
  req.user = decoded;
  next();
};