import { config } from '../config/env.js';
 
let isConnected = false;
 
/**
 * Connect to MongoDB
 * Logs connection status but allows app to run without DB
 */
export const connectDB = async () => {
  if (isConnected) {
    return;
  }
 
  if (!config.mongodbUri) {
    console.warn('⚠️  MongoDB URI not configured - database features will be limited');
    return;
  }
 
  try {
    await mongoose.connect(config.mongodbUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
 
    isConnected = true;
    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.warn('⚠️  App will continue to run without database features');
  }
};
 
/**
 * Get connection status
 */
export const isDBConnected = () => isConnected;
 
/**
 * Disconnect from MongoDB
 */
export const disconnectDB = async () => {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('✅ MongoDB disconnected');
  }
};