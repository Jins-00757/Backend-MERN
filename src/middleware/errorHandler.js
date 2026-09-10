import { config } from '../config/env.js';

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
  }
}

export const errorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;

  // Development: send full error
  if (config.isDev) {
    return res.status(err.statusCode).json({
      status: err.status || 'error',
      message: err.message,
      stack: err.stack,
    });
  }

  // Production: hide sensitive info
  if (err.statusCode < 500) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  }

  // 500 error: log but don't expose
  console.error(err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
};

export { AppError };