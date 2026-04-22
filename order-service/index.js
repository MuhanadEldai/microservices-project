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

// Custom metrics for order service
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'order_service_request_duration_ms',
  help: 'Duration of Order Service HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 5, 15, 50, 100, 200, 500, 1000, 2000]
});

const httpRequestsTotal = new client.Counter({
  name: 'order_service_http_requests_total',
  help: 'Total number of HTTP requests in order service',
  labelNames: ['method', 'route', 'status_code']
});

const activeConnections = new client.Gauge({
  name: 'order_service_active_connections',
  help: 'Number of active database connections'
});

const databaseQueryDuration = new client.Histogram({
  name: 'order_service_database_query_duration_ms',
  help: 'Duration of database queries in ms',
  labelNames: ['query_type'],
  buckets: [0.1, 1, 5, 10, 25, 50, 100, 250, 500]
});

const ordersCount = new client.Gauge({
  name: 'order_service_total_orders',
  help: 'Total number of orders in the database'
});

const orderRevenue = new client.Gauge({
  name: 'order_service_total_revenue',
  help: 'Total revenue from all orders'
});

const orderOperations = new client.Counter({
  name: 'order_service_operations_total',
  help: 'Total order operations (create, update, delete, status_change)',
  labelNames: ['operation']
});

const serviceUptime = new client.Gauge({
  name: 'order_service_uptime_seconds',
  help: 'Order service uptime in seconds'
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
      database: process.env.DB_NAME || 'ordersdb',
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
    console.log('✅ Order database connected and pool created');
    
    // Update active connections metric
    activeConnections.inc();
    
    connection.release();
    
    // Update order metrics
    await updateOrderMetrics();
    
  } catch (error) {
    console.error('❌ Order database connection failed:', error.message);
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
    await updateOrderMetrics();
    
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

async function updateOrderMetrics() {
  try {
    if (!pool) return;
    
    const start = Date.now();
    
    // Get order statistics
    const [stats] = await executeQuery(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(SUM(total_amount), 0) as total_revenue
      FROM orders
    `, [], 'metrics_query');
    
    const duration = Date.now() - start;
    databaseQueryDuration
      .labels('metrics_orders')
      .observe(duration);
    
    // Update metrics
    ordersCount.set(stats.total_orders);
    orderRevenue.set(parseFloat(stats.total_revenue) || 0);
    
  } catch (error) {
    console.error('Error updating order metrics:', error.message);
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

// Helper function for transactions with metrics
async function executeTransaction(operations, operationType = 'transaction') {
  if (!pool) {
    throw new Error('Database pool not available');
  }

  let connection;
  const start = Date.now();
  
  try {
    connection = await pool.getConnection();
    activeConnections.inc();
    await connection.beginTransaction();

    const result = await operations(connection);

    await connection.commit();
    
    const duration = Date.now() - start;
    databaseQueryDuration
      .labels(operationType)
      .observe(duration);
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    databaseQueryDuration
      .labels('transaction_error')
      .observe(duration);
      
    if (connection) {
      await connection.rollback();
    }
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
      service: 'order-service',
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (!pool) {
      return res.status(503).json({ 
        status: 'NO_DATABASE', 
        service: 'order-service',
        timestamp: new Date().toISOString()
      });
    }

    const connection = await pool.getConnection();
    await connection.execute('SELECT 1');
    connection.release();
    
    res.json({ 
      status: 'OK', 
      service: 'order-service', 
      database: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      metrics: '/metrics'
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ 
      status: 'ERROR', 
      service: 'order-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Service info endpoint
app.get('/info', (req, res) => {
  res.json({
    service: 'order-service',
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
      'GET /orders',
      'GET /orders/:id',
      'POST /orders',
      'PATCH /orders/:id/status',
      'DELETE /orders/:id',
      'GET /orders/user/:userId',
      'GET /orders/stats/summary'
    ]
  });
});

// Root endpoint for gateway - serve orders
app.get('/', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const orders = await executeQuery(`
      SELECT o.*, 
             COUNT(oi.id) as item_count,
             SUM(oi.quantity * oi.unit_price) as calculated_total
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [], 'select_all_orders');
    
    res.json({ 
      success: true, 
      data: orders,
      count: orders.length,
      message: 'Orders served from root endpoint',
      metrics: 'Available at /metrics'
    });
  } catch (error) {
    console.error('Error fetching orders from root:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get all orders with items
app.get('/orderS', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const orders = await executeQuery(`
      SELECT o.*, 
             COUNT(oi.id) as item_count,
             SUM(oi.quantity * oi.unit_price) as calculated_total
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [], 'select_all_orders');
    
    res.json({ 
      success: true, 
      data: orders,
      count: orders.length,
      metrics_note: 'Order metrics updated automatically'
    });
  } catch (error) {
    console.error('Error fetching orders:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get order by ID with items
app.get('/orders/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    // Get order details
    const orders = await executeQuery(
      'SELECT * FROM orders WHERE id = ?', 
      [req.params.id],
      'select_order_by_id'
    );
    
    if (orders.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Order not found' 
      });
    }

    // Get order items
    const items = await executeQuery(`
      SELECT oi.*, p.name as product_name 
      FROM order_items oi 
      LEFT JOIN productdb.products p ON oi.product_id = p.id 
      WHERE oi.order_id = ?
    `, [req.params.id], 'select_order_items');

    res.json({ 
      success: true, 
      data: {
        ...orders[0],
        items: items
      }
    });
  } catch (error) {
    console.error('Error fetching order:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get orders by user ID
app.get('/orders/user/:userId', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const orders = await executeQuery(`
      SELECT o.*, 
             COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [req.params.userId], 'select_orders_by_user');
    
    res.json({ 
      success: true, 
      data: orders,
      count: orders.length,
      user_id: parseInt(req.params.userId)
    });
  } catch (error) {
    console.error('Error fetching user orders:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Create order
app.post('/orders', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { user_id, items } = req.body;
    
    if (!user_id || !items || !Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        error: 'User ID and items array are required'
      });
    }

    // Validate items
    for (const item of items) {
      if (!item.product_id || !item.quantity || !item.unit_price) {
        return res.status(400).json({
          success: false,
          error: 'Each item must have product_id, quantity, and unit_price'
        });
      }
    }

    // Calculate total amount
    let total_amount = 0;
    for (const item of items) {
      total_amount += item.quantity * item.unit_price;
    }

    const result = await executeTransaction(async (connection) => {
      // Create order
      const [orderResult] = await connection.execute(
        'INSERT INTO orders (user_id, total_amount) VALUES (?, ?)',
        [user_id, total_amount]
      );

      const orderId = orderResult.insertId;

      // Add order items
      for (const item of items) {
        await connection.execute(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
          [orderId, item.product_id, item.quantity, item.unit_price]
        );
      }

      return {
        orderId,
        user_id,
        total_amount,
        item_count: items.length
      };
    }, 'create_order');

    // Update metrics
    orderOperations.inc({ operation: 'create' });
    await updateOrderMetrics();

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: result,
      metrics: 'Order count and revenue metrics updated'
    });

  } catch (error) {
    console.error('Error creating order:', error.message);
    res.status(500).json({
      success: false,
      error: 'Database error: ' + error.message
    });
  }
});

// Update order status
app.patch('/orders/:id/status', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const result = await executeQuery(
      'UPDATE orders SET status = ? WHERE id = ?',
      [status, req.params.id],
      'update_order_status'
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Update metrics
    orderOperations.inc({ operation: 'status_change' });

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      order_id: parseInt(req.params.id),
      new_status: status,
      metrics: 'Status change operation tracked'
    });

  } catch (error) {
    console.error('Error updating order status:', error.message);
    res.status(500).json({
      success: false,
      error: 'Database error: ' + error.message
    });
  }
});

