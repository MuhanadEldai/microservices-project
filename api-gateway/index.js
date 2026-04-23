const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const client = require('prom-client');

const app = express();

// ==================== PROMETHEUS METRICS SETUP ====================

// Collect default metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

// Custom metrics for API Gateway
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'api_gateway_request_duration_ms',
  help: 'Duration of API Gateway HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [0.1, 5, 15, 50, 100, 200, 500, 1000, 2000]
});

const httpRequestsTotal = new client.Counter({
  name: 'api_gateway_http_requests_total',
  help: 'Total number of HTTP requests in API Gateway',
  labelNames: ['method', 'route', 'status_code', 'service']
});

const activeRequests = new client.Gauge({
  name: 'api_gateway_active_requests',
  help: 'Number of active requests in API Gateway'
});

const serviceHealth = new client.Gauge({
  name: 'api_gateway_service_health',
  help: 'Health status of backend services (1=healthy, 0=unhealthy)',
  labelNames: ['service']
});

const serviceResponseTime = new client.Gauge({
  name: 'api_gateway_service_response_time_ms',
  help: 'Response time of backend services in ms',
  labelNames: ['service']
});

app.use(express.json());

// ==================== METRICS MIDDLEWARE ====================

// Enhanced logging with metrics
app.use((req, res, next) => {
  const start = Date.now();
  activeRequests.inc();
  
  console.log(`📨 [GATEWAY] ${req.method} ${req.originalUrl}`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    activeRequests.dec();
    
    // Determine which service was called
    let service = 'unknown';
    if (req.originalUrl.startsWith('/Allproducts')) service = 'product-service';
    else if (req.originalUrl.startsWith('/users')) service = 'user-service';
    else if (req.originalUrl.startsWith('/orders')) service = 'order-service';
    
    httpRequestDurationMicroseconds
      .labels(req.method, req.route?.path || req.path, res.statusCode, service)
      .observe(duration);
      
    httpRequestsTotal
      .labels(req.method, req.route?.path || req.path, res.statusCode, service)
      .inc();
      
    console.log(`✅ [GATEWAY] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms - ${service}`);
  });
  
  next();
});

// ==================== METRICS ENDPOINT ====================

// Metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  try {
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

// ==================== HEALTH CHECKS ====================

// Health endpoint with service discovery
app.get('/health', async (req, res) => {
  const healthStatus = {
    status: 'OK',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {}
  };

  try {
   
    healthStatus.metrics = 'Available at /metrics';
    res.json(healthStatus);
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'api-gateway',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Service info endpoint
app.get('/info', (req, res) => {
  res.json({
    service: 'api-gateway',
    version: '1.0.0',
    status: 'running',
    uptime: process.uptime(),
    metrics: {
      endpoint: '/metrics',
      available: true
    },
    endpoints: {
      monitoring: {
        health: 'GET /health',
        metrics: 'GET /metrics',
        info: 'GET /info'
      },
      services: {
        products: {
          list: 'GET /products',
          get: 'GET /products/:id',
          create: 'POST /products',
          search: 'GET /products/search/:query'
        },
        users: {
          list: 'GET /users',
          get: 'GET /users/:id',
          create: 'POST /users',
          orders: 'GET /users/:id/orders'
        },
        orders: {
          list: 'GET /orders',
          get: 'GET /orders/:id',
          create: 'POST /orders',
          by_user: 'GET /orders/user/:userId'
        }
      }
    }
  });
});

// ==================== SERVICE PROXIES ====================

// Product Service Proxy with error tracking
app.use('/productsTEST', createProxyMiddleware({
  target: 'http://product-service:3003',
  changeOrigin: true,
  pathRewrite: {
    '^/productsTEST': ''
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`📦 Proxying to product-service: ${req.method} ${req.originalUrl}`);
  },
  onError: (err, req, res) => {
    console.error('❌ Product service proxy error:', err.message);
    serviceHealth.labels('product-service').set(0);
    res.status(503).json({
      error: 'Product service unavailable',
      message: err.message
    });
  },
  onProxyRes: (proxyRes, req, res) => {
    serviceHealth.labels('product-service').set(1);
  }
}));

// User Service Proxy with error tracking
app.use('/users', createProxyMiddleware({
  target: 'http://user-service:3002',
  changeOrigin: true,
  pathRewrite: {
    '^/users': ''
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`👤 Proxying to user-service: ${req.method} ${req.originalUrl}`);
  },
  onError: (err, req, res) => {
    console.error('❌ User service proxy error:', err.message);
    serviceHealth.labels('user-service').set(0);
    res.status(503).json({
      error: 'User service unavailable',
      message: err.message
    });
  },
  onProxyRes: (proxyRes, req, res) => {
    serviceHealth.labels('user-service').set(1);
  }
}));

// Order Service Proxy with error tracking
app.use('/ORDERS', createProxyMiddleware({
  target: 'http://order-service:3004',
  changeOrigin: true,
  pathRewrite: {
    '^/orders': ''
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`📋 Proxying to order-service: ${req.method} ${req.originalUrl}`);
  },
  onError: (err, req, res) => {
    console.error('❌ Order service proxy error:', err.message);
    serviceHealth.labels('order-service').set(0);
    res.status(503).json({
      error: 'Order service unavailable',
      message: err.message
    });
  },
  onProxyRes: (proxyRes, req, res) => {
    serviceHealth.labels('order-service').set(1);
  }
}));

// ==================== COMPOSITE ENDPOINTS ====================

// Dashboard endpoint - aggregates data from multiple services
app.get('/dashboard', async (req, res) => {
  try {
    console.log('📊 Fetching dashboard data...');
    
    res.json({
      success: true,
      message: 'Dashboard endpoint - would aggregate data from all services',
      timestamp: new Date().toISOString(),
      services: ['products', 'users', 'orders'],
      metrics: 'All requests are monitored and metrics available at /metrics'
    });
  } catch (error) {
    console.error('❌ Dashboard error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch dashboard data',
      message: error.message
    });
  }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use('*', (req, res) => {
  console.log(`❌ 404 - Route not found: ${req.originalUrl}`);
  res.status(404).json({
    error: 'Endpoint not found',
    requested: req.originalUrl,
    available_endpoints: [
      'GET /health',
      'GET /metrics',
      'GET /info',
      'GET /dashboard',
      'GET /products',
      'GET /users',
      'GET /orders'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// ==================== SERVER STARTUP ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ API Gateway with Metrics successfully started!');
  console.log('📍 Port:', PORT);
  console.log('📊 Metrics available at /metrics');
  console.log('🔀 Proxying to:');
  console.log('   - /products -> http://product-service:3003/');
  console.log('   - /users    -> http://user-service:3002/');
  console.log('   - /orders   -> http://order-service:3004/');
  console.log('🚀 All services available through gateway!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
