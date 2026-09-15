import mongoose from 'mongoose';
import { config } from './env.js';

// Attached once at module load (not per connectDB() call) so any runtime
// disconnect/error/reconnect on the single shared Mongoose connection is
// always logged, not just failures during the initial connect() below.
mongoose.connection.on('error', (error) => {
  console.error('❌ MongoDB connection error:', error.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

/**
 * Connect to MongoDB. Safe to call more than once - a no-op whenever a
 * connection is already open or in progress. Checked via Mongoose's own
 * connection.readyState rather than a separately-tracked boolean, which
 * would otherwise need to be kept in sync by hand on every disconnect/
 * reconnect and could silently drift from the real connection state.
 */
export const connectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    console.log('ℹ️  MongoDB connection already open or in progress');
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

    console.log('✅ MongoDB Connected Successfully');
    console.log(`   Host: ${connection.connection.host}`);
    console.log(`   Database: ${connection.connection.name}`);

    // The MongoDB driver silently falls back to a database literally named
    // "test" when the connection string has no database segment (e.g.
    // "...mongodb.net/" instead of "...mongodb.net/sales-pipeline") - easy
    // to miss since the app otherwise starts up and runs normally. Surface
    // it immediately instead of leaving it to be discovered later.
    if (connection.connection.name === 'test') {
      console.warn(
        '⚠️  Connected to the default "test" database - MONGODB_URI is likely missing a database name (see .env.example)'
      );
    }
  } catch (error) {
    console.error('❌ MongoDB Connection Failed:');
    console.error(`   Error: ${error.message}`);
  }
};

export const isDBConnected = () => mongoose.connection.readyState === 1;

/**
 * Close the Mongoose connection. Called from server.js's graceful shutdown
 * so SIGTERM/SIGINT (sent on every redeploy in most hosting environments)
 * don't leave the socket open after the HTTP server stops accepting
 * requests.
 */
export const disconnectDB = async () => {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close();
  console.log('✓ MongoDB connection closed');
};

export default { connectDB, isDBConnected, disconnectDB };
