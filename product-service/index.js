const express = require('express');
const mysql = require('mysql2/promise');
const client = require('prom-client');
const os = require('os');
const fs = require('fs'); // Added filesystem module to read cgroups

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

const containerFreeMemory = new client.Gauge({
  name: 'product_service_container_free_memory_mb',
  help: 'Amount of free RAM remaining inside the product service container in MB'
});

const containerTotalMemory = new client.Gauge({
  name: 'product_service_container_total_memory_mb',
  help: 'Total physical RAM allocated to the container in MB'
});

const serviceMemoryUsage = new client.Gauge({
  name: 'product_service_memory_mb',
  help: 'Product service memory usage in MB',
  labelNames: ['type']
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

// ==================== HELPER TO GET CONTAINER ISOLATED MEMORY ====================
function getContainerMemoryMetrics() {
  const MB = 1024 * 1024;
  let totalMemoryMB = 0;
  let usedMemoryMB = 0;
  let freeMemoryMB = 0;

  try {
    // Try reading cgroups v2 paths first (Modern Linux/Docker runtime profiles)
    if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
      const rawMax = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      const rawCurrent = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
      
      const hostTotal = os.totalmem();
      const limitBytes = (rawMax === 'max' || parseInt(rawMax) > hostTotal) ? hostTotal : parseInt(rawMax);
      
      totalMemoryMB = limitBytes / MB;
      usedMemoryMB = parseInt(rawCurrent) / MB;
    } 
    // Fallback parsing layer for cgroups v1 paths
    else if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
      const rawMax = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
      const rawCurrent = fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim();
      
      const hostTotal = os.totalmem();
      const limitBytes = parseInt(rawMax) > hostTotal ? hostTotal : parseInt(rawMax);
      
      totalMemoryMB = limitBytes / MB;
      usedMemoryMB = parseInt(rawCurrent) / MB;
    } else {
      throw new Error('No supported cgroups memory subsystem path located');
    }
    
    freeMemoryMB = Math.max(0, totalMemoryMB - usedMemoryMB);
  } catch (error) {
    // Standard system fallback if executing outside an active isolated Docker target
    totalMemoryMB = os.totalmem() / MB;
    freeMemoryMB = os.freemem() / MB;
  }

  return { total: totalMemoryMB, free: freeMemoryMB };
}

// ==================== DATABASE CONNECTION ====================

async function initializeDatabase() {
  const poolConfig = {
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'rootpassword',
    database: process.env.DB_NAME || 'productdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  };

  while (true) {
    try {
      console.log('🔄 Attempting to connect to database...');
      pool = mysql.createPool(poolConfig);

      // Test the connection immediately
      const connection = await pool.getConnection();
      console.log('✅ Product database connected and pool created');
      
      activeConnections.inc();
      connection.release();
      
      await updateProductsMetrics();
      return; // Success! Exit the loop
    } catch (error) {
      console.error(`❌ Database connection failed (${error.code}). Retrying in 5s...`);
      if (pool) await pool.end(); // Clean up failed pool
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// ==================== METRICS MIDDLEWARE ====================

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

app.get('/metrics', async (req, res) => {
  try {
    const MB = 1024 * 1024;

    // Collect Isolated Container memory status in MB
    const containerMem = getContainerMemoryMetrics();
    containerFreeMemory.set(containerMem.free);
    containerTotalMemory.set(containerMem.total);

    // Collect Node application internal process thread usage in MB
    const memory = process.memoryUsage();
    serviceMemoryUsage.labels('rss').set(memory.rss / MB);
    serviceMemoryUsage.labels('heap_total').set(memory.heapTotal / MB);
    serviceMemoryUsage.labels('heap_used').set(memory.heapUsed / MB);
    serviceMemoryUsage.labels('external').set(memory.external / MB);
  
    // Update dynamic statistics
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

app.get('/health', async (req, res) => {
  if (isShuttingDown) {
    return res.status(200).json({ 
      status: 'SHUTTING_DOWN', 
      service: 'product-service',
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (!pool) {
      return res.status(200).json({ 
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
    res.status(200).json({ 
      status: 'ERROR', 
      service: 'product-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/TEST', (req, res) => {
  res.json({
    service: 'product-service',
    version: '6',
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

app.post('/products', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ 
      success: false, 
      error: 'Service is shutting down' 
    });
  }

  try {
    const { name, description, price, stock_quantity, category } = req.body;
    
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

    productOperations.inc({ operation: 'create' });
    await updateProductsMetrics();

    res.status(201).json({ 
      success: true, 
      message: 'Product created successfully',
      productId: result.insertId,
      metrics: 'Product count and operations metrics updated'
    });
  } catch (error) {
    console.error('Error create product:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message 
    });
  }
});

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

async function startServer() {
  await initializeDatabase();

  const server = app.listen(3003, '0.0.0.0', () => {
    console.log('📦 Product service running on port 3003');
    console.log('📊 Metrics available at /metrics');
  });

  // Synchronized background interval loop (Updates every 10 seconds)
  setInterval(async () => {
    const MB = 1024 * 1024;
    serviceUptime.set(process.uptime());
    
    // Read container isolated cgroup memory details
    const containerMem = getContainerMemoryMetrics();
    containerFreeMemory.set(containerMem.free);
    containerTotalMemory.set(containerMem.total);
    
    // Update application internal memory profiles
    const memory = process.memoryUsage();
    serviceMemoryUsage.labels('rss').set(memory.rss / MB);
    serviceMemoryUsage.labels('heap_total').set(memory.heapTotal / MB);
    serviceMemoryUsage.labels('heap_used').set(memory.heapUsed / MB);
    serviceMemoryUsage.labels('external').set(memory.external / MB);
  }, 10000);

  // Periodically refresh database product metrics profiles (Every 30 seconds)
  setInterval(async () => {
    await updateProductsMetrics();
  }, 30000);

  // Graceful Shutdown Handler
  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    console.log('🛑 Shutting down server gracefully...');
    isShuttingDown = true;
    
    server.close(async () => {
      if (pool) {
        await pool.end();
        console.log('✅ Database pool closed');
      }
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

startServer().catch(err => {
  console.error('❌ Failed to start service:', err);
  process.exit(1);
});