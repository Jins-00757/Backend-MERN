import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import salesforceRoutes from './routes/salesforce.routes.js';
 
// ============================================================================
// Create Express App
// ============================================================================
 
export const createApp = () => {
  const app = express();
 
  // ========================================================================
  // Trust Proxy (for production deployments behind a proxy)
  // ========================================================================
  app.set('trust proxy', 1);
 
  // ========================================================================
  // CORS Configuration (MUST be first middleware)
  // ========================================================================
  const corsOptions = {
    origin: config.clientUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  };
 
  // Apply CORS to all routes
  app.use(cors(corsOptions));
 
  // Handle preflight requests explicitly
  app.options('*', cors(corsOptions));
 
  // ========================================================================
  // Security Middleware
  // ========================================================================
 
  // Helmet: Set security HTTP headers
  app.use(helmet());
 
  // Compression: Compress responses
  app.use(compression());
 
  // ========================================================================
  // Body Parser Middleware
  // ========================================================================
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ limit: '10kb', extended: false }));
 
  // ========================================================================
  // Cookie Parser Middleware
  // ========================================================================
  app.use(cookieParser());
 
  // ========================================================================
  // Rate Limiting
  // ========================================================================
 
  // General rate limiter
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => config.nodeEnv === 'development', // Skip in development
  });
 
  // Auth-specific rate limiter (stricter)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit to 5 requests per window
    message: 'Too many login attempts, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => config.nodeEnv === 'development',
  });
 
  // Apply global rate limiter
  app.use('/api/', globalLimiter);
 
  // ========================================================================
  // Health Check Route (before rate limiting)
  // ========================================================================
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: config.nodeEnv,
    });
  });
 
  // ========================================================================
  // API Routes
  // ========================================================================
 
  // Auth routes (with stricter rate limiting)
  app.use('/api/auth', authLimiter, authRoutes);
 
  // Salesforce routes
  app.use('/api/auth/salesforce', salesforceRoutes);
 
  // ========================================================================
  // 404 Handler
  // ========================================================================
  app.use('*', (req, res) => {
    res.status(404).json({
      status: 'error',
      message: 'Route not found',
      path: req.originalUrl,
    });
  });
 
  // ========================================================================
  // Error Handler Middleware (must be last)
  // ========================================================================
  app.use(errorHandler);
 
  return app;
};
 
// ============================================================================
// Export App Instance
// ============================================================================
export default createApp();