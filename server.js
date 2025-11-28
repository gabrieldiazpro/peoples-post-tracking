/**
 * ROUTZ - Branded Tracking & Returns Platform
 * Main Server Entry Point
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const trackingRoutes = require('./api-routes');
const servicePointRoutes = require('./service-point-routes');

// Shopify integration (conditional)
let shopifyApp = null;
if (process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET) {
    const { ShopifyApp } = require('./integrations/shopify-app');
    shopifyApp = new ShopifyApp();
    console.log('Shopify integration enabled');
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            frameSrc: ["'self'", "https://js.stripe.com"],
            connectSrc: ["'self'", "https://api.mapbox.com", "https://api.stripe.com"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id']
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting for public API routes
const publicLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: { error: 'Too many requests, please try again later.' }
});

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // 20 attempts per hour
    message: { error: 'Too many authentication attempts, please try again later.' }
});

// Apply rate limiting
app.use('/api/returns/find-order', publicLimiter);
app.use('/api/tracking', publicLimiter);
app.use('/api/service-points', publicLimiter);

// ============================================
// STATIC FILES
// ============================================

// Serve static files from public directory
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), {
    maxAge: '1d',
    etag: true
}));

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: require('./package.json').version
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'Routz Tracking & Returns Platform',
        version: require('./package.json').version,
        documentation: '/docs',
        endpoints: {
            tracking: '/t/:trackingNumber',
            returns: '/returns/:orgId',
            api: '/api',
            widget: '/widget'
        }
    });
});

// ============================================
// API ROUTES
// ============================================

// Tracking & Returns routes
app.use('/', trackingRoutes);

// Service Point routes
app.use('/', servicePointRoutes);

// Shopify routes (if enabled)
if (shopifyApp) {
    app.use('/shopify', shopifyApp.getRouter());
}

// ============================================
// API DOCUMENTATION (OpenAPI)
// ============================================

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'docs', 'openapi.yaml'));
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `The requested endpoint ${req.method} ${req.path} does not exist.`
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);

    // Don't leak stack traces in production
    const isDev = process.env.NODE_ENV !== 'production';

    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(isDev && { stack: err.stack })
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Shutting down gracefully...');

    // Close database connections, etc.
    // await db.end();
    // await redis.quit();

    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received. Shutting down gracefully...');
    process.exit(0);
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 ROUTZ Tracking & Returns Platform                       ║
║                                                              ║
║   Server running on port ${PORT}                               ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║                                                              ║
║   Endpoints:                                                 ║
║   • Health:    http://localhost:${PORT}/health                 ║
║   • Tracking:  http://localhost:${PORT}/t/:trackingNumber      ║
║   • Returns:   http://localhost:${PORT}/returns/:orgId         ║
║   • API Docs:  http://localhost:${PORT}/docs                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
