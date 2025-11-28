/**
 * ROUTZ - Logging, Monitoring & Alerting System
 * Structured logging, metrics collection, health checks, alerting
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { ElasticsearchTransport } = require('winston-elasticsearch');
const { Redis } = require('ioredis');
const { Pool } = require('pg');
const os = require('os');
const { EventEmitter } = require('events');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'json',
        console: process.env.LOG_CONSOLE !== 'false',
        file: process.env.LOG_FILE !== 'false',
        elasticsearch: process.env.ELASTICSEARCH_URL ? true : false
    },
    metrics: {
        prefix: 'routz',
        flushInterval: 10000, // 10 seconds
        retentionDays: 30
    },
    alerting: {
        enabled: process.env.ALERTING_ENABLED !== 'false',
        channels: {
            slack: process.env.SLACK_WEBHOOK_URL,
            pagerduty: process.env.PAGERDUTY_KEY,
            email: process.env.ALERT_EMAIL
        },
        thresholds: {
            errorRate: 5, // %
            responseTime: 2000, // ms
            cpuUsage: 80, // %
            memoryUsage: 85, // %
            diskUsage: 90, // %
            queueSize: 10000,
            failedJobs: 100
        }
    },
    healthCheck: {
        interval: 30000, // 30 seconds
        timeout: 5000
    }
};

// ============================================
// CONNECTIONS
// ============================================

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ============================================
// STRUCTURED LOGGER
// ============================================

// Custom format for structured logging
const structuredFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format((info) => {
        info.service = process.env.SERVICE_NAME || 'routz-api';
        info.environment = process.env.NODE_ENV || 'development';
        info.hostname = os.hostname();
        info.pid = process.pid;
        return info;
    })(),
    winston.format.json()
);

// Human-readable format for development
const devFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} ${level}: ${message} ${metaStr}`;
    })
);

// Create transports
const transports = [];

// Console transport
if (config.logging.console) {
    transports.push(new winston.transports.Console({
        format: process.env.NODE_ENV === 'production' ? structuredFormat : devFormat
    }));
}

// File transports with rotation
if (config.logging.file) {
    // Application logs
    transports.push(new DailyRotateFile({
        filename: 'logs/app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '100m',
        maxFiles: '14d',
        format: structuredFormat
    }));

    // Error logs
    transports.push(new DailyRotateFile({
        filename: 'logs/error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '100m',
        maxFiles: '30d',
        level: 'error',
        format: structuredFormat
    }));
}

// Elasticsearch transport
if (config.logging.elasticsearch) {
    transports.push(new ElasticsearchTransport({
        level: 'info',
        clientOpts: { node: process.env.ELASTICSEARCH_URL },
        indexPrefix: 'routz-logs',
        indexSuffixPattern: 'YYYY.MM.DD',
        transformer: (logData) => ({
            '@timestamp': logData.timestamp,
            message: logData.message,
            severity: logData.level,
            fields: logData.meta
        })
    }));
}

// Create logger
const logger = winston.createLogger({
    level: config.logging.level,
    transports,
    exitOnError: false
});

// ============================================
// REQUEST LOGGER MIDDLEWARE
// ============================================

const requestLogger = (req, res, next) => {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] || require('crypto').randomUUID();
    
    req.requestId = requestId;
    req.startTime = startTime;

    // Log request
    logger.info('Incoming request', {
        requestId,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId: req.user?.id,
        orgId: req.user?.orgId
    });

    // Capture response
    const originalSend = res.send;
    res.send = function(body) {
        res.responseBody = body;
        return originalSend.call(this, body);
    };

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

        logger[logLevel]('Request completed', {
            requestId,
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration,
            contentLength: res.get('content-length'),
            userId: req.user?.id,
            orgId: req.user?.orgId
        });

        // Track metrics
        metricsCollector.recordRequest(req.method, req.route?.path || req.path, res.statusCode, duration);
    });

    next();
};

// ============================================
// CHILD LOGGER FACTORY
// ============================================

const createChildLogger = (context) => {
    return logger.child(context);
};

// Carrier-specific loggers
const carrierLogger = (carrier) => createChildLogger({ carrier, component: 'carrier' });
const workerLogger = (worker) => createChildLogger({ worker, component: 'worker' });
const apiLogger = createChildLogger({ component: 'api' });
const authLogger = createChildLogger({ component: 'auth' });
const billingLogger = createChildLogger({ component: 'billing' });

// ============================================
// METRICS COLLECTOR
// ============================================

class MetricsCollector extends EventEmitter {
    constructor() {
        super();
        this.counters = new Map();
        this.gauges = new Map();
        this.histograms = new Map();
        this.timers = new Map();
        
        // Flush metrics periodically
        setInterval(() => this.flush(), config.metrics.flushInterval);
    }

    // Counters
    increment(name, value = 1, tags = {}) {
        const key = this.buildKey(name, tags);
        const current = this.counters.get(key) || 0;
        this.counters.set(key, current + value);
    }

    decrement(name, value = 1, tags = {}) {
        this.increment(name, -value, tags);
    }

    // Gauges
    gauge(name, value, tags = {}) {
        const key = this.buildKey(name, tags);
        this.gauges.set(key, value);
    }

    // Histograms
    histogram(name, value, tags = {}) {
        const key = this.buildKey(name, tags);
        if (!this.histograms.has(key)) {
            this.histograms.set(key, []);
        }
        this.histograms.get(key).push(value);
    }

    // Timers
    startTimer(name, tags = {}) {
        const key = this.buildKey(name, tags);
        const startTime = process.hrtime.bigint();
        
        return {
            end: () => {
                const endTime = process.hrtime.bigint();
                const duration = Number(endTime - startTime) / 1e6; // Convert to ms
                this.histogram(name, duration, tags);
                return duration;
            }
        };
    }

    // Request tracking
    recordRequest(method, path, statusCode, duration) {
        const tags = { method, path: this.normalizePath(path), status: Math.floor(statusCode / 100) * 100 };
        
        this.increment('http_requests_total', 1, tags);
        this.histogram('http_request_duration_ms', duration, tags);
        
        if (statusCode >= 500) {
            this.increment('http_errors_total', 1, { ...tags, code: statusCode });
        }
    }

    // Carrier tracking
    recordCarrierRequest(carrier, operation, success, duration) {
        const tags = { carrier, operation, success: success.toString() };
        
        this.increment('carrier_requests_total', 1, tags);
        this.histogram('carrier_request_duration_ms', duration, tags);
        
        if (!success) {
            this.increment('carrier_errors_total', 1, tags);
        }
    }

    // Worker tracking
    recordJobProcessed(queue, status, duration) {
        const tags = { queue, status };
        
        this.increment('jobs_processed_total', 1, tags);
        this.histogram('job_duration_ms', duration, tags);
    }

    // Build metric key
    buildKey(name, tags = {}) {
        const tagStr = Object.entries(tags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${v}`)
            .join(',');
        return tagStr ? `${name}{${tagStr}}` : name;
    }

    // Normalize path (replace IDs with placeholders)
    normalizePath(path) {
        return path
            ?.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
            ?.replace(/\/\d+/g, '/:id')
            || 'unknown';
    }

    // Flush to Redis
    async flush() {
        const timestamp = Date.now();
        const pipeline = redis.pipeline();

        // Flush counters
        for (const [key, value] of this.counters) {
            pipeline.hincrby(`metrics:counters:${key}`, timestamp, value);
            pipeline.expire(`metrics:counters:${key}`, config.metrics.retentionDays * 86400);
        }
        this.counters.clear();

        // Flush gauges
        for (const [key, value] of this.gauges) {
            pipeline.hset(`metrics:gauges:${key}`, timestamp, value);
            pipeline.expire(`metrics:gauges:${key}`, config.metrics.retentionDays * 86400);
        }

        // Flush histograms (store percentiles)
        for (const [key, values] of this.histograms) {
            if (values.length > 0) {
                const sorted = values.sort((a, b) => a - b);
                const stats = {
                    count: values.length,
                    min: sorted[0],
                    max: sorted[sorted.length - 1],
                    avg: values.reduce((a, b) => a + b, 0) / values.length,
                    p50: this.percentile(sorted, 50),
                    p90: this.percentile(sorted, 90),
                    p99: this.percentile(sorted, 99)
                };
                pipeline.hset(`metrics:histograms:${key}`, timestamp, JSON.stringify(stats));
                pipeline.expire(`metrics:histograms:${key}`, config.metrics.retentionDays * 86400);
            }
        }
        this.histograms.clear();

        await pipeline.exec();
        this.emit('flushed', { timestamp });
    }

    percentile(sorted, p) {
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    // Get metrics for dashboard
    async getMetrics(timeRange = '1h') {
        const now = Date.now();
        const ranges = {
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000
        };
        const since = now - (ranges[timeRange] || ranges['1h']);

        // Collect all metrics keys
        const keys = await redis.keys('metrics:*');
        const metrics = { counters: {}, gauges: {}, histograms: {} };

        for (const key of keys) {
            const [, type, name] = key.split(':');
            const data = await redis.hgetall(key);
            
            // Filter by time range
            const filtered = {};
            for (const [ts, value] of Object.entries(data)) {
                if (parseInt(ts) >= since) {
                    filtered[ts] = type === 'histograms' ? JSON.parse(value) : parseFloat(value);
                }
            }

            if (Object.keys(filtered).length > 0) {
                metrics[type][name] = filtered;
            }
        }

        return metrics;
    }
}

const metricsCollector = new MetricsCollector();

// ============================================
// HEALTH CHECKER
// ============================================

class HealthChecker {
    constructor() {
        this.checks = new Map();
        this.status = 'unknown';
        this.lastCheck = null;
        
        // Register default checks
        this.registerCheck('database', this.checkDatabase.bind(this));
        this.registerCheck('redis', this.checkRedis.bind(this));
        this.registerCheck('memory', this.checkMemory.bind(this));
        this.registerCheck('disk', this.checkDisk.bind(this));
    }

    registerCheck(name, checkFn, options = {}) {
        this.checks.set(name, {
            fn: checkFn,
            critical: options.critical !== false,
            timeout: options.timeout || config.healthCheck.timeout
        });
    }

    async checkDatabase() {
        const start = Date.now();
        try {
            await pool.query('SELECT 1');
            return {
                status: 'healthy',
                latency: Date.now() - start
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                latency: Date.now() - start
            };
        }
    }

    async checkRedis() {
        const start = Date.now();
        try {
            await redis.ping();
            const info = await redis.info('memory');
            const usedMemory = parseInt(info.match(/used_memory:(\d+)/)?.[1] || 0);
            
            return {
                status: 'healthy',
                latency: Date.now() - start,
                usedMemory
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                latency: Date.now() - start
            };
        }
    }

    checkMemory() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
        
        return {
            status: usedPercent < config.alerting.thresholds.memoryUsage ? 'healthy' : 'degraded',
            total: totalMem,
            free: freeMem,
            used: totalMem - freeMem,
            usedPercent: Math.round(usedPercent * 100) / 100
        };
    }

    async checkDisk() {
        // Simplified disk check
        const processMemory = process.memoryUsage();
        
        return {
            status: 'healthy',
            heapUsed: processMemory.heapUsed,
            heapTotal: processMemory.heapTotal,
            external: processMemory.external,
            rss: processMemory.rss
        };
    }

    async runChecks() {
        const results = {};
        let overallStatus = 'healthy';

        for (const [name, check] of this.checks) {
            try {
                const result = await Promise.race([
                    check.fn(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Check timeout')), check.timeout)
                    )
                ]);
                
                results[name] = result;
                
                if (result.status === 'unhealthy' && check.critical) {
                    overallStatus = 'unhealthy';
                } else if (result.status === 'degraded' && overallStatus === 'healthy') {
                    overallStatus = 'degraded';
                }
            } catch (error) {
                results[name] = {
                    status: 'unhealthy',
                    error: error.message
                };
                if (check.critical) {
                    overallStatus = 'unhealthy';
                }
            }
        }

        this.status = overallStatus;
        this.lastCheck = new Date();

        // Track health metrics
        metricsCollector.gauge('health_status', overallStatus === 'healthy' ? 1 : 0);

        return {
            status: overallStatus,
            timestamp: this.lastCheck,
            checks: results,
            system: {
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: os.platform(),
                hostname: os.hostname(),
                cpuCount: os.cpus().length,
                loadAvg: os.loadavg()
            }
        };
    }

    // Express middleware
    middleware() {
        return async (req, res) => {
            const health = await this.runChecks();
            const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
            res.status(statusCode).json(health);
        };
    }

    // Liveness probe (for Kubernetes)
    livenessProbe() {
        return (req, res) => {
            res.status(200).json({ status: 'alive', timestamp: new Date() });
        };
    }

    // Readiness probe (for Kubernetes)
    readinessProbe() {
        return async (req, res) => {
            const health = await this.runChecks();
            if (health.status === 'unhealthy') {
                return res.status(503).json({ status: 'not ready', checks: health.checks });
            }
            res.status(200).json({ status: 'ready' });
        };
    }
}

const healthChecker = new HealthChecker();

// ============================================
// ALERTING SERVICE
// ============================================

class AlertingService extends EventEmitter {
    constructor() {
        super();
        this.alerts = new Map();
        this.cooldowns = new Map();
        this.rules = this.initializeRules();
    }

    initializeRules() {
        return [
            {
                name: 'high_error_rate',
                condition: (metrics) => {
                    const errors = metrics.counters['http_errors_total'] || {};
                    const total = metrics.counters['http_requests_total'] || {};
                    const errorCount = Object.values(errors).reduce((a, b) => a + b, 0);
                    const totalCount = Object.values(total).reduce((a, b) => a + b, 0);
                    return totalCount > 100 && (errorCount / totalCount) * 100 > config.alerting.thresholds.errorRate;
                },
                severity: 'critical',
                message: 'High error rate detected',
                cooldown: 300000 // 5 minutes
            },
            {
                name: 'slow_response_time',
                condition: (metrics) => {
                    const histograms = metrics.histograms['http_request_duration_ms'] || {};
                    const recent = Object.values(histograms).slice(-6); // Last minute
                    if (recent.length === 0) return false;
                    const avgP90 = recent.reduce((a, b) => a + (b.p90 || 0), 0) / recent.length;
                    return avgP90 > config.alerting.thresholds.responseTime;
                },
                severity: 'warning',
                message: 'Slow response times detected',
                cooldown: 600000 // 10 minutes
            },
            {
                name: 'high_memory_usage',
                condition: () => {
                    const totalMem = os.totalmem();
                    const freeMem = os.freemem();
                    const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
                    return usedPercent > config.alerting.thresholds.memoryUsage;
                },
                severity: 'warning',
                message: 'High memory usage',
                cooldown: 900000 // 15 minutes
            },
            {
                name: 'carrier_failures',
                condition: (metrics) => {
                    const errors = metrics.counters['carrier_errors_total'] || {};
                    const recentErrors = Object.values(errors).reduce((a, b) => a + b, 0);
                    return recentErrors > 50;
                },
                severity: 'warning',
                message: 'Multiple carrier API failures',
                cooldown: 600000
            },
            {
                name: 'database_connection_failed',
                condition: async () => {
                    try {
                        await pool.query('SELECT 1');
                        return false;
                    } catch {
                        return true;
                    }
                },
                severity: 'critical',
                message: 'Database connection failed',
                cooldown: 60000
            }
        ];
    }

    async checkRules() {
        if (!config.alerting.enabled) return;

        const metrics = await metricsCollector.getMetrics('1h');

        for (const rule of this.rules) {
            try {
                const triggered = await rule.condition(metrics);
                
                if (triggered && !this.isInCooldown(rule.name)) {
                    await this.triggerAlert(rule, metrics);
                } else if (!triggered && this.alerts.has(rule.name)) {
                    await this.resolveAlert(rule.name);
                }
            } catch (error) {
                logger.error('Alert rule check failed', { rule: rule.name, error: error.message });
            }
        }
    }

    isInCooldown(ruleName) {
        const cooldownUntil = this.cooldowns.get(ruleName);
        return cooldownUntil && Date.now() < cooldownUntil;
    }

    async triggerAlert(rule, metrics) {
        const alert = {
            id: require('crypto').randomUUID(),
            name: rule.name,
            severity: rule.severity,
            message: rule.message,
            triggeredAt: new Date(),
            metrics: this.extractRelevantMetrics(metrics, rule.name)
        };

        this.alerts.set(rule.name, alert);
        this.cooldowns.set(rule.name, Date.now() + rule.cooldown);

        logger.error('Alert triggered', alert);
        this.emit('alert:triggered', alert);

        // Send notifications
        await this.sendNotifications(alert);

        // Store in database
        await pool.query(`
            INSERT INTO alerts (id, name, severity, message, metrics, triggered_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [alert.id, alert.name, alert.severity, alert.message, JSON.stringify(alert.metrics), alert.triggeredAt]);

        return alert;
    }

    async resolveAlert(ruleName) {
        const alert = this.alerts.get(ruleName);
        if (!alert) return;

        alert.resolvedAt = new Date();
        this.alerts.delete(ruleName);

        logger.info('Alert resolved', { name: ruleName, resolvedAt: alert.resolvedAt });
        this.emit('alert:resolved', alert);

        // Update in database
        await pool.query(`
            UPDATE alerts SET resolved_at = NOW() WHERE name = $1 AND resolved_at IS NULL
        `, [ruleName]);

        // Send resolution notification
        await this.sendNotifications({ ...alert, resolved: true });
    }

    extractRelevantMetrics(metrics, ruleName) {
        // Extract only relevant metrics for the alert
        const relevant = {};
        
        if (ruleName.includes('error')) {
            relevant.errors = metrics.counters['http_errors_total'];
            relevant.requests = metrics.counters['http_requests_total'];
        }
        if (ruleName.includes('response')) {
            relevant.responseTime = metrics.histograms['http_request_duration_ms'];
        }
        if (ruleName.includes('carrier')) {
            relevant.carrierErrors = metrics.counters['carrier_errors_total'];
        }

        return relevant;
    }

    async sendNotifications(alert) {
        const promises = [];

        // Slack
        if (config.alerting.channels.slack) {
            promises.push(this.sendSlackAlert(alert));
        }

        // PagerDuty
        if (config.alerting.channels.pagerduty && alert.severity === 'critical') {
            promises.push(this.sendPagerDutyAlert(alert));
        }

        // Email
        if (config.alerting.channels.email) {
            promises.push(this.sendEmailAlert(alert));
        }

        await Promise.allSettled(promises);
    }

    async sendSlackAlert(alert) {
        const color = alert.resolved ? 'good' : alert.severity === 'critical' ? 'danger' : 'warning';
        const emoji = alert.resolved ? '✅' : alert.severity === 'critical' ? '🚨' : '⚠️';

        await fetch(config.alerting.channels.slack, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                attachments: [{
                    color,
                    title: `${emoji} ${alert.resolved ? 'RESOLVED: ' : ''}${alert.message}`,
                    fields: [
                        { title: 'Severity', value: alert.severity, short: true },
                        { title: 'Rule', value: alert.name, short: true },
                        { title: 'Time', value: alert.triggeredAt.toISOString(), short: true }
                    ],
                    footer: 'Routz Alerting',
                    ts: Math.floor(Date.now() / 1000)
                }]
            })
        });
    }

    async sendPagerDutyAlert(alert) {
        await fetch('https://events.pagerduty.com/v2/enqueue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routing_key: config.alerting.channels.pagerduty,
                event_action: alert.resolved ? 'resolve' : 'trigger',
                dedup_key: alert.name,
                payload: {
                    summary: alert.message,
                    severity: alert.severity === 'critical' ? 'critical' : 'warning',
                    source: 'routz-api',
                    timestamp: alert.triggeredAt.toISOString()
                }
            })
        });
    }

    async sendEmailAlert(alert) {
        // Would integrate with email service
        logger.info('Email alert would be sent', { to: config.alerting.channels.email, alert: alert.name });
    }

    // Manual alert acknowledgment
    async acknowledgeAlert(alertName, userId) {
        const alert = this.alerts.get(alertName);
        if (!alert) return null;

        alert.acknowledgedAt = new Date();
        alert.acknowledgedBy = userId;

        await pool.query(`
            UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 
            WHERE name = $2 AND resolved_at IS NULL
        `, [userId, alertName]);

        return alert;
    }

    // Get active alerts
    getActiveAlerts() {
        return Array.from(this.alerts.values());
    }

    // Start periodic checking
    startChecking(interval = 60000) {
        setInterval(() => this.checkRules(), interval);
        logger.info('Alert checking started', { interval });
    }
}

const alertingService = new AlertingService();

// ============================================
// ERROR TRACKING
// ============================================

class ErrorTracker {
    constructor() {
        this.errors = [];
        this.maxErrors = 1000;
    }

    capture(error, context = {}) {
        const errorRecord = {
            id: require('crypto').randomUUID(),
            timestamp: new Date(),
            name: error.name,
            message: error.message,
            stack: error.stack,
            context,
            fingerprint: this.generateFingerprint(error)
        };

        // Log error
        logger.error('Error captured', errorRecord);

        // Store error
        this.errors.unshift(errorRecord);
        if (this.errors.length > this.maxErrors) {
            this.errors = this.errors.slice(0, this.maxErrors);
        }

        // Track metric
        metricsCollector.increment('errors_total', 1, { 
            name: error.name, 
            fingerprint: errorRecord.fingerprint 
        });

        // Store in Redis for quick access
        redis.lpush('errors:recent', JSON.stringify(errorRecord));
        redis.ltrim('errors:recent', 0, 999);

        return errorRecord;
    }

    generateFingerprint(error) {
        const stackLines = (error.stack || '').split('\n').slice(0, 5);
        const content = error.name + error.message + stackLines.join('');
        return require('crypto').createHash('md5').update(content).digest('hex').substring(0, 12);
    }

    async getRecentErrors(limit = 100) {
        const errors = await redis.lrange('errors:recent', 0, limit - 1);
        return errors.map(e => JSON.parse(e));
    }

    // Express error handler middleware
    errorHandler() {
        return (err, req, res, next) => {
            const errorRecord = this.capture(err, {
                requestId: req.requestId,
                method: req.method,
                url: req.originalUrl,
                userId: req.user?.id,
                orgId: req.user?.orgId
            });

            res.status(err.status || 500).json({
                error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
                errorId: errorRecord.id
            });
        };
    }
}

const errorTracker = new ErrorTracker();

// ============================================
// AUDIT LOGGER
// ============================================

const auditLog = async (event) => {
    const logEntry = {
        id: require('crypto').randomUUID(),
        timestamp: new Date(),
        ...event
    };

    logger.info('Audit event', logEntry);

    await pool.query(`
        INSERT INTO audit_logs (id, event_type, user_id, organization_id, resource_type, resource_id, action, status, ip_address, user_agent, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
        logEntry.id,
        event.eventType,
        event.userId,
        event.orgId,
        event.resourceType,
        event.resourceId,
        event.action,
        event.status,
        event.ip,
        event.userAgent,
        JSON.stringify(event.metadata || {})
    ]);

    return logEntry;
};

// ============================================
// PROMETHEUS EXPORTER
// ============================================

const prometheusExporter = () => {
    return async (req, res) => {
        const metrics = await metricsCollector.getMetrics('1h');
        let output = '';

        // Format counters
        for (const [name, data] of Object.entries(metrics.counters)) {
            const total = Object.values(data).reduce((a, b) => a + b, 0);
            output += `# TYPE ${config.metrics.prefix}_${name.replace(/[{}:,]/g, '_')} counter\n`;
            output += `${config.metrics.prefix}_${name.replace(/[{}:,]/g, '_')} ${total}\n`;
        }

        // Format gauges
        for (const [name, data] of Object.entries(metrics.gauges)) {
            const latest = Object.entries(data).sort(([a], [b]) => b - a)[0]?.[1] || 0;
            output += `# TYPE ${config.metrics.prefix}_${name.replace(/[{}:,]/g, '_')} gauge\n`;
            output += `${config.metrics.prefix}_${name.replace(/[{}:,]/g, '_')} ${latest}\n`;
        }

        // Format histograms
        for (const [name, data] of Object.entries(metrics.histograms)) {
            const latest = Object.entries(data).sort(([a], [b]) => b - a)[0]?.[1];
            if (latest) {
                const baseName = `${config.metrics.prefix}_${name.replace(/[{}:,]/g, '_')}`;
                output += `# TYPE ${baseName} histogram\n`;
                output += `${baseName}_count ${latest.count}\n`;
                output += `${baseName}{quantile="0.5"} ${latest.p50}\n`;
                output += `${baseName}{quantile="0.9"} ${latest.p90}\n`;
                output += `${baseName}{quantile="0.99"} ${latest.p99}\n`;
            }
        }

        res.set('Content-Type', 'text/plain');
        res.send(output);
    };
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Logger
    logger,
    requestLogger,
    createChildLogger,
    carrierLogger,
    workerLogger,
    apiLogger,
    authLogger,
    billingLogger,

    // Metrics
    metricsCollector,
    MetricsCollector,

    // Health
    healthChecker,
    HealthChecker,

    // Alerting
    alertingService,
    AlertingService,

    // Error tracking
    errorTracker,
    ErrorTracker,

    // Audit
    auditLog,

    // Prometheus
    prometheusExporter,

    // Config
    config
};
