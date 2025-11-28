/**
 * ROUTZ - Redis Caching Layer
 * Multi-level caching with invalidation patterns
 */

const Redis = require('ioredis');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_CACHE_DB) || 1,
        keyPrefix: 'cache:',
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableReadyCheck: true,
        lazyConnect: false
    },
    defaults: {
        ttl: 3600, // 1 hour default
        staleWhileRevalidate: 60, // Serve stale for 60s while revalidating
        lockTimeout: 10000, // 10s lock for cache stampede prevention
        compression: true,
        compressionThreshold: 1024 // Compress if > 1KB
    },
    namespaces: {
        user: { ttl: 300, prefix: 'user' },
        organization: { ttl: 600, prefix: 'org' },
        shipment: { ttl: 60, prefix: 'shp' },
        tracking: { ttl: 300, prefix: 'trk' },
        rates: { ttl: 3600, prefix: 'rates' },
        pickupPoints: { ttl: 86400, prefix: 'pickup' },
        settings: { ttl: 1800, prefix: 'set' },
        session: { ttl: 604800, prefix: 'sess' }, // 7 days
        permissions: { ttl: 300, prefix: 'perm' },
        apiResponse: { ttl: 60, prefix: 'api' }
    }
};

// ============================================
// REDIS CONNECTIONS
// ============================================

// Main cache connection
const redis = new Redis({
    ...config.redis,
    enableOfflineQueue: true
});

// Subscriber for cache invalidation
const subscriber = new Redis({
    ...config.redis,
    enableOfflineQueue: false
});

// Publisher for cache invalidation
const publisher = new Redis({
    ...config.redis,
    enableOfflineQueue: true
});

// Connection events
redis.on('error', (err) => console.error('[Cache] Redis error:', err.message));
redis.on('connect', () => console.log('[Cache] Redis connected'));
redis.on('ready', () => console.log('[Cache] Redis ready'));

// ============================================
// COMPRESSION UTILS
// ============================================

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

async function compress(data) {
    const json = JSON.stringify(data);
    if (json.length < config.defaults.compressionThreshold) {
        return { compressed: false, data: json };
    }
    const compressed = await gzip(json);
    return { compressed: true, data: compressed.toString('base64') };
}

async function decompress(cached) {
    if (!cached) return null;
    
    try {
        const parsed = JSON.parse(cached);
        if (parsed._compressed) {
            const buffer = Buffer.from(parsed.data, 'base64');
            const decompressed = await gunzip(buffer);
            return JSON.parse(decompressed.toString());
        }
        return parsed._compressed === false ? JSON.parse(parsed.data) : parsed;
    } catch (e) {
        // Fallback for non-wrapped data
        return JSON.parse(cached);
    }
}

// ============================================
// CACHE KEY BUILDER
// ============================================

class CacheKeyBuilder {
    static build(namespace, ...parts) {
        const ns = config.namespaces[namespace] || { prefix: namespace };
        const key = [ns.prefix, ...parts].filter(Boolean).join(':');
        return key;
    }

    static buildPattern(namespace, ...parts) {
        const ns = config.namespaces[namespace] || { prefix: namespace };
        return [ns.prefix, ...parts, '*'].filter(Boolean).join(':');
    }

    static hash(obj) {
        return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex').substring(0, 12);
    }

    static buildFromRequest(req) {
        const parts = [
            req.method,
            req.path,
            this.hash(req.query || {}),
            req.user?.orgId || 'anon'
        ];
        return this.build('apiResponse', ...parts);
    }
}

// ============================================
// CACHE METRICS
// ============================================

class CacheMetrics extends EventEmitter {
    constructor() {
        super();
        this.stats = {
            hits: 0,
            misses: 0,
            stale: 0,
            errors: 0,
            invalidations: 0,
            writes: 0,
            deletes: 0
        };
        this.namespaceStats = {};
    }

    hit(namespace) {
        this.stats.hits++;
        this.trackNamespace(namespace, 'hits');
        this.emit('hit', { namespace });
    }

    miss(namespace) {
        this.stats.misses++;
        this.trackNamespace(namespace, 'misses');
        this.emit('miss', { namespace });
    }

    stale(namespace) {
        this.stats.stale++;
        this.trackNamespace(namespace, 'stale');
        this.emit('stale', { namespace });
    }

    error(namespace, error) {
        this.stats.errors++;
        this.trackNamespace(namespace, 'errors');
        this.emit('error', { namespace, error });
    }

