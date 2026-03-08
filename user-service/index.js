const express = require('express');
const mysql = require('mysql2/promise');
const client = require('prom-client');

const app = express();

app.use(express.json());

let pool;
let isShuttingDown = false;

// ==================== PROMETHEUS METRICS SETUP ====================

// Collect default metrics (CPU, memory, etc.)
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

// Custom metrics for user service
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'user_service_request_duration_ms',
  help: 'Duration of User Service HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 5, 15, 50, 100, 200, 500, 1000]
});

const httpRequestsTotal = new client.Counter({
  name: 'user_service_http_requests_total',
  help: 'Total number of HTTP requests in user service',
  labelNames: ['method', 'route', 'status_code']
});

const activeConnections = new client.Gauge({
  name: 'user_service_active_connections',
  help: 'Number of active database connections'
});

const databaseQueryDuration = new client.Histogram({
  name: 'user_service_database_query_duration_ms',
  help: 'Duration of database queries in ms',
  labelNames: ['query_type'],
  buckets: [0.1, 1, 5, 10, 25, 50, 100, 250, 500]
});

const usersCount = new client.Gauge({
  name: 'user_service_total_users',
  help: 'Total number of users in the database'
});

const serviceUptime = new client.Gauge({
  name: 'user_service_uptime_seconds',
  help: 'User service uptime in seconds'
});

// ==================== DATABASE CONNECTION ====================

// Database connection with connection pooling
async function initializeDatabase() {
  try {
    console.log('🔄 Creating database connection pool...');
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'db',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'rootpassword',
      database: process.env.DB_NAME || 'usersdb',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      acquireTimeout: 60000,
      timeout: 60000,
      reconnect: true,
      connectTimeout: 10000,
      acquireTimeout: 10000,
      timeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });

    // Test the connection
    const connection = await pool.getConnection();
    console.log('✅ User database connected and pool created');
    
    // Update active connections metric
    activeConnections.inc();
    
    connection.release();
    
    // Update users count metric
    await updateUsersCountMetric();
    
  } catch (error) {
    console.error('❌ User database connection failed:', error.message);
    // Retry after 5 seconds
    setTimeout(initializeDatabase, 5000);
  }
}

// ==================== METRICS MIDDLEWARE ====================

