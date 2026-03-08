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

// Custom metrics for product service
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'product_service_request_duration_ms',
  help: 'Duration of Product Service HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 5, 15, 50, 100, 200, 500, 1000]
});

const httpRequestsTotal = new client.Counter({
  name: 'product_service_http_requests_total',
  help: 'Total number of HTTP requests in product service',
  labelNames: ['method', 'route', 'status_code']
});

const activeConnections = new client.Gauge({
  name: 'product_service_active_connections',
  help: 'Number of active database connections'
});

const databaseQueryDuration = new client.Histogram({
  name: 'product_service_database_query_duration_ms',
  help: 'Duration of database queries in ms',
  labelNames: ['query_type'],
  buckets: [0.1, 1, 5, 10, 25, 50, 100, 250, 500]
});

const productsCount = new client.Gauge({
  name: 'product_service_total_products',
  help: 'Total number of products in the database'
});

const productsPriceSummary = new client.Summary({
  name: 'product_service_price_summary',
  help: 'Summary of product prices',
  labelNames: ['category'],
  percentiles: [0.5, 0.9, 0.95, 0.99]
});

const serviceUptime = new client.Gauge({
  name: 'product_service_uptime_seconds',
  help: 'Product service uptime in seconds'
});

const productOperations = new client.Counter({
  name: 'product_service_operations_total',
  help: 'Total product operations (create, update, delete)',
  labelNames: ['operation']
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
      database: process.env.DB_NAME || 'productdb',
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
    console.log('✅ Product database connected and pool created');
    
    // Update active connections metric
    activeConnections.inc();
    
    connection.release();
    
    // Update products count metric
    await updateProductsMetrics();
    
  } catch (error) {
    console.error('❌ Product database connection failed:', error.message);
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
    await updateProductsMetrics();
    
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

async function updateProductsMetrics() {
  try {
    if (!pool) return;
    
    const start = Date.now();
    const products = await executeQuery('SELECT * FROM products', [], 'metrics_query');
    const duration = Date.now() - start;
    
    databaseQueryDuration
      .labels('metrics_products')
      .observe(duration);
    
    // Update products count
    productsCount.set(products.length);
    
    // Update price summary
    products.forEach(product => {
      productsPriceSummary
        .labels(product.category || 'uncategorized')
        .observe(parseFloat(product.price) || 0);
    });
    
  } catch (error) {
    console.error('Error updating products metrics:', error.message);
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
      service: 'product-service',
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (!pool) {
      return res.status(503).json({ 
        status: 'NO_DATABASE', 
        service: 'product-service',
        timestamp: new Date().toISOString()
      });
    }

    const connection = await pool.getConnection();
    await connection.execute('SELECT 1');
    connection.release();
    
    res.json({ 
      status: 'OK', 
      service: 'product-service', 
      database: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      metrics: '/metrics'
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ 
      status: 'ERROR', 
      service: 'product-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Service info endpoint
app.get('/info', (req, res) => {
  res.json({
    service: 'product-service',
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
      'GET /products',
      'GET /products/:id',
      'POST /products',
      'PUT /products/:id',
      'DELETE /products/:id',
      'GET /products/search/:query'
    ]
  });
});

// Root endpoint for gateway - serve products
app.get('/', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const products = await executeQuery('SELECT * FROM products', [], 'select_all_products');
    
    res.json({ 
      success: true, 
      data: products,
      count: products.length,
      message: 'Products served from root endpoint',
      metrics: 'Available at /metrics'
    });
  } catch (error) {
    console.error('Error fetching products from root:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get all products (alternative endpoint)
app.get('/products', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const products = await executeQuery('SELECT * FROM products', [], 'select_all_products');
    
    res.json({ 
      success: true, 
      data: products,
      count: products.length,
      metrics_note: 'Product metrics updated automatically'
    });
  } catch (error) {
    console.error('Error fetching products:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get product by ID
app.get('/products/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const products = await executeQuery(
      'SELECT * FROM products WHERE id = ?', 
      [req.params.id],
      'select_product_by_id'
    );
    
    if (products.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }
    
    res.json({ 
      success: true, 
      data: products[0] 
    });
  } catch (error) {
    console.error('Error fetching product:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Create product
app.post('/products', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { name, description, price, stock_quantity, category } = req.body;
    
    // Validation
    if (!name || !price) {
      return res.status(400).json({
        success: false,
        error: 'Product name and price are required'
      });
    }

    const result = await executeQuery(
      'INSERT INTO products (name, description, price, stock_quantity, category) VALUES (?, ?, ?, ?, ?)',
      [name, description || '', price, stock_quantity || 0, category || 'general'],
      'insert_product'
    );

    // Update metrics
    productOperations.inc({ operation: 'create' });
    await updateProductsMetrics();

    res.status(201).json({ 
      success: true, 
      message: 'Product created successfully',
      productId: result.insertId,
      metrics: 'Product count and operations metrics updated'
    });
  } catch (error) {
    console.error('Error creating product:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Update product
app.put('/products/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { name, description, price, stock_quantity, category } = req.body;
    const productId = req.params.id;

    const result = await executeQuery(
      'UPDATE products SET name = ?, description = ?, price = ?, stock_quantity = ?, category = ? WHERE id = ?',
      [name, description, price, stock_quantity, category, productId],
      'update_product'
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }

    // Update metrics
    productOperations.inc({ operation: 'update' });
    await updateProductsMetrics();

    res.json({ 
      success: true, 
      message: 'Product updated successfully',
      metrics: 'Product metrics updated'
    });
  } catch (error) {
    console.error('Error updating product:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Delete product
app.delete('/products/:id', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const result = await executeQuery(
      'DELETE FROM products WHERE id = ?', 
      [req.params.id],
      'delete_product'
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }

    // Update metrics
    productOperations.inc({ operation: 'delete' });
    await updateProductsMetrics();

    res.json({ 
      success: true, 
      message: 'Product deleted successfully',
      metrics: 'Product count metric updated'
    });
  } catch (error) {
    console.error('Error deleting product:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Search products by name
app.get('/products/search/:query', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const searchQuery = `%${req.params.query}%`;
    const products = await executeQuery(
      'SELECT * FROM products WHERE name LIKE ? OR description LIKE ?',
      [searchQuery, searchQuery],
      'search_products'
    );
    
    res.json({ 
      success: true, 
      data: products,
      count: products.length,
      search_query: req.params.query,
      metrics: 'Search query tracked in metrics'
    });
  } catch (error) {
    console.error('Error searching products:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// Get products by category
app.get('/products/category/:category', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const products = await executeQuery(
      'SELECT * FROM products WHERE category = ?',
      [req.params.category],
      'select_products_by_category'
    );
    
    res.json({ 
      success: true, 
      data: products,
      count: products.length,
      category: req.params.category
    });
  } catch (error) {
    console.error('Error fetching products by category:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

// ==================== SERVER INITIALIZATION ====================

// Initialize database and start server
initializeDatabase().then(() => {
  const server = app.listen(3003, '0.0.0.0', () => {
    console.log('📦 Product service running on port 3003');
    console.log('✅ Ready to accept requests');
    console.log('📊 Metrics available at /metrics');
    console.log('🔧 Using connection pooling for better performance');
    console.log('📈 Prometheus monitoring enabled');
  });

  // Update uptime metric periodically
  setInterval(() => {
    serviceUptime.set(process.uptime());
  }, 10000);

  // Update products metrics periodically
  setInterval(async () => {
    await updateProductsMetrics();
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