    invalidation(namespace, pattern) {
        this.stats.invalidations++;
        this.trackNamespace(namespace, 'invalidations');
        this.emit('invalidation', { namespace, pattern });
    }

    write(namespace) {
        this.stats.writes++;
        this.trackNamespace(namespace, 'writes');
    }

    delete(namespace) {
        this.stats.deletes++;
        this.trackNamespace(namespace, 'deletes');
    }

    trackNamespace(namespace, metric) {
        if (!this.namespaceStats[namespace]) {
            this.namespaceStats[namespace] = { hits: 0, misses: 0, stale: 0, errors: 0, invalidations: 0, writes: 0, deletes: 0 };
        }
        this.namespaceStats[namespace][metric]++;
    }

    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
            : 0;

        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            byNamespace: this.namespaceStats
        };
    }

    reset() {
        this.stats = { hits: 0, misses: 0, stale: 0, errors: 0, invalidations: 0, writes: 0, deletes: 0 };
        this.namespaceStats = {};
    }
}

const metrics = new CacheMetrics();

// ============================================
// CACHE STAMPEDE PREVENTION (Locks)
// ============================================

class CacheLock {
    constructor(redis, timeout = config.defaults.lockTimeout) {
        this.redis = redis;
        this.timeout = timeout;
    }

    async acquire(key) {
        const lockKey = `lock:${key}`;
        const lockValue = `${process.pid}:${Date.now()}`;
        
        const acquired = await this.redis.set(lockKey, lockValue, 'PX', this.timeout, 'NX');
        
        if (acquired) {
            return {
                key: lockKey,
                value: lockValue,
                release: () => this.release(lockKey, lockValue)
            };
        }
        
        return null;
    }

    async release(lockKey, lockValue) {
        // Only release if we own the lock
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        await this.redis.eval(script, 1, lockKey, lockValue);
    }

    async waitForLock(key, maxWait = 5000) {
        const lockKey = `lock:${key}`;
        const start = Date.now();
        
        while (Date.now() - start < maxWait) {
            const exists = await this.redis.exists(lockKey);
            if (!exists) return true;
            await new Promise(r => setTimeout(r, 50));
        }
        
        return false;
    }
}

const cacheLock = new CacheLock(redis);

// ============================================
// MAIN CACHE SERVICE
// ============================================

class CacheService {
    constructor() {
        this.redis = redis;
        this.metrics = metrics;
        this.lock = cacheLock;
    }

    // ----------------------------------------
    // BASIC OPERATIONS
    // ----------------------------------------

    async get(namespace, key, options = {}) {
        const fullKey = CacheKeyBuilder.build(namespace, key);
        
        try {
            const cached = await this.redis.get(fullKey);
            
            if (cached) {
                metrics.hit(namespace);
                const data = await decompress(cached);
                
                // Check if stale (if metadata exists)
                if (data._meta && data._meta.staleAt && Date.now() > data._meta.staleAt) {
                    metrics.stale(namespace);
                    
                    // Trigger background revalidation if callback provided
                    if (options.revalidate) {
                        this.revalidateInBackground(namespace, key, options.revalidate);
                    }
                    
                    return data.value;
                }
                
                return data._meta ? data.value : data;
            }
            
            metrics.miss(namespace);
            return null;
        } catch (error) {
            metrics.error(namespace, error);
            console.error(`[Cache] Get error for ${fullKey}:`, error.message);
            return null;
        }
    }

    async set(namespace, key, value, options = {}) {
        const fullKey = CacheKeyBuilder.build(namespace, key);
        const nsConfig = config.namespaces[namespace] || {};
        const ttl = options.ttl || nsConfig.ttl || config.defaults.ttl;
        const staleTime = options.staleTime || config.defaults.staleWhileRevalidate;
        
        try {
            const wrapper = {
                value,
                _meta: {
                    createdAt: Date.now(),
                    staleAt: Date.now() + (ttl - staleTime) * 1000,
                    expiresAt: Date.now() + ttl * 1000
                }
            };
            
            const { compressed, data } = await compress(wrapper);
            const toStore = JSON.stringify({ _compressed: compressed, data });
            
            await this.redis.setex(fullKey, ttl, toStore);
            metrics.write(namespace);
            
            // Store tags for invalidation
            if (options.tags && options.tags.length > 0) {
                await this.addTags(fullKey, options.tags);
            }
            
            return true;
        } catch (error) {
            metrics.error(namespace, error);
            console.error(`[Cache] Set error for ${fullKey}:`, error.message);
            return false;
        }
    }

