import app from './src/app.js';
import { config } from './src/config/env.js';
import { setupWebSocket } from './src/middleware/websocket.js';

// ============================================================================
// Server Configuration
// ============================================================================

const PORT = config.port || 5005;
const HOST = '0.0.0.0';

// ============================================================================
// Startup Logging
// ============================================================================

console.log('\n========================================');
console.log('🚀 Starting Sales Pipeline Backend');
console.log('========================================\n');

console.log('📋 Configuration:');
console.log(`   Port: ${PORT}`);
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Client URL: ${config.clientUrl}`);
console.log(`   MongoDB: ${config.mongodbUri ? '✓ Configured' : '✗ Not configured'}`);
console.log('');

// ============================================================================
// Start Server
// ============================================================================

const server = app.listen(PORT, HOST, () => {
  console.log('✅ Server Status:');
  console.log(`   ✓ Server running on http://localhost:${PORT}`);
  console.log(`   ✓ Environment: ${config.nodeEnv}`);
  console.log(`   ✓ Listening on ${HOST}:${PORT}`);
  console.log(`   ✓ WebSocket notifications on ws://${HOST}:${PORT}/ws`);
  console.log('\n========================================\n');
});

// Real-time notifications (see middleware/websocket.js) share this same
// HTTP server/port rather than opening a second listener.
setupWebSocket(server);

// ============================================================================
// Error Handlers
// ============================================================================

// Handle server errors (e.g., port already in use)
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use`);
    console.error('   Try using a different port or kill the process using this port');
  } else if (error.code === 'EACCES') {
    console.error(`\n❌ Error: Permission denied to bind to port ${PORT}`);
    console.error('   Try using a port number >= 1024');
  } else {
    console.error('\n❌ Server Error:', error.message);
  }
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('\n❌ Uncaught Exception:');
  console.error(error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Rejection:');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

const gracefulShutdown = (signal) => {
  console.log(`\n⚠️  ${signal} received, shutting down gracefully...`);

  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================================
// Export for testing
// ============================================================================

export { server };