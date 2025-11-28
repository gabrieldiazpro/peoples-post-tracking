/**
 * ROUTZ - Authentication & Authorization System
 * OAuth2, JWT, SSO, RBAC, MFA
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { Redis } = require('ioredis');
const { Pool } = require('pg');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET || 'routz-access-secret-change-in-production',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'routz-refresh-secret-change-in-production',
        accessExpiresIn: '15m',
        refreshExpiresIn: '7d',
        issuer: 'routz.io',
        audience: 'routz-api'
    },
    bcrypt: {
        saltRounds: 12
    },
    oauth: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://app.routz.io/auth/google/callback'
        },
        microsoft: {
            clientId: process.env.MICROSOFT_CLIENT_ID,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
            redirectUri: process.env.MICROSOFT_REDIRECT_URI || 'https://app.routz.io/auth/microsoft/callback',
            tenantId: process.env.MICROSOFT_TENANT_ID || 'common'
        }
    },
    session: {
        maxActiveSessions: 5,
        inactivityTimeout: 30 * 60 * 1000 // 30 minutes
    },
    rateLimit: {
        login: { maxAttempts: 5, windowMs: 15 * 60 * 1000 }, // 5 attempts per 15 min
        passwordReset: { maxAttempts: 3, windowMs: 60 * 60 * 1000 } // 3 per hour
    }
};

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100
});

// ============================================
// RBAC - ROLES & PERMISSIONS
// ============================================

const PERMISSIONS = {
    // Shipments
    'shipments:read': 'View shipments',
    'shipments:create': 'Create shipments',
    'shipments:update': 'Update shipments',
    'shipments:delete': 'Cancel/delete shipments',
    'shipments:bulk': 'Bulk operations on shipments',
    'shipments:export': 'Export shipments data',
    
    // Orders
    'orders:read': 'View orders',
    'orders:create': 'Create orders',
    'orders:update': 'Update orders',
    'orders:delete': 'Delete orders',
    'orders:import': 'Import orders',
    'orders:export': 'Export orders',
    
    // Returns
    'returns:read': 'View returns',
    'returns:create': 'Create returns',
    'returns:process': 'Process returns',
    'returns:approve': 'Approve/reject returns',
    
    // Carriers
    'carriers:read': 'View carrier settings',
    'carriers:manage': 'Manage carrier connections',
    'carriers:rates': 'View/configure rates',
    
    // Warehouses
    'warehouses:read': 'View warehouses',
    'warehouses:manage': 'Manage warehouses',
    'inventory:read': 'View inventory',
    'inventory:manage': 'Manage inventory',
    
    // Reports & Analytics
    'reports:view': 'View reports',
    'reports:export': 'Export reports',
    'analytics:view': 'View analytics dashboard',
    
    // Billing
    'billing:view': 'View billing info',
    'billing:manage': 'Manage billing & subscriptions',
    
    // Organization
    'org:read': 'View organization settings',
    'org:manage': 'Manage organization',
    'users:read': 'View users',
    'users:invite': 'Invite users',
    'users:manage': 'Manage users',
    'roles:manage': 'Manage roles & permissions',
    
    // API
    'api:keys:read': 'View API keys',
    'api:keys:manage': 'Manage API keys',
    'webhooks:read': 'View webhooks',
    'webhooks:manage': 'Manage webhooks',
    
    // Admin
    'admin:access': 'Access admin panel',
    'admin:impersonate': 'Impersonate users',
    'admin:audit': 'View audit logs'
};

const ROLES = {
    owner: {
        name: 'Owner',
        description: 'Full access to everything',
        permissions: Object.keys(PERMISSIONS),
        isSystem: true
    },
    admin: {
        name: 'Admin',
        description: 'Administrative access',
        permissions: Object.keys(PERMISSIONS).filter(p => !p.startsWith('admin:')),
        isSystem: true
    },
    manager: {
        name: 'Manager',
        description: 'Manage shipments, orders, and team',
        permissions: [
            'shipments:read', 'shipments:create', 'shipments:update', 'shipments:bulk', 'shipments:export',
            'orders:read', 'orders:create', 'orders:update', 'orders:import', 'orders:export',
            'returns:read', 'returns:create', 'returns:process', 'returns:approve',
            'carriers:read', 'carriers:rates',
            'warehouses:read', 'inventory:read',
            'reports:view', 'reports:export', 'analytics:view',
            'billing:view',
            'org:read', 'users:read', 'users:invite'
        ],
        isSystem: true
    },
    operator: {
        name: 'Operator',
        description: 'Day-to-day shipping operations',
        permissions: [
            'shipments:read', 'shipments:create', 'shipments:update',
            'orders:read', 'orders:update',
            'returns:read', 'returns:create',
            'carriers:read',
            'warehouses:read', 'inventory:read',
            'reports:view'
        ],
        isSystem: true
    },
    viewer: {
        name: 'Viewer',
        description: 'Read-only access',
        permissions: [
            'shipments:read', 'orders:read', 'returns:read',
            'carriers:read', 'warehouses:read', 'inventory:read',
            'reports:view', 'analytics:view'
        ],
        isSystem: true
    },
    api_only: {
        name: 'API Only',
        description: 'API access for integrations',
        permissions: [
            'shipments:read', 'shipments:create', 'shipments:update',
            'orders:read', 'orders:create',
            'carriers:read', 'carriers:rates',
            'webhooks:read'
        ],
        isSystem: true
    }
};

// ============================================
// PASSWORD UTILITIES
// ============================================

class PasswordService {
    static async hash(password) {
        return bcrypt.hash(password, config.bcrypt.saltRounds);
    }

    static async verify(password, hash) {
        return bcrypt.compare(password, hash);
    }

    static validate(password) {
        const errors = [];
        
        if (password.length < 8) {
            errors.push('Password must be at least 8 characters long');
        }
        if (password.length > 128) {
            errors.push('Password must be less than 128 characters');
        }
        if (!/[a-z]/.test(password)) {
            errors.push('Password must contain at least one lowercase letter');
        }
        if (!/[A-Z]/.test(password)) {
            errors.push('Password must contain at least one uppercase letter');
        }
        if (!/[0-9]/.test(password)) {
            errors.push('Password must contain at least one number');
        }
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
            errors.push('Password must contain at least one special character');
        }

        // Check for common passwords
        const commonPasswords = ['password', '123456', 'qwerty', 'admin', 'letmein'];
        if (commonPasswords.some(common => password.toLowerCase().includes(common))) {
            errors.push('Password is too common');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    static generateSecurePassword(length = 16) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        const randomBytes = crypto.randomBytes(length);
        for (let i = 0; i < length; i++) {
            password += chars[randomBytes[i] % chars.length];
        }
        return password;
    }

    static async checkBreached(password) {
        // Check against Have I Been Pwned API
        const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
        const prefix = sha1.substring(0, 5);
        const suffix = sha1.substring(5);

        try {
            const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
                headers: { 'Add-Padding': 'true' }
            });
            const text = await response.text();
            const breached = text.split('\n').some(line => {
                const [hash, count] = line.split(':');
                return hash === suffix && parseInt(count) > 0;
            });
            return { breached, count: breached ? parseInt(text.split('\n').find(l => l.startsWith(suffix))?.split(':')[1] || 0) : 0 };
        } catch (error) {
            console.error('Error checking breached passwords:', error);
            return { breached: false, count: 0, error: true };
        }
    }
}

// ============================================
// TOKEN SERVICE
// ============================================

class TokenService {
    static generateAccessToken(user, organization) {
        const payload = {
            sub: user.id,
            email: user.email,
            org_id: organization.id,
            org_slug: organization.slug,
            role: user.role,
            permissions: this.getPermissions(user.role, user.customPermissions),
            type: 'access'
        };

        return jwt.sign(payload, config.jwt.accessSecret, {
            expiresIn: config.jwt.accessExpiresIn,
            issuer: config.jwt.issuer,
            audience: config.jwt.audience,
            jwtid: crypto.randomUUID()
        });
    }

    static generateRefreshToken(user, sessionId) {
        const payload = {
            sub: user.id,
            session_id: sessionId,
            type: 'refresh'
        };

        return jwt.sign(payload, config.jwt.refreshSecret, {
            expiresIn: config.jwt.refreshExpiresIn,
            issuer: config.jwt.issuer,
            audience: config.jwt.audience,
            jwtid: crypto.randomUUID()
        });
    }

    static verifyAccessToken(token) {
        try {
            return jwt.verify(token, config.jwt.accessSecret, {
                issuer: config.jwt.issuer,
                audience: config.jwt.audience
            });
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                throw new AuthError('Token expired', 'TOKEN_EXPIRED');
            }
            throw new AuthError('Invalid token', 'INVALID_TOKEN');
        }
    }

    static verifyRefreshToken(token) {
        try {
            return jwt.verify(token, config.jwt.refreshSecret, {
                issuer: config.jwt.issuer,
                audience: config.jwt.audience
            });
        } catch (error) {
            throw new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
        }
    }

    static getPermissions(role, customPermissions = []) {
        const rolePerms = ROLES[role]?.permissions || [];
        const allPerms = new Set([...rolePerms, ...customPermissions]);
        return Array.from(allPerms);
    }

    static generateApiKey() {
        const prefix = 'rtz';
        const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
        const key = crypto.randomBytes(24).toString('base64url');
        return `${prefix}_${env}_${key}`;
    }

    static hashApiKey(apiKey) {
        return crypto.createHash('sha256').update(apiKey).digest('hex');
    }

    static generateResetToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    static generateVerificationCode() {
        return crypto.randomInt(100000, 999999).toString();
    }
}

// ============================================
// MFA SERVICE
// ============================================

class MFAService {
    static generateSecret(email) {
        const secret = speakeasy.generateSecret({
            name: `Routz (${email})`,
            issuer: 'Routz',
            length: 32
        });

        return {
            secret: secret.base32,
            otpauthUrl: secret.otpauth_url
        };
    }

    static async generateQRCode(otpauthUrl) {
        return QRCode.toDataURL(otpauthUrl);
    }

    static verifyToken(secret, token) {
        return speakeasy.totp.verify({
            secret,
            encoding: 'base32',
            token,
            window: 1 // Allow 1 step tolerance
        });
    }

    static generateBackupCodes(count = 10) {
        const codes = [];
        for (let i = 0; i < count; i++) {
            codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
        }
        return codes;
    }

    static async hashBackupCodes(codes) {
        return Promise.all(codes.map(code => bcrypt.hash(code, 10)));
    }

    static async verifyBackupCode(code, hashedCodes) {
        for (const hashedCode of hashedCodes) {
            if (await bcrypt.compare(code.toUpperCase(), hashedCode)) {
                return true;
            }
        }
        return false;
    }
}

// ============================================
// SESSION SERVICE
// ============================================

class SessionService {
    static async create(userId, metadata = {}) {
        const sessionId = crypto.randomUUID();
        const session = {
            id: sessionId,
            user_id: userId,
            ip_address: metadata.ip,
            user_agent: metadata.userAgent,
            device: this.parseUserAgent(metadata.userAgent),
            location: metadata.location,
            created_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        };

        // Store in Redis with TTL
        await redis.setex(
            `session:${sessionId}`,
            7 * 24 * 60 * 60, // 7 days
            JSON.stringify(session)
        );

        // Add to user's sessions set
        await redis.sadd(`user_sessions:${userId}`, sessionId);

        // Enforce max sessions
        await this.enforceMaxSessions(userId);

        // Store in DB for persistence
        await pool.query(`
            INSERT INTO user_sessions (id, user_id, ip_address, user_agent, device_info, location, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [sessionId, userId, metadata.ip, metadata.userAgent, JSON.stringify(session.device), metadata.location, session.expires_at]);

        return session;
    }

    static async get(sessionId) {
        const cached = await redis.get(`session:${sessionId}`);
        if (cached) {
            return JSON.parse(cached);
        }

        // Fallback to DB
        const result = await pool.query('SELECT * FROM user_sessions WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
        if (result.rows.length > 0) {
            const session = result.rows[0];
            await redis.setex(`session:${sessionId}`, 3600, JSON.stringify(session));
            return session;
        }

        return null;
    }

    static async updateActivity(sessionId) {
        const session = await this.get(sessionId);
        if (session) {
            session.last_active_at = new Date().toISOString();
            await redis.setex(`session:${sessionId}`, 7 * 24 * 60 * 60, JSON.stringify(session));
            await pool.query('UPDATE user_sessions SET last_active_at = NOW() WHERE id = $1', [sessionId]);
        }
    }

    static async revoke(sessionId) {
        const session = await this.get(sessionId);
        if (session) {
            await redis.del(`session:${sessionId}`);
            await redis.srem(`user_sessions:${session.user_id}`, sessionId);
            await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1', [sessionId]);
        }
    }

    static async revokeAllUserSessions(userId, exceptSessionId = null) {
        const sessionIds = await redis.smembers(`user_sessions:${userId}`);
        
        for (const sid of sessionIds) {
            if (sid !== exceptSessionId) {
                await redis.del(`session:${sid}`);
            }
        }

        if (exceptSessionId) {
            await redis.del(`user_sessions:${userId}`);
            await redis.sadd(`user_sessions:${userId}`, exceptSessionId);
            await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id != $2', [userId, exceptSessionId]);
        } else {
            await redis.del(`user_sessions:${userId}`);
            await pool.query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1', [userId]);
        }
    }

    static async getUserSessions(userId) {
        const result = await pool.query(`
            SELECT id, ip_address, user_agent, device_info, location, created_at, last_active_at
            FROM user_sessions 
            WHERE user_id = $1 AND revoked_at IS NULL
            ORDER BY last_active_at DESC
        `, [userId]);
        return result.rows;
    }

    static async enforceMaxSessions(userId) {
        const sessions = await this.getUserSessions(userId);
        if (sessions.length > config.session.maxActiveSessions) {
            // Revoke oldest sessions
            const toRevoke = sessions.slice(config.session.maxActiveSessions);
            for (const session of toRevoke) {
                await this.revoke(session.id);
            }
        }
    }

    static parseUserAgent(userAgent) {
        if (!userAgent) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };

        const browser = userAgent.match(/(Chrome|Firefox|Safari|Edge|Opera|IE)\/?\s*(\d+)/i);
        const os = userAgent.match(/(Windows|Mac|Linux|Android|iOS)/i);
        const device = /Mobile|Tablet/i.test(userAgent) ? 'Mobile' : 'Desktop';

        return {
            browser: browser ? `${browser[1]} ${browser[2]}` : 'Unknown',
            os: os ? os[1] : 'Unknown',
            device
        };
    }
}

// ============================================
// RATE LIMITER
// ============================================

class RateLimiter {
    static async checkLimit(key, options) {
        const { maxAttempts, windowMs } = options;
        const redisKey = `ratelimit:${key}`;
        
        const current = await redis.incr(redisKey);
        
        if (current === 1) {
            await redis.pexpire(redisKey, windowMs);
        }

        const ttl = await redis.pttl(redisKey);

        return {
            allowed: current <= maxAttempts,
            remaining: Math.max(0, maxAttempts - current),
            resetIn: ttl > 0 ? ttl : windowMs,
            total: maxAttempts
        };
    }

    static async resetLimit(key) {
        await redis.del(`ratelimit:${key}`);
    }

    static async getLoginAttempts(identifier) {
        return this.checkLimit(`login:${identifier}`, config.rateLimit.login);
    }

    static async getPasswordResetAttempts(identifier) {
        return this.checkLimit(`password_reset:${identifier}`, config.rateLimit.passwordReset);
    }
}

// ============================================
// OAUTH PROVIDERS
// ============================================

class OAuthService {
    static getGoogleAuthUrl(state) {
        const params = new URLSearchParams({
            client_id: config.oauth.google.clientId,
            redirect_uri: config.oauth.google.redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            access_type: 'offline',
            prompt: 'consent'
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    static async exchangeGoogleCode(code) {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: config.oauth.google.clientId,
                client_secret: config.oauth.google.clientSecret,
                redirect_uri: config.oauth.google.redirectUri,
                grant_type: 'authorization_code'
            })
        });

        if (!response.ok) {
            throw new AuthError('Failed to exchange Google code', 'OAUTH_EXCHANGE_FAILED');
        }

        const tokens = await response.json();
        
        // Get user info
        const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        if (!userResponse.ok) {
            throw new AuthError('Failed to get Google user info', 'OAUTH_USER_INFO_FAILED');
        }

        const user = await userResponse.json();

        return {
            provider: 'google',
            providerId: user.id,
            email: user.email,
            emailVerified: user.verified_email,
            firstName: user.given_name,
            lastName: user.family_name,
            picture: user.picture,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token
        };
    }

    static getMicrosoftAuthUrl(state) {
        const params = new URLSearchParams({
            client_id: config.oauth.microsoft.clientId,
            redirect_uri: config.oauth.microsoft.redirectUri,
            response_type: 'code',
            scope: 'openid email profile User.Read',
            state,
            response_mode: 'query'
        });
        return `https://login.microsoftonline.com/${config.oauth.microsoft.tenantId}/oauth2/v2.0/authorize?${params}`;
    }

    static async exchangeMicrosoftCode(code) {
        const response = await fetch(`https://login.microsoftonline.com/${config.oauth.microsoft.tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: config.oauth.microsoft.clientId,
                client_secret: config.oauth.microsoft.clientSecret,
                redirect_uri: config.oauth.microsoft.redirectUri,
                grant_type: 'authorization_code'
            })
        });

        if (!response.ok) {
            throw new AuthError('Failed to exchange Microsoft code', 'OAUTH_EXCHANGE_FAILED');
        }

        const tokens = await response.json();

        // Get user info
        const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        if (!userResponse.ok) {
            throw new AuthError('Failed to get Microsoft user info', 'OAUTH_USER_INFO_FAILED');
        }

        const user = await userResponse.json();

        return {
            provider: 'microsoft',
            providerId: user.id,
            email: user.mail || user.userPrincipalName,
            emailVerified: true,
            firstName: user.givenName,
            lastName: user.surname,
            picture: null,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token
        };
    }

    static async storeOAuthState(state, data) {
        await redis.setex(`oauth_state:${state}`, 600, JSON.stringify(data)); // 10 min TTL
    }

    static async getOAuthState(state) {
        const data = await redis.get(`oauth_state:${state}`);
        if (data) {
            await redis.del(`oauth_state:${state}`);
            return JSON.parse(data);
        }
        return null;
    }
}

// ============================================
// SAML SSO SERVICE
// ============================================

class SAMLService {
    static generateMetadata(orgSlug) {
        const entityId = `https://app.routz.io/auth/saml/${orgSlug}`;
        const acsUrl = `https://app.routz.io/auth/saml/${orgSlug}/callback`;

        return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
    <md:SPSSODescriptor AuthnRequestsSigned="true" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
        <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0"/>
    </md:SPSSODescriptor>
</md:EntityDescriptor>`;
    }

    static async configureSAML(orgId, config) {
        await pool.query(`
            INSERT INTO organization_sso (organization_id, provider, config, enabled)
            VALUES ($1, 'saml', $2, true)
            ON CONFLICT (organization_id, provider) 
            DO UPDATE SET config = $2, updated_at = NOW()
        `, [orgId, JSON.stringify(config)]);
    }

    static async getSAMLConfig(orgId) {
        const result = await pool.query(
            'SELECT * FROM organization_sso WHERE organization_id = $1 AND provider = $2 AND enabled = true',
            [orgId, 'saml']
        );
        return result.rows[0];
    }
}

// ============================================
// AUDIT LOG
// ============================================

class AuditLog {
    static async log(event) {
        const logEntry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            event_type: event.type,
            user_id: event.userId,
            organization_id: event.orgId,
            ip_address: event.ip,
            user_agent: event.userAgent,
            resource_type: event.resourceType,
            resource_id: event.resourceId,
            action: event.action,
            status: event.status,
            metadata: event.metadata || {},
            changes: event.changes || null
        };

        // Store in DB
        await pool.query(`
            INSERT INTO audit_logs (id, event_type, user_id, organization_id, ip_address, user_agent, resource_type, resource_id, action, status, metadata, changes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            logEntry.id, logEntry.event_type, logEntry.user_id, logEntry.organization_id,
            logEntry.ip_address, logEntry.user_agent, logEntry.resource_type, logEntry.resource_id,
            logEntry.action, logEntry.status, JSON.stringify(logEntry.metadata), JSON.stringify(logEntry.changes)
        ]);

        // Also store recent events in Redis for quick access
        await redis.lpush(`audit:${event.orgId}`, JSON.stringify(logEntry));
        await redis.ltrim(`audit:${event.orgId}`, 0, 999); // Keep last 1000 events

        return logEntry;
    }

    static async getRecentEvents(orgId, limit = 100) {
        const events = await redis.lrange(`audit:${orgId}`, 0, limit - 1);
        return events.map(e => JSON.parse(e));
    }

    static async query(filters) {
        let query = 'SELECT * FROM audit_logs WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (filters.orgId) {
            query += ` AND organization_id = $${paramIndex++}`;
            params.push(filters.orgId);
        }
        if (filters.userId) {
            query += ` AND user_id = $${paramIndex++}`;
            params.push(filters.userId);
        }
        if (filters.eventType) {
            query += ` AND event_type = $${paramIndex++}`;
            params.push(filters.eventType);
        }
        if (filters.fromDate) {
            query += ` AND created_at >= $${paramIndex++}`;
            params.push(filters.fromDate);
        }
        if (filters.toDate) {
            query += ` AND created_at <= $${paramIndex++}`;
            params.push(filters.toDate);
        }

        query += ' ORDER BY created_at DESC LIMIT $' + paramIndex++;
        params.push(filters.limit || 100);

        const result = await pool.query(query, params);
        return result.rows;
    }
}

// ============================================
// AUTH ERROR
// ============================================

class AuthError extends Error {
    constructor(message, code, status = 401) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        this.status = status;
    }
}

// ============================================
// MAIN AUTH SERVICE
// ============================================

class AuthService {
    // Register new user
    static async register(data) {
        const { email, password, firstName, lastName, organizationName, inviteToken } = data;

        // Validate password
        const passwordValidation = PasswordService.validate(password);
        if (!passwordValidation.valid) {
            throw new AuthError(passwordValidation.errors.join(', '), 'INVALID_PASSWORD', 400);
        }

        // Check for breached password
        const breachCheck = await PasswordService.checkBreached(password);
        if (breachCheck.breached) {
            throw new AuthError('This password has been found in data breaches. Please choose a different password.', 'BREACHED_PASSWORD', 400);
        }

        // Check if user exists
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existingUser.rows.length > 0) {
            throw new AuthError('Email already registered', 'EMAIL_EXISTS', 400);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let organizationId;
            let role = 'owner';

            if (inviteToken) {
                // Joining existing organization
                const invite = await client.query(
                    'SELECT * FROM invitations WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL',
                    [inviteToken]
                );
                if (invite.rows.length === 0) {
                    throw new AuthError('Invalid or expired invitation', 'INVALID_INVITE', 400);
                }
                organizationId = invite.rows[0].organization_id;
                role = invite.rows[0].role;

                // Mark invite as used
                await client.query('UPDATE invitations SET used_at = NOW() WHERE token = $1', [inviteToken]);
            } else {
                // Create new organization
                const orgSlug = this.generateSlug(organizationName);
                const orgResult = await client.query(`
                    INSERT INTO organizations (name, slug, plan, settings)
                    VALUES ($1, $2, 'trial', '{}')
                    RETURNING id
                `, [organizationName, orgSlug]);
                organizationId = orgResult.rows[0].id;
            }

            // Create user
            const passwordHash = await PasswordService.hash(password);
            const verificationToken = TokenService.generateResetToken();

            const userResult = await client.query(`
                INSERT INTO users (email, password_hash, first_name, last_name, organization_id, role, email_verification_token)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, email, first_name, last_name, role, created_at
            `, [email.toLowerCase(), passwordHash, firstName, lastName, organizationId, role, verificationToken]);

            const user = userResult.rows[0];

            await client.query('COMMIT');

            // Get organization details
            const orgResult = await pool.query('SELECT * FROM organizations WHERE id = $1', [organizationId]);
            const organization = orgResult.rows[0];

            // Create session
            const session = await SessionService.create(user.id, data.metadata || {});

            // Generate tokens
            const accessToken = TokenService.generateAccessToken(user, organization);
            const refreshToken = TokenService.generateRefreshToken(user, session.id);

            // Log event
            await AuditLog.log({
                type: 'user.registered',
                userId: user.id,
                orgId: organizationId,
                ip: data.metadata?.ip,
                userAgent: data.metadata?.userAgent,
                action: 'register',
                status: 'success'
            });

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    role: user.role
                },
                organization: {
                    id: organization.id,
                    name: organization.name,
                    slug: organization.slug
                },
                tokens: {
                    accessToken,
                    refreshToken,
                    expiresIn: 900 // 15 minutes
                },
                emailVerificationRequired: true
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Login
    static async login(email, password, metadata = {}) {
        // Rate limiting
        const rateLimit = await RateLimiter.getLoginAttempts(email);
        if (!rateLimit.allowed) {
            throw new AuthError(
                `Too many login attempts. Please try again in ${Math.ceil(rateLimit.resetIn / 60000)} minutes.`,
                'RATE_LIMITED',
                429
            );
        }

        // Find user
        const result = await pool.query(`
            SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug, o.plan as org_plan
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.email = $1 AND u.deleted_at IS NULL
        `, [email.toLowerCase()]);

        if (result.rows.length === 0) {
            await AuditLog.log({
                type: 'auth.login_failed',
                ip: metadata.ip,
                userAgent: metadata.userAgent,
                action: 'login',
                status: 'failed',
                metadata: { reason: 'user_not_found', email }
            });
            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS');
        }

        const user = result.rows[0];

        // Check if account is locked
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            throw new AuthError('Account is temporarily locked. Please try again later.', 'ACCOUNT_LOCKED');
        }

        // Verify password
        const validPassword = await PasswordService.verify(password, user.password_hash);
        if (!validPassword) {
            // Increment failed attempts
            await pool.query(`
                UPDATE users 
                SET failed_login_attempts = failed_login_attempts + 1,
                    locked_until = CASE WHEN failed_login_attempts >= 4 THEN NOW() + INTERVAL '30 minutes' ELSE NULL END
                WHERE id = $1
            `, [user.id]);

            await AuditLog.log({
                type: 'auth.login_failed',
                userId: user.id,
                orgId: user.organization_id,
                ip: metadata.ip,
                userAgent: metadata.userAgent,
                action: 'login',
                status: 'failed',
                metadata: { reason: 'invalid_password' }
            });

            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS');
        }

        // Reset rate limit on successful auth
        await RateLimiter.resetLimit(`login:${email}`);

        // Check MFA
        if (user.mfa_enabled) {
            const mfaToken = crypto.randomBytes(32).toString('hex');
            await redis.setex(`mfa_pending:${mfaToken}`, 300, JSON.stringify({
                userId: user.id,
                metadata
            }));

            return {
                mfaRequired: true,
                mfaToken,
                mfaMethods: ['totp', user.mfa_backup_codes_count > 0 ? 'backup_code' : null].filter(Boolean)
            };
        }

        return this.completeLogin(user, metadata);
    }

    // Complete login after MFA or direct
    static async completeLogin(user, metadata) {
        // Reset failed attempts
        await pool.query(`
            UPDATE users 
            SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
            WHERE id = $1
        `, [user.id]);

        // Create session
        const session = await SessionService.create(user.id, metadata);

        // Generate tokens
        const organization = {
            id: user.org_id,
            name: user.org_name,
            slug: user.org_slug
        };

        const accessToken = TokenService.generateAccessToken(user, organization);
        const refreshToken = TokenService.generateRefreshToken(user, session.id);

        // Log event
        await AuditLog.log({
            type: 'auth.login',
            userId: user.id,
            orgId: user.organization_id,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'login',
            status: 'success'
        });

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                role: user.role,
                emailVerified: user.email_verified_at !== null,
                mfaEnabled: user.mfa_enabled
            },
            organization,
            tokens: {
                accessToken,
                refreshToken,
                expiresIn: 900
            },
            session: {
                id: session.id,
                device: session.device
            }
        };
    }

    // Verify MFA
    static async verifyMFA(mfaToken, code, method = 'totp') {
        const pending = await redis.get(`mfa_pending:${mfaToken}`);
        if (!pending) {
            throw new AuthError('Invalid or expired MFA token', 'INVALID_MFA_TOKEN');
        }

        const { userId, metadata } = JSON.parse(pending);

        const user = await pool.query(`
            SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.id = $1
        `, [userId]);

        if (user.rows.length === 0) {
            throw new AuthError('User not found', 'USER_NOT_FOUND');
        }

        const userData = user.rows[0];
        let valid = false;

        if (method === 'totp') {
            valid = MFAService.verifyToken(userData.mfa_secret, code);
        } else if (method === 'backup_code') {
            const backupCodes = await pool.query(
                'SELECT code_hash FROM user_mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
                [userId]
            );
            
            for (const row of backupCodes.rows) {
                if (await bcrypt.compare(code.toUpperCase(), row.code_hash)) {
                    valid = true;
                    await pool.query(
                        'UPDATE user_mfa_backup_codes SET used_at = NOW() WHERE user_id = $1 AND code_hash = $2',
                        [userId, row.code_hash]
                    );
                    break;
                }
            }
        }

        if (!valid) {
            await AuditLog.log({
                type: 'auth.mfa_failed',
                userId,
                orgId: userData.organization_id,
                ip: metadata.ip,
                userAgent: metadata.userAgent,
                action: 'mfa_verify',
                status: 'failed'
            });
            throw new AuthError('Invalid verification code', 'INVALID_MFA_CODE');
        }

        // Clean up
        await redis.del(`mfa_pending:${mfaToken}`);

        return this.completeLogin(userData, metadata);
    }

    // Refresh token
    static async refreshTokens(refreshToken, metadata = {}) {
        const payload = TokenService.verifyRefreshToken(refreshToken);
        
        // Check session
        const session = await SessionService.get(payload.session_id);
        if (!session) {
            throw new AuthError('Session expired or revoked', 'SESSION_EXPIRED');
        }

        // Get user
        const result = await pool.query(`
            SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.id = $1 AND u.deleted_at IS NULL
        `, [payload.sub]);

        if (result.rows.length === 0) {
            throw new AuthError('User not found', 'USER_NOT_FOUND');
        }

        const user = result.rows[0];
        const organization = { id: user.org_id, name: user.org_name, slug: user.org_slug };

        // Update session activity
        await SessionService.updateActivity(payload.session_id);

        // Generate new tokens
        const newAccessToken = TokenService.generateAccessToken(user, organization);
        const newRefreshToken = TokenService.generateRefreshToken(user, payload.session_id);

        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: 900
        };
    }

    // Logout
    static async logout(sessionId, userId, metadata = {}) {
        await SessionService.revoke(sessionId);

        await AuditLog.log({
            type: 'auth.logout',
            userId,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'logout',
            status: 'success'
        });
    }

    // Password reset request
    static async requestPasswordReset(email, metadata = {}) {
        const rateLimit = await RateLimiter.getPasswordResetAttempts(email);
        if (!rateLimit.allowed) {
            throw new AuthError('Too many password reset attempts', 'RATE_LIMITED', 429);
        }

        const result = await pool.query('SELECT id, email, first_name FROM users WHERE email = $1', [email.toLowerCase()]);
        
        // Always return success to prevent email enumeration
        if (result.rows.length === 0) {
            return { success: true };
        }

        const user = result.rows[0];
        const resetToken = TokenService.generateResetToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await pool.query(`
            UPDATE users 
            SET password_reset_token = $1, password_reset_expires = $2
            WHERE id = $3
        `, [resetToken, expiresAt, user.id]);

        // Queue email (will be sent by worker)
        await redis.lpush('email_queue', JSON.stringify({
            template: 'password_reset',
            to: user.email,
            data: {
                firstName: user.first_name,
                resetUrl: `https://app.routz.io/reset-password?token=${resetToken}`
            }
        }));

        await AuditLog.log({
            type: 'auth.password_reset_requested',
            userId: user.id,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'password_reset_request',
            status: 'success'
        });

        return { success: true };
    }

    // Reset password
    static async resetPassword(token, newPassword, metadata = {}) {
        const passwordValidation = PasswordService.validate(newPassword);
        if (!passwordValidation.valid) {
            throw new AuthError(passwordValidation.errors.join(', '), 'INVALID_PASSWORD', 400);
        }

        const result = await pool.query(`
            SELECT id, email, organization_id FROM users 
            WHERE password_reset_token = $1 AND password_reset_expires > NOW()
        `, [token]);

        if (result.rows.length === 0) {
            throw new AuthError('Invalid or expired reset token', 'INVALID_RESET_TOKEN');
        }

        const user = result.rows[0];
        const passwordHash = await PasswordService.hash(newPassword);

        // Update password and invalidate all sessions
        await pool.query(`
            UPDATE users 
            SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL, password_changed_at = NOW()
            WHERE id = $2
        `, [passwordHash, user.id]);

        await SessionService.revokeAllUserSessions(user.id);

        await AuditLog.log({
            type: 'auth.password_reset',
            userId: user.id,
            orgId: user.organization_id,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'password_reset',
            status: 'success'
        });

        return { success: true };
    }

    // Enable MFA
    static async enableMFA(userId) {
        const result = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            throw new AuthError('User not found', 'USER_NOT_FOUND');
        }

        const { secret, otpauthUrl } = MFAService.generateSecret(result.rows[0].email);
        const qrCode = await MFAService.generateQRCode(otpauthUrl);

        // Store secret temporarily
        await redis.setex(`mfa_setup:${userId}`, 600, secret);

        return {
            secret,
            qrCode,
            otpauthUrl
        };
    }

    // Confirm MFA setup
    static async confirmMFA(userId, code, metadata = {}) {
        const secret = await redis.get(`mfa_setup:${userId}`);
        if (!secret) {
            throw new AuthError('MFA setup expired. Please start again.', 'MFA_SETUP_EXPIRED');
        }

        if (!MFAService.verifyToken(secret, code)) {
            throw new AuthError('Invalid verification code', 'INVALID_MFA_CODE');
        }

        // Generate backup codes
        const backupCodes = MFAService.generateBackupCodes();
        const hashedCodes = await MFAService.hashBackupCodes(backupCodes);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Enable MFA
            await client.query(`
                UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2
            `, [secret, userId]);

            // Store backup codes
            for (const hashedCode of hashedCodes) {
                await client.query(`
                    INSERT INTO user_mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)
                `, [userId, hashedCode]);
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        // Clean up
        await redis.del(`mfa_setup:${userId}`);

        await AuditLog.log({
            type: 'auth.mfa_enabled',
            userId,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'mfa_enable',
            status: 'success'
        });

        return {
            success: true,
            backupCodes // Show once to user
        };
    }

    // Disable MFA
    static async disableMFA(userId, password, metadata = {}) {
        const result = await pool.query('SELECT password_hash, organization_id FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            throw new AuthError('User not found', 'USER_NOT_FOUND');
        }

        const validPassword = await PasswordService.verify(password, result.rows[0].password_hash);
        if (!validPassword) {
            throw new AuthError('Invalid password', 'INVALID_PASSWORD');
        }

        await pool.query(`
            UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1
        `, [userId]);

        await pool.query('DELETE FROM user_mfa_backup_codes WHERE user_id = $1', [userId]);

        await AuditLog.log({
            type: 'auth.mfa_disabled',
            userId,
            orgId: result.rows[0].organization_id,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'mfa_disable',
            status: 'success'
        });

        return { success: true };
    }

    // OAuth login/register
    static async oauthLogin(provider, code, state, metadata = {}) {
        // Verify state
        const stateData = await OAuthService.getOAuthState(state);
        if (!stateData) {
            throw new AuthError('Invalid OAuth state', 'INVALID_OAUTH_STATE');
        }

        let oauthUser;
        if (provider === 'google') {
            oauthUser = await OAuthService.exchangeGoogleCode(code);
        } else if (provider === 'microsoft') {
            oauthUser = await OAuthService.exchangeMicrosoftCode(code);
        } else {
            throw new AuthError('Unsupported OAuth provider', 'INVALID_PROVIDER');
        }

        // Check if user exists by provider ID
        let result = await pool.query(`
            SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug
            FROM users u
            JOIN organizations o ON u.organization_id = o.id
            WHERE u.oauth_provider = $1 AND u.oauth_provider_id = $2
        `, [provider, oauthUser.providerId]);

        if (result.rows.length === 0) {
            // Check by email
            result = await pool.query(`
                SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug
                FROM users u
                JOIN organizations o ON u.organization_id = o.id
                WHERE u.email = $1
            `, [oauthUser.email.toLowerCase()]);

            if (result.rows.length > 0) {
                // Link OAuth to existing account
                await pool.query(`
                    UPDATE users SET oauth_provider = $1, oauth_provider_id = $2 WHERE id = $3
                `, [provider, oauthUser.providerId, result.rows[0].id]);
            } else {
                // Create new user and organization
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    const orgSlug = this.generateSlug(oauthUser.firstName + ' ' + oauthUser.lastName);
                    const orgResult = await client.query(`
                        INSERT INTO organizations (name, slug, plan) VALUES ($1, $2, 'trial') RETURNING id
                    `, [oauthUser.firstName + "'s Organization", orgSlug]);

                    const userResult = await client.query(`
                        INSERT INTO users (email, first_name, last_name, organization_id, role, oauth_provider, oauth_provider_id, email_verified_at)
                        VALUES ($1, $2, $3, $4, 'owner', $5, $6, NOW())
                        RETURNING *
                    `, [oauthUser.email.toLowerCase(), oauthUser.firstName, oauthUser.lastName, orgResult.rows[0].id, provider, oauthUser.providerId]);

                    await client.query('COMMIT');

                    result = await pool.query(`
                        SELECT u.*, o.id as org_id, o.name as org_name, o.slug as org_slug
                        FROM users u
                        JOIN organizations o ON u.organization_id = o.id
                        WHERE u.id = $1
                    `, [userResult.rows[0].id]);
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            }
        }

        const user = result.rows[0];

        await AuditLog.log({
            type: 'auth.oauth_login',
            userId: user.id,
            orgId: user.organization_id,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'oauth_login',
            status: 'success',
            metadata: { provider }
        });

        return this.completeLogin(user, metadata);
    }

    // Invite user to organization
    static async inviteUser(orgId, email, role, invitedBy, metadata = {}) {
        // Check if user already exists in org
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 AND organization_id = $2',
            [email.toLowerCase(), orgId]
        );

        if (existing.rows.length > 0) {
            throw new AuthError('User already belongs to this organization', 'USER_EXISTS', 400);
        }

        const token = TokenService.generateResetToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await pool.query(`
            INSERT INTO invitations (organization_id, email, role, token, invited_by, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [orgId, email.toLowerCase(), role, token, invitedBy, expiresAt]);

        // Queue invitation email
        await redis.lpush('email_queue', JSON.stringify({
            template: 'invitation',
            to: email,
            data: {
                inviteUrl: `https://app.routz.io/accept-invite?token=${token}`,
                role
            }
        }));

        await AuditLog.log({
            type: 'user.invited',
            userId: invitedBy,
            orgId,
            ip: metadata.ip,
            userAgent: metadata.userAgent,
            action: 'invite_user',
            status: 'success',
            metadata: { invitedEmail: email, role }
        });

        return { success: true, token };
    }

    // Helper: Generate URL-safe slug
    static generateSlug(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            + '-' + crypto.randomBytes(3).toString('hex');
    }
}

// ============================================
// EXPRESS MIDDLEWARE
// ============================================

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            throw new AuthError('No token provided', 'NO_TOKEN');
        }

        const token = authHeader.substring(7);
        const payload = TokenService.verifyAccessToken(token);

        // Check if token is blacklisted
        const blacklisted = await redis.get(`token_blacklist:${payload.jti}`);
        if (blacklisted) {
            throw new AuthError('Token has been revoked', 'TOKEN_REVOKED');
        }

        req.user = {
            id: payload.sub,
            email: payload.email,
            orgId: payload.org_id,
            orgSlug: payload.org_slug,
            role: payload.role,
            permissions: payload.permissions
        };

        next();
    } catch (error) {
        if (error instanceof AuthError) {
            return res.status(error.status).json({ error: error.message, code: error.code });
        }
        return res.status(401).json({ error: 'Authentication failed', code: 'AUTH_FAILED' });
    }
};

const requirePermission = (...requiredPermissions) => {
    return (req, res, next) => {
        const userPermissions = req.user?.permissions || [];
        const hasPermission = requiredPermissions.some(p => userPermissions.includes(p));

        if (!hasPermission) {
            return res.status(403).json({
                error: 'Insufficient permissions',
                code: 'FORBIDDEN',
                required: requiredPermissions
            });
        }

        next();
    };
};

const apiKeyMiddleware = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return next(); // Fall through to other auth methods
        }

        const keyHash = TokenService.hashApiKey(apiKey);
        const result = await pool.query(`
            SELECT ak.*, u.id as user_id, u.role, o.id as org_id, o.slug as org_slug
            FROM api_keys ak
            JOIN users u ON ak.user_id = u.id
            JOIN organizations o ON u.organization_id = o.id
            WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL
        `, [keyHash]);

        if (result.rows.length === 0) {
            throw new AuthError('Invalid API key', 'INVALID_API_KEY');
        }

        const key = result.rows[0];

        // Check rate limit
        const rateLimit = await RateLimiter.checkLimit(`api_key:${key.id}`, {
            maxAttempts: key.rate_limit || 1000,
            windowMs: 60 * 60 * 1000 // per hour
        });

        if (!rateLimit.allowed) {
            return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
        }

        // Update last used
        await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]);

        req.user = {
            id: key.user_id,
            orgId: key.org_id,
            orgSlug: key.org_slug,
            role: key.role,
            permissions: TokenService.getPermissions(key.role),
            isApiKey: true,
            apiKeyId: key.id
        };

        // Set rate limit headers
        res.set('X-RateLimit-Limit', rateLimit.total);
        res.set('X-RateLimit-Remaining', rateLimit.remaining);
        res.set('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + rateLimit.resetIn / 1000));

        next();
    } catch (error) {
        if (error instanceof AuthError) {
            return res.status(error.status).json({ error: error.message, code: error.code });
        }
        return res.status(401).json({ error: 'Authentication failed', code: 'AUTH_FAILED' });
    }
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Services
    AuthService,
    TokenService,
    PasswordService,
    MFAService,
    SessionService,
    RateLimiter,
    OAuthService,
    SAMLService,
    AuditLog,

    // Middleware
    authMiddleware,
    requirePermission,
    apiKeyMiddleware,

    // Constants
    PERMISSIONS,
    ROLES,

    // Errors
    AuthError,

    // Config
    config
};
