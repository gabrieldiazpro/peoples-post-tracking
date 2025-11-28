/**
 * Routz v4.0 - Advanced Webhooks System
 * Système d'événements avec retry, signatures et logging
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebhookService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.db = config.db;
        this.queue = config.queue;
        this.maxRetries = config.maxRetries || 5;
        this.retryDelays = config.retryDelays || [60, 300, 900, 3600, 86400]; // seconds
        this.timeout = config.timeout || 30000; // 30s
        this.signatureHeader = 'x-routz-signature';
        this.timestampHeader = 'x-routz-timestamp';
    }

    // ==========================================
    // WEBHOOK MANAGEMENT
    // ==========================================

    async createWebhook(orgId, data) {
        const webhook = {
            id: this.generateId(),
            organizationId: orgId,
            url: data.url,
            events: data.events || ['*'],
            secret: data.secret || this.generateSecret(),
            active: data.active ?? true,
            headers: data.headers || {},
            metadata: data.metadata || {},
            failureCount: 0,
            lastTriggered: null,
            createdAt: new Date().toISOString()
        };

        this.validateUrl(webhook.url);

        await this.db.query(
            `INSERT INTO webhooks (id, organization_id, url, events, secret, active, headers, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [webhook.id, webhook.organizationId, webhook.url, JSON.stringify(webhook.events),
             webhook.secret, webhook.active, JSON.stringify(webhook.headers), 
             JSON.stringify(webhook.metadata), webhook.createdAt]
        );

        return webhook;
    }

    async trigger(orgId, event, payload) {
        const webhooks = await this.getActiveWebhooksForEvent(orgId, event);
        const deliveries = [];
        
        for (const webhook of webhooks) {
            const delivery = await this.createDelivery(webhook, event, payload);
            deliveries.push(delivery);
            await this.queueDelivery(delivery);
        }

        this.emit('webhooks:triggered', { event, webhookCount: webhooks.length });
        return deliveries;
    }

    async getActiveWebhooksForEvent(orgId, event) {
        const result = await this.db.query(
            `SELECT * FROM webhooks 
             WHERE organization_id = $1 AND active = true 
             AND (events @> $2 OR events @> '["*"]')`,
            [orgId, JSON.stringify([event])]
        );
        return result.rows;
    }

    async createDelivery(webhook, event, payload) {
        const timestamp = Date.now();
        const delivery = {
            id: this.generateId(),
            webhookId: webhook.id,
            event,
            payload,
            attempt: 1,
            status: 'pending',
            signature: this.generateSignature(webhook.secret, timestamp, payload),
            timestamp,
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempt, status, signature, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [delivery.id, delivery.webhookId, delivery.event, JSON.stringify(delivery.payload),
             delivery.attempt, delivery.status, delivery.signature, delivery.createdAt]
        );

        return delivery;
    }

    async queueDelivery(delivery) {
        await this.queue.add('webhook-delivery', { deliveryId: delivery.id }, {
            attempts: this.maxRetries,
            backoff: { type: 'exponential', delay: 60000 }
        });
    }

    async processDelivery(deliveryId) {
        const delivery = await this.getDelivery(deliveryId);
        if (!delivery) throw new Error('Delivery not found');

        const webhook = await this.getWebhook(delivery.webhookId);
        if (!webhook) throw new Error('Webhook not found');

        const startTime = Date.now();

        try {
            await this.updateDeliveryStatus(deliveryId, 'processing');
            const result = await this.sendRequest(webhook, delivery);
            await this.recordDeliverySuccess(delivery, result, Date.now() - startTime);
            await this.updateWebhookSuccess(webhook.id);
            this.emit('delivery:success', { deliveryId, webhookId: webhook.id });
            return { success: true, ...result };
        } catch (error) {
            await this.recordDeliveryFailure(delivery, error, Date.now() - startTime);
            await this.updateWebhookFailure(webhook.id);
            this.emit('delivery:failure', { deliveryId, webhookId: webhook.id, error: error.message });
            if (delivery.attempt < this.maxRetries) await this.scheduleRetry(delivery);
            throw error;
        }
    }

    async sendRequest(webhook, delivery) {
        const timestamp = Date.now();
        const signature = this.generateSignature(webhook.secret, timestamp, delivery.payload);

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Routz-Webhooks/1.0',
            [this.signatureHeader]: signature,
            [this.timestampHeader]: timestamp.toString(),
            'x-routz-delivery-id': delivery.id,
            'x-routz-event': delivery.event,
            ...webhook.headers
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(webhook.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(delivery.payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            const responseBody = await response.text().catch(() => '');

            if (!response.ok) {
                throw new WebhookError(`HTTP ${response.status}`, response.status, responseBody);
            }

            return { statusCode: response.status, responseBody: responseBody.substring(0, 1000) };
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new WebhookError('Request timeout', 408, '');
            throw error;
        }
    }

    generateSignature(secret, timestamp, payload) {
        const data = `${timestamp}.${JSON.stringify(payload)}`;
        return `sha256=${crypto.createHmac('sha256', secret).update(data).digest('hex')}`;
    }

    verifySignature(secret, signature, timestamp, payload) {
        const expected = this.generateSignature(secret, timestamp, payload);
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    }

    async recordDeliverySuccess(delivery, result, duration) {
        await this.db.query(
            `UPDATE webhook_deliveries SET status = 'delivered', response_code = $1, response_body = $2, duration_ms = $3, delivered_at = $4 WHERE id = $5`,
            [result.statusCode, result.responseBody, duration, new Date().toISOString(), delivery.id]
        );
    }

    async recordDeliveryFailure(delivery, error, duration) {
        await this.db.query(
            `UPDATE webhook_deliveries SET status = $1, error_message = $2, duration_ms = $3, failed_at = $4 WHERE id = $5`,
            [delivery.attempt >= this.maxRetries ? 'failed' : 'retrying', error.message, duration, new Date().toISOString(), delivery.id]
        );
    }

    async scheduleRetry(delivery) {
        const delay = this.retryDelays[delivery.attempt - 1] || 86400;
        await this.queue.add('webhook-delivery', { deliveryId: delivery.id, attempt: delivery.attempt + 1 }, { delay: delay * 1000 });
    }

    async updateWebhookSuccess(webhookId) {
        await this.db.query(`UPDATE webhooks SET last_triggered = $1, failure_count = 0 WHERE id = $2`, [new Date().toISOString(), webhookId]);
    }

    async updateWebhookFailure(webhookId) {
        await this.db.query(`UPDATE webhooks SET last_triggered = $1, failure_count = failure_count + 1 WHERE id = $2`, [new Date().toISOString(), webhookId]);
    }

    async getDelivery(deliveryId) {
        const result = await this.db.query(`SELECT * FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
        return result.rows[0];
    }

    async getWebhook(webhookId) {
        const result = await this.db.query(`SELECT * FROM webhooks WHERE id = $1`, [webhookId]);
        return result.rows[0];
    }

    async updateDeliveryStatus(deliveryId, status) {
        await this.db.query(`UPDATE webhook_deliveries SET status = $1 WHERE id = $2`, [status, deliveryId]);
    }

    async getDeliveryHistory(webhookId, limit = 50) {
        const result = await this.db.query(`SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`, [webhookId, limit]);
        return result.rows;
    }

    async testWebhook(webhookId) {
        const webhook = await this.getWebhook(webhookId);
        if (!webhook) throw new Error('Webhook not found');

        const testPayload = { type: 'test', message: 'Test webhook from Routz', timestamp: new Date().toISOString(), webhookId };
        const delivery = await this.createDelivery(webhook, 'test', testPayload);

        try {
            await this.processDelivery(delivery.id);
            return { success: true, deliveryId: delivery.id };
        } catch (error) {
            return { success: false, deliveryId: delivery.id, error: error.message };
        }
    }

    generateId() { return `wh_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`; }
    generateSecret() { return `whsec_${crypto.randomBytes(24).toString('hex')}`; }
    validateUrl(url) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL'); }
}

class WebhookError extends Error {
    constructor(message, statusCode, responseBody) {
        super(message);
        this.name = 'WebhookError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}

const WEBHOOK_EVENTS = {
    SHIPMENT_CREATED: 'shipment.created',
    SHIPMENT_SHIPPED: 'shipment.shipped',
    SHIPMENT_IN_TRANSIT: 'shipment.in_transit',
    SHIPMENT_DELIVERED: 'shipment.delivered',
    SHIPMENT_EXCEPTION: 'shipment.exception',
    ORDER_CREATED: 'order.created',
    ORDER_UPDATED: 'order.updated',
    RETURN_CREATED: 'return.created',
    RETURN_RECEIVED: 'return.received',
    TRACKING_UPDATED: 'tracking.updated'
};

module.exports = { WebhookService, WebhookError, WEBHOOK_EVENTS };
