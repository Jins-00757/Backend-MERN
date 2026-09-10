import dotenv from 'dotenv';
 
// Load environment variables from .env file
dotenv.config();
 
// ============================================================================
// Environment Configuration
// ============================================================================
 
export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5005', 10),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
 
  // Database
  mongodbUri: process.env.MONGODB_URI,
 
  // JWT
  jwtSecret: process.env.JWT_SECRET,
  jwtExpire: process.env.JWT_EXPIRE || '7d',
 
  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || 'your-32-char-encryption-key-here',
 
  // Salesforce OAuth
  salesforce: {
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    username: process.env.SALESFORCE_USERNAME,
    redirectUri: process.env.SALESFORCE_REDIRECT_URI || 'http://localhost:5005/api/auth/salesforce/callback',
    authUrl: process.env.SALESFORCE_AUTH_URL || 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: process.env.SALESFORCE_TOKEN_URL || 'https://login.salesforce.com/services/oauth2/token',
  },
};
 
// ============================================================================
// Environment Validation
// ============================================================================
 
// Only JWT_SECRET is required - app cannot work without it
const requiredEnvVars = ['JWT_SECRET'];
const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
 
if (missingVars.length > 0) {
  console.error(`❌ Error: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}
 
// Optional but recommended
const recommendedEnvVars = ['MONGODB_URI', 'ENCRYPTION_KEY'];
const missingRecommended = recommendedEnvVars.filter((envVar) => !process.env[envVar]);
 
if (missingRecommended.length > 0) {
  console.warn(
    `⚠️  Warning: Missing recommended environment variables: ${missingRecommended.join(', ')}`
  );
}
 
// MongoDB warning
if (!config.mongodbUri) {
  console.warn('⚠️  Warning: MONGODB_URI not set - database features will not work');
}
 
// Salesforce warning
if (!config.salesforce.clientId || !config.salesforce.clientSecret) {
  console.warn('⚠️  Warning: Salesforce credentials not configured - OAuth will not work');
}
 
// Development warning
if (config.nodeEnv === 'development') {
  console.log('ℹ️  Running in development mode');
}