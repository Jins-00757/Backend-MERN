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

  // Redis (rate limiting + distributed caching). REDIS_URL (e.g.
  // redis://:password@host:port, as a hosted provider like Render's Key
  // Value gives you) takes priority when set, since a hosted instance
  // almost always requires a password that plain REDIS_HOST/REDIS_PORT have
  // no way to carry - see config/redisClient.js.
  redisUrl: process.env.REDIS_URL,
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),

  // Outbound email (password reset, notifications)
  emailHost: process.env.EMAIL_HOST || 'smtp.gmail.com',
  emailPort: parseInt(process.env.EMAIL_PORT || '465', 10),
  emailUser: process.env.EMAIL_USER,
  emailPassword: process.env.EMAIL_PASSWORD,
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER,

  // Scheduled jobs
  dailySummaryCron: process.env.DAILY_SUMMARY_CRON || '0 8 * * *',
  enableScheduledJobs: process.env.DISABLE_SCHEDULED_JOBS !== 'true',

  // Salesforce OAuth
  salesforceClientId: process.env.SALESFORCE_CLIENT_ID,
  salesforceClientSecret: process.env.SALESFORCE_CLIENT_SECRET,
  salesforceUsername: process.env.SALESFORCE_USERNAME,
  salesforceRedirectUri:
    process.env.SALESFORCE_REDIRECT_URI || 'http://localhost:5005/api/auth/salesforce/callback',
  salesforceAuthUrl:
    process.env.SALESFORCE_AUTH_URL || 'https://login.salesforce.com/services/oauth2/authorize',
  salesforceTokenUrl:
    process.env.SALESFORCE_TOKEN_URL || 'https://login.salesforce.com/services/oauth2/token',

  // Shared secret Salesforce (a Flow/Apex outbound callout, or a bridging
  // middle-tier) signs the inbound webhook body with - see
  // middleware/salesforceWebhook.js and routes/webhook.routes.js.
  salesforceWebhookSecret: process.env.SALESFORCE_WEBHOOK_SECRET,

  // Groq AI assistant (chat widget) - server-side only, the key is never
  // sent to the frontend/browser. Free tier key: https://console.groq.com/keys
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  // Requests/minute the chat endpoint allows across ALL users combined -
  // Groq's free tier is one shared quota per API key, not per-user, so this
  // caps total usage regardless of how many people are chatting at once.
  // Tune to your actual plan: https://console.groq.com/docs/rate-limits
  groqChatRpmGlobal: parseInt(process.env.GROQ_CHAT_RPM_GLOBAL || '25', 10),
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

// ENCRYPTION_KEY protects Salesforce OAuth tokens at rest (see
// encryptionService.js) - unlike the other "recommended" vars above, a
// missing or still-default value here isn't just a degraded feature, it
// means every connected user's Salesforce org access is encrypted with a
// key checked into source control (the fallback below), which anyone
// reading this file could decrypt with. Hard-fail in production the same
// way JWT_SECRET does; still just a loud warning in development so a fresh
// clone without a .env can run at all.
const DEFAULT_ENCRYPTION_KEY = 'your-32-char-encryption-key-here';
if (config.nodeEnv === 'production' && (!process.env.ENCRYPTION_KEY || config.encryptionKey === DEFAULT_ENCRYPTION_KEY)) {
  console.error('❌ Error: ENCRYPTION_KEY must be set to a real, unique secret in production (refusing to run with the default placeholder key)');
  process.exit(1);
}
 
// MongoDB warning
if (!config.mongodbUri) {
  console.warn('⚠️  Warning: MONGODB_URI not set - database features will not work');
}
 
// Salesforce warning
if (!config.salesforceClientId || !config.salesforceClientSecret) {
  console.warn('⚠️  Warning: Salesforce credentials not configured - OAuth will not work');
}

// Salesforce inbound webhook warning
if (!config.salesforceWebhookSecret) {
  console.warn('⚠️  Warning: SALESFORCE_WEBHOOK_SECRET not set - the inbound Salesforce webhook will reject every request');
}

// Email warning
if (!config.emailUser || !config.emailPassword) {
  console.warn('⚠️  Warning: EMAIL_USER/EMAIL_PASSWORD not configured - password reset emails will not send');
}

// Groq AI assistant warning - the chat widget checks GET /api/chatbot/status
// and hides itself on the frontend when this is unset, so a missing key is a
// silently-disabled feature, not a broken one.
if (!config.groqApiKey) {
  console.warn('⚠️  Warning: GROQ_API_KEY not set - the AI assistant chat widget will be disabled');
}

// Development warning
if (config.nodeEnv === 'development') {
  console.log('ℹ️  Running in development mode');
}