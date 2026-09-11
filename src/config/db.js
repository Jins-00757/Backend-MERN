import mongoose from 'mongoose';
import { config } from './env.js';

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) {
    console.log('ℹ️  Using existing MongoDB connection');
    return;
  }

  if (!config.mongodbUri) {
    console.warn('⚠️  MONGODB_URI not configured - skipping database connection');
    return;
  }

  try {
    console.log('🔗 Connecting to MongoDB...');
    const connection = await mongoose.connect(config.mongodbUri, {
      retryWrites: true,
      w: 'majority',
      serverSelectionTimeoutMS: 10000,
    });
    isConnected = true;
    console.log('✅ MongoDB Connected Successfully');
    console.log(`   Host: ${connection.connection.host}`);
    console.log(`   Database: ${connection.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB Connection Failed:');
    console.error(`   Error: ${error.message}`);
    isConnected = false;
  }
};

export const isDBConnected = () => {
  return isConnected && mongoose.connection.readyState === 1;
};

export default { connectDB, isDBConnected };