// Delete order
app.delete('/orders/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const result = await executeQuery(
      'DELETE FROM orders WHERE id = ?', 
      [req.params.id],
      'delete_order'
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Update metrics
    orderOperations.inc({ operation: 'delete' });
    await updateOrderMetrics();

    res.json({
      success: true,
      message: 'Order deleted successfully',
      metrics: 'Order count metric updated'
    });
  } catch (error) {
    console.error('Error deleting order:', error.message);
    res.status(500).json({
      success: false,
      error: 'Database error: ' + error.message
    });
  }
});

// Get order statistics
app.get('/orders/stats/summary', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const stats = await executeQuery(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(total_amount) as total_revenue,
        AVG(total_amount) as average_order_value,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders
      FROM orders
    `, [], 'order_statistics');

    res.json({
      success: true,
      data: stats[0],
      timestamp: new Date().toISOString(),
      metrics: 'Statistics available in Prometheus metrics'
    });
  } catch (error) {
    console.error('Error fetching order stats:', error.message);
    res.status(500).json({
      success: false,
      error: 'Database error: ' + error.message
    });
  }
});

// ==================== SERVER INITIALIZATION ====================

// Initialize database and start server
initializeDatabase().then(() => {
  const server = app.listen(3004, '0.0.0.0', () => {
    console.log('📋 Order service running on port 3004');
    console.log('✅ Ready to accept requests');
    console.log('📊 Metrics available at /metrics');
    console.log('🔧 Using connection pooling for better performance');
    console.log('📈 Prometheus monitoring enabled');
  });

  // Update uptime metric periodically
  setInterval(() => {
    serviceUptime.set(process.uptime());
  }, 10000);

  // Update order metrics periodically
  setInterval(async () => {
    await updateOrderMetrics();
  }, 30000); // Every 30 seconds

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
