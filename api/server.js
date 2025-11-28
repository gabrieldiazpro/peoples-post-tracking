/**
 * Routz v4.0 - Main API Server
 * Express.js with all routes, middleware, and integrations
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// Services
const { CarrierSelectionAI } = require('../services/carrier-selection-ai');
const { RealtimeService } = require('../services/realtime');
const { QoSService } = require('../services/qos');
const { CustomerSupportService } = require('../services/customer-support');
const { InternationalService } = require('../services/international');
const { ReturnsService } = require('../services/returns-advanced');

const app = express();

// ==========================================
// DATABASE & CACHE
// ==========================================

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const redis = new Redis(process.env.REDIS_URL);

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || '*',
    credentials: true
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Request ID
app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    next();
});

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid authorization header' });
        }

        const token = authHeader.substring(7);
        
        // Check if it's an API key or JWT
        if (token.startsWith('rtz_')) {
            // API Key authentication
            const result = await db.query(
                'SELECT u.*, o.id as org_id, o.plan FROM users u JOIN organizations o ON u.organization_id = o.id WHERE u.api_token = $1',
                [token]
            );
            
            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid API key' });
            }
            
            req.user = result.rows[0];
            req.orgId = result.rows[0].org_id;
        } else {
            // JWT authentication
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;
            req.orgId = decoded.orgId;
        }

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        await redis.ping();
        res.json({ 
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '4.0.0'
        });
    } catch (error) {
        res.status(503).json({ status: 'unhealthy', error: error.message });
    }
});

// ==========================================
// SHIPMENTS API
// ==========================================

app.get('/api/v1/shipments', authenticate, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, carrier, from_date, to_date } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM shipments WHERE organization_id = $1';
        const params = [req.orgId];
        let paramCount = 1;

        if (status) {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(status);
        }

        if (carrier) {
            paramCount++;
            query += ` AND carrier = $${paramCount}`;
            params.push(carrier);
        }

        if (from_date) {
            paramCount++;
            query += ` AND created_at >= $${paramCount}`;
            params.push(from_date);
        }

        if (to_date) {
            paramCount++;
            query += ` AND created_at <= $${paramCount}`;
            params.push(to_date);
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(limit, offset);

        const result = await db.query(query, params);
        
        const countResult = await db.query(
            'SELECT COUNT(*) FROM shipments WHERE organization_id = $1',
            [req.orgId]
        );

        res.json({
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(countResult.rows[0].count / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching shipments:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/shipments', authenticate, async (req, res) => {
    try {
        const { carrier, service, sender, recipient, parcels, reference, options } = req.body;

        // Validation
        if (!carrier || !sender || !recipient || !parcels?.length) {
            return res.status(422).json({ 
                error: 'Validation error',
                errors: [
                    !carrier && { field: 'carrier', message: 'Carrier is required' },
                    !sender && { field: 'sender', message: 'Sender is required' },
                    !recipient && { field: 'recipient', message: 'Recipient is required' },
                    !parcels?.length && { field: 'parcels', message: 'At least one parcel is required' }
                ].filter(Boolean)
            });
        }

        // Generate tracking number
        const trackingNumber = generateTrackingNumber(carrier);

        // Calculate total weight
        const totalWeight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);

        // Create shipment
        const result = await db.query(`
            INSERT INTO shipments (
                id, organization_id, tracking_number, carrier, service, status,
                sender_name, sender_company, sender_address1, sender_address2, 
                sender_city, sender_state, sender_postal_code, sender_country, sender_phone, sender_email,
                recipient_name, recipient_company, recipient_address1, recipient_address2,
                recipient_city, recipient_state, recipient_postal_code, recipient_country, recipient_phone, recipient_email,
                parcels, total_weight, reference, metadata
            ) VALUES (
                $1, $2, $3, $4, $5, 'pending',
                $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
                $26, $27, $28, $29
            ) RETURNING *
        `, [
            uuidv4(), req.orgId, trackingNumber, carrier, service || 'standard',
            sender.name, sender.company, sender.address1, sender.address2,
            sender.city, sender.state, sender.postalCode, sender.country, sender.phone, sender.email,
            recipient.name, recipient.company, recipient.address1, recipient.address2,
            recipient.city, recipient.state, recipient.postalCode, recipient.country, recipient.phone, recipient.email,
            JSON.stringify(parcels), totalWeight, reference, JSON.stringify(options || {})
        ]);

        const shipment = result.rows[0];

        // Generate label (mock)
        shipment.labelUrl = `/api/v1/shipments/${shipment.id}/label`;

        // Emit event for webhooks
        await emitWebhookEvent(req.orgId, 'shipment.created', shipment);

        res.status(201).json(shipment);
    } catch (error) {
        console.error('Error creating shipment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/v1/shipments/:id', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM shipments WHERE id = $1 AND organization_id = $2',
            [req.params.id, req.orgId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shipment not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching shipment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/v1/shipments/:id', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM shipments WHERE id = $1 AND organization_id = $2',
            [req.params.id, req.orgId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shipment not found' });
        }

        const shipment = result.rows[0];

        if (shipment.status !== 'pending') {
            return res.status(400).json({ error: 'Shipment cannot be cancelled - already shipped' });
        }

        await db.query(
            'UPDATE shipments SET status = $1, updated_at = NOW() WHERE id = $2',
            ['cancelled', req.params.id]
        );

        res.json({ message: 'Shipment cancelled successfully' });
    } catch (error) {
        console.error('Error cancelling shipment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/v1/shipments/:id/label', authenticate, async (req, res) => {
    try {
        const { format = 'pdf' } = req.query;
        
        const result = await db.query(
            'SELECT * FROM shipments WHERE id = $1 AND organization_id = $2',
            [req.params.id, req.orgId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Shipment not found' });
        }

        // Mock label generation
        const label = generateMockLabel(result.rows[0], format);
        
        const contentTypes = {
            pdf: 'application/pdf',
            zpl: 'application/zpl',
            png: 'image/png'
        };

        res.setHeader('Content-Type', contentTypes[format] || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="label-${result.rows[0].tracking_number}.${format}"`);
        res.send(label);
    } catch (error) {
        console.error('Error generating label:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// TRACKING API
// ==========================================

app.get('/api/v1/tracking/:trackingNumber', authenticate, async (req, res) => {
    try {
        const { trackingNumber } = req.params;

        // Check cache first
        const cached = await redis.get(`tracking:${trackingNumber}`);
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const result = await db.query(
            'SELECT * FROM shipments WHERE tracking_number = $1',
            [trackingNumber]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Tracking number not found' });
        }

        const shipment = result.rows[0];

        const trackingInfo = {
            trackingNumber: shipment.tracking_number,
            carrier: shipment.carrier,
            status: shipment.status,
            statusLabel: getStatusLabel(shipment.status),
            estimatedDelivery: shipment.estimated_delivery,
            lastLocation: shipment.last_location,
            events: shipment.tracking_events || generateMockTrackingEvents(shipment)
        };

        // Cache for 5 minutes
        await redis.setex(`tracking:${trackingNumber}`, 300, JSON.stringify(trackingInfo));

        res.json(trackingInfo);
    } catch (error) {
        console.error('Error fetching tracking:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/tracking/batch', authenticate, async (req, res) => {
    try {
        const { trackingNumbers } = req.body;

        if (!trackingNumbers || trackingNumbers.length > 100) {
            return res.status(422).json({ error: 'Maximum 100 tracking numbers allowed' });
        }

        const results = await Promise.all(
            trackingNumbers.map(async (tn) => {
                const result = await db.query(
                    'SELECT * FROM shipments WHERE tracking_number = $1',
                    [tn]
                );
                if (result.rows.length === 0) {
                    return { trackingNumber: tn, error: 'Not found' };
                }
                const shipment = result.rows[0];
                return {
                    trackingNumber: shipment.tracking_number,
                    carrier: shipment.carrier,
                    status: shipment.status,
                    statusLabel: getStatusLabel(shipment.status)
                };
            })
        );

        res.json(results);
    } catch (error) {
        console.error('Error batch tracking:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// ORDERS API
// ==========================================

app.get('/api/v1/orders', authenticate, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, source } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM orders WHERE organization_id = $1';
        const params = [req.orgId];
        let paramCount = 1;

        if (status) {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(status);
        }

        if (source) {
            paramCount++;
            query += ` AND source = $${paramCount}`;
            params.push(source);
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(limit, offset);

        const result = await db.query(query, params);
        
        res.json({
            data: result.rows,
            pagination: { page: parseInt(page), limit: parseInt(limit) }
        });
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/orders', authenticate, async (req, res) => {
    try {
        const { orderNumber, customer, items, shippingAddress, total } = req.body;

        const result = await db.query(`
            INSERT INTO orders (id, organization_id, order_number, source, status, 
                customer_name, customer_email, shipping_address, items, total)
            VALUES ($1, $2, $3, 'api', 'pending', $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            uuidv4(), req.orgId, orderNumber,
            customer.name, customer.email,
            JSON.stringify(shippingAddress), JSON.stringify(items), total
        ]);

        await emitWebhookEvent(req.orgId, 'order.created', result.rows[0]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/orders/:orderId/ship', authenticate, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { carrier, service, warehouseId } = req.body;

        const orderResult = await db.query(
            'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
            [orderId, req.orgId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult.rows[0];
        const shippingAddress = order.shipping_address;

        // Create shipment from order
        const trackingNumber = generateTrackingNumber(carrier);

        const shipmentResult = await db.query(`
            INSERT INTO shipments (id, organization_id, order_id, tracking_number, carrier, service, status,
                recipient_name, recipient_address1, recipient_city, recipient_postal_code, recipient_country)
            VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11)
            RETURNING *
        `, [
            uuidv4(), req.orgId, orderId, trackingNumber, carrier, service || 'standard',
            shippingAddress.name, shippingAddress.address1, shippingAddress.city,
            shippingAddress.postalCode, shippingAddress.country
        ]);

        // Update order status
        await db.query(
            'UPDATE orders SET status = $1, shipped_at = NOW() WHERE id = $2',
            ['shipped', orderId]
        );

        await emitWebhookEvent(req.orgId, 'order.shipped', { order, shipment: shipmentResult.rows[0] });

        res.json(shipmentResult.rows[0]);
    } catch (error) {
        console.error('Error shipping order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// RETURNS API
// ==========================================

app.get('/api/v1/returns', authenticate, async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM returns WHERE organization_id = $1';
        const params = [req.orgId];

        if (status) {
            query += ' AND status = $2';
            params.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await db.query(query, params);
        res.json({ data: result.rows });
    } catch (error) {
        console.error('Error fetching returns:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/returns', authenticate, async (req, res) => {
    try {
        const { orderId, items, reason, comments } = req.body;

        const validReasons = ['SIZE_TOO_SMALL', 'SIZE_TOO_LARGE', 'WRONG_ITEM', 'DEFECTIVE', 
                            'DAMAGED_SHIPPING', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'OTHER'];

        if (!validReasons.includes(reason)) {
            return res.status(422).json({ error: 'Invalid return reason' });
        }

        // Check order exists
        const orderResult = await db.query(
            'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
            [orderId, req.orgId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const rmaNumber = `RMA-${Date.now().toString(36).toUpperCase()}`;

        const result = await db.query(`
            INSERT INTO returns (id, organization_id, order_id, rma_number, status, reason_code, reason_text, items)
            VALUES ($1, $2, $3, $4, 'pending_approval', $5, $6, $7)
            RETURNING *
        `, [uuidv4(), req.orgId, orderId, rmaNumber, reason, comments, JSON.stringify(items)]);

        await emitWebhookEvent(req.orgId, 'return.created', result.rows[0]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating return:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/returns/:returnId/approve', authenticate, async (req, res) => {
    try {
        const { returnId } = req.params;
        const { generateLabel = true, carrier = 'colissimo' } = req.body;

        const result = await db.query(
            'SELECT * FROM returns WHERE id = $1 AND organization_id = $2',
            [returnId, req.orgId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Return not found' });
        }

        let trackingNumber = null;
        if (generateLabel) {
            trackingNumber = generateTrackingNumber(carrier);
        }

        await db.query(`
            UPDATE returns SET status = 'approved', approved_at = NOW(), 
                return_carrier = $1, return_tracking_number = $2
            WHERE id = $3
        `, [carrier, trackingNumber, returnId]);

        const updated = await db.query('SELECT * FROM returns WHERE id = $1', [returnId]);

        await emitWebhookEvent(req.orgId, 'return.approved', updated.rows[0]);

        res.json(updated.rows[0]);
    } catch (error) {
        console.error('Error approving return:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/returns/:returnId/refund', authenticate, async (req, res) => {
    try {
        const { returnId } = req.params;
        const { amount, method } = req.body;

        const result = await db.query(
            'SELECT * FROM returns WHERE id = $1 AND organization_id = $2',
            [returnId, req.orgId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Return not found' });
        }

        const returnItem = result.rows[0];

        if (!['received', 'inspecting', 'approved'].includes(returnItem.status)) {
            return res.status(400).json({ error: 'Return must be received before refund' });
        }

        await db.query(`
            UPDATE returns SET status = 'refunded', refund_amount = $1, refund_method = $2, 
                refund_status = 'completed', refunded_at = NOW()
            WHERE id = $3
        `, [amount, method, returnId]);

        const updated = await db.query('SELECT * FROM returns WHERE id = $1', [returnId]);

        await emitWebhookEvent(req.orgId, 'return.refunded', updated.rows[0]);

        res.json(updated.rows[0]);
    } catch (error) {
        console.error('Error processing refund:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// CARRIERS API
// ==========================================

app.get('/api/v1/carriers', authenticate, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM carriers WHERE active = true');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching carriers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/carriers/rates', authenticate, async (req, res) => {
    try {
        const { origin, destination, parcels } = req.body;

        // Mock rate calculation
        const carriers = await db.query('SELECT * FROM carriers WHERE active = true');
        
        const rates = carriers.rows.map(carrier => {
            const basePrice = getBasePrice(carrier.id);
            const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
            const price = basePrice + (weight * 0.5);

            return {
                carrier: carrier.id,
                carrierName: carrier.name,
                service: 'standard',
                price: Math.round(price * 100) / 100,
                currency: 'EUR',
                estimatedDays: getEstimatedDays(carrier.id)
            };
        });

        res.json(rates.sort((a, b) => a.price - b.price));
    } catch (error) {
        console.error('Error calculating rates:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/carriers/recommend', authenticate, async (req, res) => {
    try {
        const carrierAI = new CarrierSelectionAI({ db });
        const recommendation = await carrierAI.recommendCarrier({
            ...req.body,
            orgId: req.orgId
        });

        res.json(recommendation);
    } catch (error) {
        console.error('Error getting recommendation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// ANALYTICS API
// ==========================================

app.get('/api/v1/analytics/dashboard', authenticate, async (req, res) => {
    try {
        const { period = '30d' } = req.query;
        const days = parseInt(period) || 30;

        const [shipments, orders, returns, carriers] = await Promise.all([
            db.query(`
                SELECT COUNT(*) as total,
                    COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
                    COUNT(CASE WHEN status = 'exception' THEN 1 END) as exceptions,
                    AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as avg_days
                FROM shipments 
                WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
            `, [req.orgId]),
            db.query(`
                SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
                FROM orders WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
            `, [req.orgId]),
            db.query(`
                SELECT COUNT(*) as total FROM returns 
                WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
            `, [req.orgId]),
            db.query(`
                SELECT carrier, COUNT(*) as count FROM shipments 
                WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY carrier ORDER BY count DESC LIMIT 5
            `, [req.orgId])
        ]);

        const shipmentsData = shipments.rows[0];
        const deliveryRate = shipmentsData.total > 0 
            ? (shipmentsData.delivered / shipmentsData.total * 100).toFixed(1) 
            : 0;

        res.json({
            shipmentsTotal: parseInt(shipmentsData.total),
            deliveryRate: parseFloat(deliveryRate),
            avgDeliveryDays: parseFloat(shipmentsData.avg_days) || 0,
            exceptions: parseInt(shipmentsData.exceptions),
            pendingOrders: parseInt(orders.rows[0].pending),
            totalOrders: parseInt(orders.rows[0].total),
            totalReturns: parseInt(returns.rows[0].total),
            topCarriers: carriers.rows
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/v1/analytics/carriers', authenticate, async (req, res) => {
    try {
        const qosService = new QoSService({ db });
        const performance = await qosService.compareCarriers(req.orgId);
        res.json(performance);
    } catch (error) {
        console.error('Error fetching carrier analytics:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// WEBHOOKS API
// ==========================================

app.get('/api/v1/webhooks', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM webhooks WHERE organization_id = $1',
            [req.orgId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching webhooks:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/webhooks', authenticate, async (req, res) => {
    try {
        const { url, events } = req.body;
        const secret = `whsec_${uuidv4().replace(/-/g, '')}`;

        const result = await db.query(`
            INSERT INTO webhooks (id, organization_id, url, secret, events, active)
            VALUES ($1, $2, $3, $4, $5, true)
            RETURNING *
        `, [uuidv4(), req.orgId, url, secret, events]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// METRICS ENDPOINT (Prometheus)
// ==========================================

app.get('/api/v1/metrics', async (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(`
# HELP routz_shipments_total Total number of shipments
# TYPE routz_shipments_total counter
routz_shipments_total 0

# HELP routz_api_requests_total Total API requests
# TYPE routz_api_requests_total counter
routz_api_requests_total 0

# HELP routz_api_latency_seconds API latency
# TYPE routz_api_latency_seconds histogram
routz_api_latency_seconds_bucket{le="0.1"} 0
    `.trim());
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function generateTrackingNumber(carrier) {
    const prefixes = {
        colissimo: '6L',
        chronopost: 'XY',
        mondial_relay: 'MR',
        dhl: 'JJD',
        ups: '1Z',
        fedex: '7'
    };
    const prefix = prefixes[carrier] || 'RT';
    return `${prefix}${Math.random().toString().slice(2, 13)}`;
}

function getStatusLabel(status) {
    const labels = {
        pending: 'En attente',
        shipped: 'Expédié',
        in_transit: 'En transit',
        out_for_delivery: 'En cours de livraison',
        delivered: 'Livré',
        exception: 'Exception',
        returned: 'Retourné'
    };
    return labels[status] || status;
}

function getBasePrice(carrierId) {
    const prices = { colissimo: 4.95, chronopost: 9.90, mondial_relay: 3.50, dhl: 12.00, ups: 11.50, fedex: 13.00, gls: 5.50, dpd: 5.20 };
    return prices[carrierId] || 6.00;
}

function getEstimatedDays(carrierId) {
    const days = { colissimo: 3, chronopost: 1, mondial_relay: 5, dhl: 2, ups: 2, fedex: 2, gls: 3, dpd: 3 };
    return days[carrierId] || 3;
}

function generateMockLabel(shipment, format) {
    return Buffer.from(`Label for ${shipment.tracking_number}`);
}

function generateMockTrackingEvents(shipment) {
    return [
        { timestamp: shipment.created_at, status: 'created', description: 'Shipment created', location: 'Origin' },
        { timestamp: new Date().toISOString(), status: shipment.status, description: getStatusLabel(shipment.status), location: 'In transit' }
    ];
}

async function emitWebhookEvent(orgId, event, data) {
    try {
        const webhooks = await db.query(
            'SELECT * FROM webhooks WHERE organization_id = $1 AND active = true AND $2 = ANY(events)',
            [orgId, event]
        );

        for (const webhook of webhooks.rows) {
            // Queue webhook delivery
            await redis.lpush('webhook_queue', JSON.stringify({
                webhookId: webhook.id,
                url: webhook.url,
                secret: webhook.secret,
                event,
                data,
                timestamp: new Date().toISOString()
            }));
        }
    } catch (error) {
        console.error('Error emitting webhook:', error);
    }
}

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Routz API server running on port ${PORT}`);
    console.log(`📚 API Docs: http://localhost:${PORT}/docs`);
    console.log(`❤️  Health: http://localhost:${PORT}/health`);
});

module.exports = app;