    async getOrSet(namespace, key, factory, options = {}) {
        // Try to get from cache
        const cached = await this.get(namespace, key, options);
        if (cached !== null) {
            return cached;
        }
        
        const fullKey = CacheKeyBuilder.build(namespace, key);
        
        // Try to acquire lock to prevent stampede
        const lock = await this.lock.acquire(fullKey);
        
        if (!lock) {
            // Another process is generating the value, wait for it
            const waited = await this.lock.waitForLock(fullKey);
            if (waited) {
                const retried = await this.get(namespace, key);
                if (retried !== null) return retried;
            }
        }
        
        try {
            // Double-check cache after acquiring lock
            const doubleCheck = await this.get(namespace, key);
            if (doubleCheck !== null) {
                return doubleCheck;
            }
            
            // Generate value
            const value = await factory();
            
            // Store in cache
            await this.set(namespace, key, value, options);
            
            return value;
        } finally {
            if (lock) {
                await lock.release();
            }
        }
    }

    async delete(namespace, key) {
        const fullKey = CacheKeyBuilder.build(namespace, key);
        
        try {
            await this.redis.del(fullKey);
            metrics.delete(namespace);
            return true;
        } catch (error) {
            metrics.error(namespace, error);
            return false;
        }
    }

    async exists(namespace, key) {
        const fullKey = CacheKeyBuilder.build(namespace, key);
        return await this.redis.exists(fullKey) === 1;
    }

    // ----------------------------------------
    // PATTERN-BASED INVALIDATION
    // ----------------------------------------

    async invalidatePattern(namespace, pattern) {
        const fullPattern = CacheKeyBuilder.buildPattern(namespace, pattern);
        
        try {
            let cursor = '0';
            let deletedCount = 0;
            
            do {
                const [nextCursor, keys] = await this.redis.scan(
                    cursor,
                    'MATCH',
                    config.redis.keyPrefix + fullPattern,
                    'COUNT',
                    100
                );
                
                cursor = nextCursor;
                
                if (keys.length > 0) {
                    // Remove prefix before deleting
                    const keysWithoutPrefix = keys.map(k => k.replace(config.redis.keyPrefix, ''));
                    await this.redis.del(...keysWithoutPrefix);
                    deletedCount += keys.length;
                }
            } while (cursor !== '0');
            
            metrics.invalidation(namespace, pattern);
            
            // Publish invalidation event for distributed cache
            await publisher.publish('cache:invalidate', JSON.stringify({
                namespace,
                pattern,
                timestamp: Date.now()
            }));
            
            return deletedCount;
        } catch (error) {
            metrics.error(namespace, error);
            console.error(`[Cache] Invalidation error for ${fullPattern}:`, error.message);
            return 0;
        }
    }

    // ----------------------------------------
    // TAG-BASED INVALIDATION
    // ----------------------------------------

    async addTags(key, tags) {
        const pipeline = this.redis.pipeline();
        
        for (const tag of tags) {
            pipeline.sadd(`tag:${tag}`, key);
            pipeline.expire(`tag:${tag}`, 86400 * 7); // Tags expire after 7 days
        }
        
        await pipeline.exec();
    }

    async invalidateByTag(tag) {
        try {
            const keys = await this.redis.smembers(`tag:${tag}`);
            
            if (keys.length > 0) {
                await this.redis.del(...keys);
                await this.redis.del(`tag:${tag}`);
            }
            
            metrics.invalidation('tags', tag);
            
            return keys.length;
        } catch (error) {
            metrics.error('tags', error);
            return 0;
        }
    }

    async invalidateByTags(tags) {
        let totalDeleted = 0;
        
        for (const tag of tags) {
            totalDeleted += await this.invalidateByTag(tag);
        }
        
        return totalDeleted;
    }

    // ----------------------------------------
    // ENTITY-SPECIFIC CACHING
    // ----------------------------------------

    // User cache
    async getUser(userId) {
        return this.get('user', userId);
    }

    async setUser(userId, userData, ttl) {
        return this.set('user', userId, userData, { ttl, tags: [`user:${userId}`] });
    }

    async invalidateUser(userId) {
        await this.delete('user', userId);
        await this.invalidateByTag(`user:${userId}`);
    }

    // Organization cache
    async getOrganization(orgId) {
        return this.get('organization', orgId);
    }

    async setOrganization(orgId, orgData, ttl) {
        return this.set('organization', orgId, orgData, { ttl, tags: [`org:${orgId}`] });
    }

