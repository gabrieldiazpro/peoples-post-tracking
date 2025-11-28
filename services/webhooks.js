/**
 * Routz v4.0 - Advanced Webhooks Service
 * Système de webhooks avec signatures, retry, logs
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebhooksService extends EventEmitter {
    constructor(db, config = {}) {
        super();
        this.db = db;
        this.secret = config.secret || process.env.WEBHOOK_SECRET;
        this.maxRetries = config.maxRetries || 5;
        this.retryDelays = config.retryDelays || [60, 300, 900, 3600, 86400]; // 1m, 5m, 15m, 1h, 24h
        this.timeout = config.timeout || 30000;
        this.batchSize = config.batchSize || 100;
    }

    // ==========================================
    // WEBHOOK ENDPOINTS MANAGEMENT
    // ==========================================

    /**
     * Register a new webhook endpoint
     */
    async registerEndpoint(orgId, data) {
        const endpoint = {
            id: this.generateId('whk'),
            organizationId: orgId,
            url: data.url,
            name: data.name || this.extractDomain(data.url),
            events: data.events || ['*'], // * = all events
            secret: data.secret || this.generateSecret(),
            headers: data.headers || {},
            enabled: data.enabled ?? true,
            version: data.version || 'v1',
            format: data.format || 'json', // json, form
            settings: {
                retryEnabled: data.settings?.retryEnabled ?? true,
                signatureHeader: data.settings?.signatureHeader || 'X-Routz-Signature',
                timestampHeader: data.settings?.timestampHeader || 'X-Routz-Timestamp',
                includeMetadata: data.settings?.includeMetadata ?? true
            },
            stats: {
                totalSent: 0,
                totalSuccess: 0,
                totalFailed: 0,
                lastSentAt: null,
                lastSuccessAt: null,
                lastErrorAt: null,
                lastError: null
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO webhooks (id, organization_id, url, name, events, secret, headers, enabled, version, format, settings, stats, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [endpoint.id, endpoint.organizationId, endpoint.url, endpoint.name, 
             JSON.stringify(endpoint.events), endpoint.secret, JSON.stringify(endpoint.headers),
             endpoint.enabled, endpoint.version, endpoint.format, 
             JSON.stringify(endpoint.settings), JSON.stringify(endpoint.stats), endpoint.createdAt]
        );

        this.emit('endpoint:created', endpoint);
        return { ...endpoint, secret: endpoint.secret }; // Return secret only on creation
    }

    /**
     * List endpoints for organization
     */
    async listEndpoints(orgId) {
        const result = await this.db.query(
            `SELECT id, organization_id, url, name, events, enabled, version, format, settings, stats, created_at, updated_at
             FROM webhooks WHERE organization_id = $1 ORDER BY created_at DESC`,
            [orgId]
        );
        return result.rows.map(row => ({
            ...row,
            events: JSON.parse(row.events),
            settings: JSON.parse(row.settings),
            stats: JSON.parse(row.stats)
        }));
    }

    /**
     * Update endpoint
     */
    async updateEndpoint(endpointId, updates) {
        const allowed = ['url', 'name', 'events', 'headers', 'enabled', 'settings'];
        const fields = [];
        const values = [];
        let idx = 1;

        for (const [key, value] of Object.entries(updates)) {
            if (allowed.includes(key)) {
                fields.push(`${key} = $${idx}`);
                values.push(typeof value === 'object' ? JSON.stringify(value) : value);
                idx++;
            }
        }

        if (fields.length === 0) return null;

        fields.push(`updated_at = $${idx}`);
        values.push(new Date().toISOString());
        values.push(endpointId);

        await this.db.query(
            `UPDATE webhooks SET ${fields.join(', ')} WHERE id = $${idx + 1}`,
            values
        );

        return this.getEndpoint(endpointId);
    }

    /**
     * Delete endpoint
     */
    async deleteEndpoint(endpointId) {
        await this.db.query('DELETE FROM webhooks WHERE id = $1', [endpointId]);
        this.emit('endpoint:deleted', { id: endpointId });
    }

    /**
     * Rotate secret
     */
    async rotateSecret(endpointId) {
        const newSecret = this.generateSecret();
        await this.db.query(
            `UPDATE webhooks SET secret = $1, updated_at = $2 WHERE id = $3`,
            [newSecret, new Date().toISOString(), endpointId]
        );
        return { secret: newSecret };
    }

    // ==========================================
    // WEBHOOK EVENTS
    // ==========================================

    /**
     * Available webhook events
     */
    static EVENTS = {
        // Shipments
        'shipment.created': 'Expédition créée',
        'shipment.label_generated': 'Étiquette générée',
        'shipment.shipped': 'Expédition envoyée',
        'shipment.in_transit': 'En transit',
        'shipment.out_for_delivery': 'En cours de livraison',
        'shipment.delivered': 'Livrée',
        'shipment.exception': 'Exception de livraison',
        'shipment.returned': 'Retournée',
        'shipment.cancelled': 'Annulée',

        // Orders
        'order.created': 'Commande créée',
        'order.updated': 'Commande mise à jour',
        'order.fulfilled': 'Commande expédiée',
        'order.cancelled': 'Commande annulée',

        // Returns
        'return.requested': 'Retour demandé',
        'return.approved': 'Retour approuvé',
        'return.received': 'Retour reçu',
        'return.refunded': 'Retour remboursé',

        // Inventory
        'inventory.low_stock': 'Stock faible',
        'inventory.out_of_stock': 'Rupture de stock',
        'inventory.restocked': 'Réapprovisionné',

        // Billing
        'invoice.created': 'Facture créée',
        'invoice.paid': 'Facture payée',
        'subscription.updated': 'Abonnement modifié'
    };

    /**
     * Trigger a webhook event
     */
    async trigger(orgId, eventType, payload) {
        // Find matching endpoints
        const endpoints = await this.db.query(
            `SELECT * FROM webhooks 
             WHERE organization_id = $1 AND enabled = true 
             AND (events @> $2 OR events @> '["*"]')`,
            [orgId, JSON.stringify([eventType])]
        );

        const deliveries = [];
        for (const endpoint of endpoints.rows) {
            const delivery = await this.createDelivery(endpoint, eventType, payload);
            deliveries.push(delivery);
            
            // Send async
            this.sendWebhook(delivery).catch(err => {
                console.error(`Webhook delivery failed: ${delivery.id}`, err);
            });
        }

        return deliveries;
    }

    /**
     * Create delivery record
     */
    async createDelivery(endpoint, eventType, payload) {
        const delivery = {
            id: this.generateId('del'),
            endpointId: endpoint.id,
            eventType,
            payload,
            status: 'pending',
            attempts: 0,
            nextRetryAt: null,
            request: null,
            response: null,
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO webhook_deliveries (id, endpoint_id, event_type, payload, status, attempts, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [delivery.id, delivery.endpointId, delivery.eventType, 
             JSON.stringify(delivery.payload), delivery.status, delivery.attempts, delivery.createdAt]
        );

        return delivery;
    }

    // ==========================================
    // WEBHOOK DELIVERY
    // ==========================================

    /**
     * Send webhook
     */
    async sendWebhook(delivery) {
        const endpoint = await this.getEndpoint(delivery.endpointId);
        if (!endpoint || !endpoint.enabled) return;

        const timestamp = Math.floor(Date.now() / 1000);
        const body = this.formatPayload(delivery, endpoint, timestamp);
        const signature = this.signPayload(body, endpoint.secret, timestamp);

        const headers = {
            'Content-Type': endpoint.format === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
            'User-Agent': 'Routz-Webhooks/1.0',
            [endpoint.settings.signatureHeader]: signature,
            [endpoint.settings.timestampHeader]: timestamp.toString(),
            ...JSON.parse(endpoint.headers || '{}')
        };

        const request = {
            url: endpoint.url,
            method: 'POST',
            headers,
            body,
            timestamp: new Date().toISOString()
        };

        try {
            delivery.attempts++;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(endpoint.url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const responseBody = await response.text();
            const responseData = {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: responseBody.substring(0, 1000), // Limit stored response
                timestamp: new Date().toISOString()
            };

            if (response.ok) {
                await this.markSuccess(delivery, request, responseData);
            } else {
                await this.markFailed(delivery, request, responseData, `HTTP ${response.status}`);
            }

        } catch (error) {
            const errorData = {
                status: 0,
                error: error.message,
                timestamp: new Date().toISOString()
            };
            await this.markFailed(delivery, request, errorData, error.message);
        }
    }

    /**
     * Format payload
     */
    formatPayload(delivery, endpoint, timestamp) {
        const data = {
            id: delivery.id,
            type: delivery.eventType,
            created: timestamp,
            data: delivery.payload
        };

        if (endpoint.settings.includeMetadata) {
            data.metadata = {
                endpoint_id: endpoint.id,
                attempt: delivery.attempts + 1,
                version: endpoint.version
            };
        }

        if (endpoint.format === 'json') {
            return JSON.stringify(data);
        } else {
            return new URLSearchParams({
                payload: JSON.stringify(data)
            }).toString();
        }
    }

    /**
     * Sign payload
     */
    signPayload(payload, secret, timestamp) {
        const signedPayload = `${timestamp}.${payload}`;
        const signature = crypto
            .createHmac('sha256', secret)
            .update(signedPayload)
            .digest('hex');
        return `v1=${signature}`;
    }

    /**
     * Verify incoming webhook signature
     */
    verifySignature(payload, signature, secret, tolerance = 300) {
        const [version, hash] = signature.split('=');
        if (version !== 'v1') return false;

        // Extract timestamp from payload
        let timestamp;
        try {
            const data = JSON.parse(payload);
            timestamp = data.created;
        } catch {
            return false;
        }

        // Check timestamp tolerance
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - timestamp) > tolerance) {
            return false;
        }

        // Verify signature
        const expected = crypto
            .createHmac('sha256', secret)
            .update(`${timestamp}.${payload}`)
            .digest('hex');

        return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
    }

    /**
     * Mark delivery as success
     */
    async markSuccess(delivery, request, response) {
        await this.db.query(
            `UPDATE webhook_deliveries 
             SET status = 'success', attempts = $1, request = $2, response = $3, completed_at = $4
             WHERE id = $5`,
            [delivery.attempts, JSON.stringify(request), JSON.stringify(response), 
             new Date().toISOString(), delivery.id]
        );

        await this.updateEndpointStats(delivery.endpointId, true);
        this.emit('delivery:success', delivery);
    }

    /**
     * Mark delivery as failed and schedule retry
     */
    async markFailed(delivery, request, response, error) {
        const endpoint = await this.getEndpoint(delivery.endpointId);
        const settings = JSON.parse(endpoint.settings);
        
        let status = 'failed';
        let nextRetryAt = null;

        if (settings.retryEnabled && delivery.attempts < this.maxRetries) {
            status = 'pending';
            const delay = this.retryDelays[delivery.attempts - 1] || this.retryDelays[this.retryDelays.length - 1];
            nextRetryAt = new Date(Date.now() + delay * 1000).toISOString();
        }

        await this.db.query(
            `UPDATE webhook_deliveries 
             SET status = $1, attempts = $2, request = $3, response = $4, next_retry_at = $5, last_error = $6
             WHERE id = $7`,
            [status, delivery.attempts, JSON.stringify(request), JSON.stringify(response),
             nextRetryAt, error, delivery.id]
        );

        await this.updateEndpointStats(delivery.endpointId, false, error);
        
        if (status === 'failed') {
            this.emit('delivery:failed', { ...delivery, error });
        } else {
            this.emit('delivery:retry_scheduled', { ...delivery, nextRetryAt });
        }
    }

    /**
     * Update endpoint stats
     */
    async updateEndpointStats(endpointId, success, error = null) {
        const now = new Date().toISOString();
        
        if (success) {
            await this.db.query(
                `UPDATE webhooks SET 
                 stats = jsonb_set(jsonb_set(jsonb_set(
                     stats, '{totalSent}', (COALESCE((stats->>'totalSent')::int, 0) + 1)::text::jsonb),
                     '{totalSuccess}', (COALESCE((stats->>'totalSuccess')::int, 0) + 1)::text::jsonb),
                     '{lastSuccessAt}', $1::jsonb)
                 WHERE id = $2`,
                [JSON.stringify(now), endpointId]
            );
        } else {
            await this.db.query(
                `UPDATE webhooks SET 
                 stats = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
                     stats, '{totalSent}', (COALESCE((stats->>'totalSent')::int, 0) + 1)::text::jsonb),
                     '{totalFailed}', (COALESCE((stats->>'totalFailed')::int, 0) + 1)::text::jsonb),
                     '{lastErrorAt}', $1::jsonb),
                     '{lastError}', $2::jsonb)
                 WHERE id = $3`,
                [JSON.stringify(now), JSON.stringify(error), endpointId]
            );
        }
    }

    // ==========================================
    // RETRY PROCESSING
    // ==========================================

    /**
     * Process pending retries
     */
    async processRetries() {
        const result = await this.db.query(
            `SELECT d.*, w.url, w.secret, w.headers, w.format, w.settings, w.enabled
             FROM webhook_deliveries d
             JOIN webhooks w ON d.endpoint_id = w.id
             WHERE d.status = 'pending' 
             AND d.next_retry_at IS NOT NULL 
             AND d.next_retry_at <= NOW()
             AND w.enabled = true
             LIMIT $1`,
            [this.batchSize]
        );

        for (const row of result.rows) {
            const delivery = {
                id: row.id,
                endpointId: row.endpoint_id,
                eventType: row.event_type,
                payload: JSON.parse(row.payload),
                attempts: row.attempts
            };

            await this.sendWebhook(delivery);
        }

        return result.rows.length;
    }

    // ==========================================
    // LOGS & HISTORY
    // ==========================================

    /**
     * Get delivery logs
     */
    async getDeliveryLogs(endpointId, options = {}) {
        let query = `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1`;
        const params = [endpointId];
        let idx = 2;

        if (options.status) {
            query += ` AND status = $${idx}`;
            params.push(options.status);
            idx++;
        }

        if (options.eventType) {
            query += ` AND event_type = $${idx}`;
            params.push(options.eventType);
            idx++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${idx}`;
        params.push(options.limit || 50);

        const result = await this.db.query(query, params);
        return result.rows.map(row => ({
            ...row,
            payload: JSON.parse(row.payload),
            request: row.request ? JSON.parse(row.request) : null,
            response: row.response ? JSON.parse(row.response) : null
        }));
    }

    /**
     * Retry a specific delivery
     */
    async retryDelivery(deliveryId) {
        const result = await this.db.query(
            `SELECT * FROM webhook_deliveries WHERE id = $1`,
            [deliveryId]
        );

        if (!result.rows[0]) throw new Error('Delivery not found');

        const delivery = {
            ...result.rows[0],
            payload: JSON.parse(result.rows[0].payload),
            attempts: 0 // Reset attempts for manual retry
        };

        await this.db.query(
            `UPDATE webhook_deliveries SET status = 'pending', attempts = 0 WHERE id = $1`,
            [deliveryId]
        );

        await this.sendWebhook(delivery);
        return delivery;
    }

    // ==========================================
    // TESTING
    // ==========================================

    /**
     * Send test webhook
     */
    async sendTest(endpointId) {
        const endpoint = await this.getEndpoint(endpointId);
        if (!endpoint) throw new Error('Endpoint not found');

        const testPayload = {
            test: true,
            message: 'This is a test webhook from Routz',
            timestamp: new Date().toISOString()
        };

        const delivery = await this.createDelivery(endpoint, 'test.ping', testPayload);
        await this.sendWebhook(delivery);

        return this.getDelivery(delivery.id);
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getEndpoint(id) {
        const result = await this.db.query('SELECT * FROM webhooks WHERE id = $1', [id]);
        return result.rows[0];
    }

    async getDelivery(id) {
        const result = await this.db.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
        const row = result.rows[0];
        if (!row) return null;
        return {
            ...row,
            payload: JSON.parse(row.payload),
            request: row.request ? JSON.parse(row.request) : null,
            response: row.response ? JSON.parse(row.response) : null
        };
    }

    generateId(prefix) {
        return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
    }

    generateSecret() {
        return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    }

    extractDomain(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return 'webhook';
        }
    }
}

module.exports = { WebhooksService };
