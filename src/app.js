import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';

export const createApp = () => {
  const app = express();

  app.use('/api/auth', authRoutes); // Mount auth routes

  // Security middleware
  app.use(helmet());
  app.use(compression());

  // CORS (strict allow-list)
  app.use(cors({
    origin: config.clientUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type'],
  }));

  // Body parser
  app.use(express.json({ limit: '10kb' }));

  // Rate limiting (auth routes)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 5,                     // 5 requests per window
    message: 'Too many login attempts, try again later',
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Routes
  app.post('/api/auth/signup', authLimiter, (req, res) => {
    // TODO: Implement signup
  });
  app.post('/api/auth/login', authLimiter, (req, res) => {
    // TODO: Implement login
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
};

export default createApp();