    async invalidateOrganization(orgId) {
        await this.delete('organization', orgId);
        await this.invalidatePattern('organization', orgId);
        await this.invalidateByTag(`org:${orgId}`);
    }

    // Shipment cache
    async getShipment(shipmentId) {
        return this.get('shipment', shipmentId);
    }

    async setShipment(shipmentId, shipmentData, options = {}) {
        const tags = [`shipment:${shipmentId}`];
        if (shipmentData.organizationId) tags.push(`org:${shipmentData.organizationId}:shipments`);
        if (shipmentData.trackingNumber) tags.push(`tracking:${shipmentData.trackingNumber}`);
        
        return this.set('shipment', shipmentId, shipmentData, { ...options, tags });
    }

    async invalidateShipment(shipmentId) {
        await this.delete('shipment', shipmentId);
        await this.invalidateByTag(`shipment:${shipmentId}`);
    }

    // Tracking cache
    async getTracking(trackingNumber) {
        return this.get('tracking', trackingNumber);
    }

    async setTracking(trackingNumber, trackingData, ttl = 300) {
        return this.set('tracking', trackingNumber, trackingData, { ttl });
    }

    // Rates cache (longer TTL)
    async getRates(origin, destination, weight, carrier) {
        const key = CacheKeyBuilder.hash({ origin, destination, weight, carrier });
        return this.get('rates', key);
    }

    async setRates(origin, destination, weight, carrier, rates) {
        const key = CacheKeyBuilder.hash({ origin, destination, weight, carrier });
        return this.set('rates', key, rates, { ttl: 3600 });
    }

    // Pickup points cache (very long TTL)
    async getPickupPoints(postalCode, carrier) {
        const key = `${carrier}:${postalCode}`;
        return this.get('pickupPoints', key);
    }

    async setPickupPoints(postalCode, carrier, points) {
        const key = `${carrier}:${postalCode}`;
        return this.set('pickupPoints', key, points, { ttl: 86400 }); // 24 hours
    }

    // Settings cache
    async getSettings(orgId, key) {
        return this.get('settings', `${orgId}:${key}`);
    }

    async setSettings(orgId, key, value) {
        return this.set('settings', `${orgId}:${key}`, value, { tags: [`org:${orgId}:settings`] });
    }

    async invalidateSettings(orgId) {
        await this.invalidateByTag(`org:${orgId}:settings`);
    }

    // Permissions cache
    async getPermissions(userId) {
        return this.get('permissions', userId);
    }

    async setPermissions(userId, permissions) {
        return this.set('permissions', userId, permissions, { tags: [`user:${userId}`] });
    }

    // ----------------------------------------
    // BACKGROUND REVALIDATION
    // ----------------------------------------

    async revalidateInBackground(namespace, key, factory) {
        const fullKey = CacheKeyBuilder.build(namespace, key);
        
        // Don't await - run in background
        setImmediate(async () => {
            const lock = await this.lock.acquire(`revalidate:${fullKey}`);
            if (!lock) return; // Another process is already revalidating
            
            try {
                const value = await factory();
                await this.set(namespace, key, value);
                console.log(`[Cache] Revalidated ${fullKey}`);
            } catch (error) {
                console.error(`[Cache] Revalidation failed for ${fullKey}:`, error.message);
            } finally {
                await lock.release();
            }
        });
    }

    // ----------------------------------------
    // MULTI-KEY OPERATIONS
    // ----------------------------------------

    async mget(namespace, keys) {
        if (keys.length === 0) return [];
        
        const fullKeys = keys.map(k => CacheKeyBuilder.build(namespace, k));
        const values = await this.redis.mget(...fullKeys);
        
        const results = await Promise.all(values.map(async (v, i) => {
            if (v) {
                metrics.hit(namespace);
                return { key: keys[i], value: await decompress(v) };
            }
            metrics.miss(namespace);
            return { key: keys[i], value: null };
        }));
        
        return results;
    }

    async mset(namespace, items, options = {}) {
        const pipeline = this.redis.pipeline();
        const ttl = options.ttl || config.namespaces[namespace]?.ttl || config.defaults.ttl;
        
        for (const { key, value } of items) {
            const fullKey = CacheKeyBuilder.build(namespace, key);
            const { compressed, data } = await compress({ value, _meta: { createdAt: Date.now() } });
            const toStore = JSON.stringify({ _compressed: compressed, data });
            pipeline.setex(fullKey, ttl, toStore);
        }
        
        await pipeline.exec();
        metrics.write(namespace);
    }