// Metrics collection middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    httpRequestDurationMicroseconds
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration);
      
    httpRequestsTotal
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .inc();
      
    console.log(`📊 [METRICS] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
  });
  
  next();
});

// ==================== METRICS ENDPOINT ====================

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    // Update dynamic metrics
    serviceUptime.set(process.uptime());
    await updateUsersCountMetric();
    
    res.set('Content-Type', client.register.contentType);
    const metrics = await client.register.metrics();
    res.end(metrics);
  } catch (error) {
    console.error('❌ Metrics endpoint error:', error.message);
    res.status(500).json({ 
      error: 'Failed to generate metrics',
      message: error.message 
    });
  }
});

// ==================== HELPER FUNCTIONS ====================

async function updateUsersCountMetric() {
  try {
    if (!pool) return;
    
    const start = Date.now();
    const result = await executeQuery('SELECT COUNT(*) as count FROM users');
    const duration = Date.now() - start;
    
    databaseQueryDuration
      .labels('count_users')
      .observe(duration);
    
    usersCount.set(result[0].count);
  } catch (error) {
    console.error('Error updating users count metric:', error.message);
  }
}

// Helper function to execute queries with metrics
async function executeQuery(query, params = [], queryType = 'custom') {
  if (!pool) {
    throw new Error('Database pool not available');
  }

  let connection;
  const start = Date.now();
  
  try {
    connection = await pool.getConnection();
    activeConnections.inc();
    
    const [result] = await connection.execute(query, params);
    
    const duration = Date.now() - start;
    databaseQueryDuration
      .labels(queryType)
      .observe(duration);
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    databaseQueryDuration
      .labels('error')
      .observe(duration);
      
    console.error('Database query error:', error.message);
    throw error;
  } finally {
    if (connection) {
      connection.release();
      activeConnections.dec();
    }
  }
}

// ==================== ROUTES WITH METRICS ====================

// Enhanced Health check with metrics
app.get('/health', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      status: 'SHUTTING_DOWN', 
      service: 'user-service',
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (!pool) {
      return res.status(503).json({ 
        status: 'NO_DATABASE', 
        service: 'user-service',
        timestamp: new Date().toISOString()
      });
    }

    const connection = await pool.getConnection();
    await connection.execute('SELECT 1');
    connection.release();
    
    res.json({ 
      status: 'OK', 
      service: 'user-service', 
      database: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      metrics: '/metrics'
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ 
      status: 'ERROR', 
      service: 'user-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Service info endpoint
app.get('/info', (req, res) => {
  res.json({
    service: 'user-service',
    version: '1.0.0',
    status: 'running',
    database: pool ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    metrics: {
      endpoint: '/metrics',
      available: true
    },
    endpoints: [
      'GET /health',
      'GET /metrics',
      'GET /info',
      'GET /users',
      'GET /users/:id',
      'POST /users',
      'GET /users/:id/orders'
    ]
  });
});

// Root endpoint for gateway - serve users
app.get('/', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const users = await executeQuery(
      'SELECT id, username, email, created_at FROM users',
      [],
      'select_all_users'
    );
    
    res.json({ 
      success: true, 
      data: users,
      count: users.length,
      message: 'Users served from root endpoint',
      metrics: 'Available at /metrics'
    });
  } catch (error) {
    console.error('Error fetching users from root:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get all users
app.get('/users', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const users = await executeQuery(
      'SELECT id, username, email, created_at FROM users',
      [],
      'select_all_users'
    );
    
    res.json({ 
      success: true, 
      data: users,
      count: users.length,
      metrics_note: 'User count metric updated automatically'
    });
  } catch (error) {
    console.error('Error fetching users:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get user by ID
app.get('/users/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const users = await executeQuery(
      'SELECT id, username, email, created_at FROM users WHERE id = ?', 
      [req.params.id],
      'select_user_by_id'
    );
    
    if (users.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    res.json({ 
      success: true, 
      data: users[0] 
    });
  } catch (error) {
    console.error('Error fetching user:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Create user
app.post('/users', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { username, email, password } = req.body;
    
    // Simple validation
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username, email, and password are required'
      });
    }

    const result = await executeQuery(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, password],
      'insert_user'
    );

    // Update users count metric after successful creation
    await updateUsersCountMetric();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: {
        id: result.insertId,
        username,
        email
      },
      metrics: 'User count metric updated'
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        error: 'Username or email already exists'
      });
    }
    console.error('Error creating user:', error.message);
    res.status(500).json({
      success: false,
      error: 'Database error: ' + error.message
    });
  }
});

// Get user orders (cross-service example)
app.get('/users/:id/orders', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    // Verify user exists first
    const users = await executeQuery(
      'SELECT id FROM users WHERE id = ?',
      [req.params.id],
      'verify_user_exists'
    );
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: `Orders for user ${req.params.id} would be fetched from order service`,
      user_id: parseInt(req.params.id),
      note: 'This endpoint demonstrates cross-service communication',
      metrics: 'All database queries are monitored'
    });
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({
      success: false,
      error: 'Service error: ' + error.message
    });
  }
});

// ==================== SERVER INITIALIZATION ====================

// Initialize database and start server
initializeDatabase().then(() => {
  const server = app.listen(3002, '0.0.0.0', () => {
    console.log('👤 User service running on port 3002');
    console.log('✅ Ready to accept requests');
    console.log('📊 Metrics available at /metrics');
    console.log('🔧 Using connection pooling for better performance');
    console.log('📈 Prometheus monitoring enabled');
  });

  // Update uptime metric periodically
  setInterval(() => {
    serviceUptime.set(process.uptime());
  }, 10000);

  // Handle server shutdown
  const gracefulShutdown = () => {
    console.log('🛑 Shutting down server gracefully...');
    isShuttingDown = true;
    
    server.close(async (err) => {
      if (err) {
        console.error('Error closing server:', err);
        process.exit(1);
      }
      
      if (pool) {
        try {
          await pool.end();
          console.log('✅ Database pool closed');
        } catch (dbError) {
          console.error('Error closing database pool:', dbError);
        }
      }
      
      console.log('✅ Server shut down gracefully');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.log('⚠️ Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
});

// ==================== ERROR HANDLING ====================

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});