    // ----------------------------------------
    // CACHE WARMING
    // ----------------------------------------

    async warmCache(namespace, keys, factory) {
        const existing = await this.mget(namespace, keys);
        const missing = existing.filter(r => r.value === null).map(r => r.key);
        
        if (missing.length === 0) {
            console.log(`[Cache] Warm: ${namespace} - all ${keys.length} keys already cached`);
            return;
        }
        
        console.log(`[Cache] Warming ${missing.length} missing keys for ${namespace}`);
        
        const limit = require('p-limit')(10);
        const tasks = missing.map(key => limit(async () => {
            try {
                const value = await factory(key);
                await this.set(namespace, key, value);
            } catch (error) {
                console.error(`[Cache] Warm error for ${key}:`, error.message);
            }
        }));
        
        await Promise.all(tasks);
        console.log(`[Cache] Warmed ${missing.length} keys for ${namespace}`);
    }

    // ----------------------------------------
    // UTILITIES
    // ----------------------------------------

    async flush(namespace) {
        if (namespace) {
            return this.invalidatePattern(namespace, '');
        }
        
        // Flush all (dangerous!)
        await this.redis.flushdb();
        console.log('[Cache] Flushed entire cache database');
    }

    async getStats() {
        const info = await this.redis.info('memory');
        const dbSize = await this.redis.dbsize();
        
        return {
            ...metrics.getStats(),
            redis: {
                dbSize,
                memoryUsed: info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown'
            }
        };
    }

    async healthCheck() {
        try {
            const start = Date.now();
            await this.redis.ping();
            const latency = Date.now() - start;
            
            return {
                status: 'healthy',
                latency: `${latency}ms`,
                stats: await this.getStats()
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }
}

// ============================================
// DISTRIBUTED CACHE INVALIDATION
// ============================================

subscriber.subscribe('cache:invalidate', (err) => {
    if (err) console.error('[Cache] Subscribe error:', err.message);
});

subscriber.on('message', async (channel, message) => {
    if (channel === 'cache:invalidate') {
        try {
            const { namespace, pattern, timestamp } = JSON.parse(message);
            console.log(`[Cache] Received invalidation: ${namespace}:${pattern}`);
            
            // Only process if not from this process
            // (to avoid double invalidation)
        } catch (error) {
            console.error('[Cache] Invalidation message error:', error.message);
        }
    }
});

// ============================================
// EXPRESS MIDDLEWARE
// ============================================

const cacheMiddleware = (options = {}) => {
    const cache = new CacheService();
    const {
        ttl = 60,
        keyGenerator = (req) => CacheKeyBuilder.buildFromRequest(req),
        condition = (req) => req.method === 'GET',
        bypass = (req) => req.headers['cache-control'] === 'no-cache'
    } = options;

    return async (req, res, next) => {
        if (!condition(req) || bypass(req)) {
            return next();
        }

        const key = keyGenerator(req);

        try {
            const cached = await cache.get('apiResponse', key);
            
            if (cached) {
                res.set('X-Cache', 'HIT');
                res.set('X-Cache-Key', key);
                return res.json(cached);
            }

            // Store original json method
            const originalJson = res.json.bind(res);
            
            res.json = async (data) => {
                // Only cache successful responses
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    await cache.set('apiResponse', key, data, { ttl });
                    res.set('X-Cache', 'MISS');
                }
                return originalJson(data);
            };

            next();
        } catch (error) {
            console.error('[Cache] Middleware error:', error.message);
            next();
        }
    };
};

// ============================================
// CACHE INVALIDATION DECORATORS
// ============================================

const invalidateOnWrite = (namespace, keyExtractor) => {
    return (target, propertyKey, descriptor) => {
        const originalMethod = descriptor.value;
        const cache = new CacheService();

        descriptor.value = async function (...args) {
            const result = await originalMethod.apply(this, args);
            
            const key = typeof keyExtractor === 'function' 
                ? keyExtractor(args, result) 
                : keyExtractor;
            
            await cache.delete(namespace, key);
            
            return result;
        };

        return descriptor;
    };
};

// ============================================
// SINGLETON INSTANCE
// ============================================

const cacheService = new CacheService();

// ============================================
// EXPORTS
// ============================================

module.exports = {
    CacheService,
    cacheService,
    CacheKeyBuilder,
    CacheMetrics,
    CacheLock,
    cacheMiddleware,
    invalidateOnWrite,
    metrics,
    redis,
    config
};
