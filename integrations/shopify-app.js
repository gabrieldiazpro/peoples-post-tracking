/**
 * ROUTZ - Shopify App
 * Application officielle Routz pour Shopify
 * Intégration complète: fulfillment, tracking, retours, points relais
 */

// ============================================
// SHOPIFY APP CONFIGURATION
// ============================================

const SHOPIFY_APP_CONFIG = {
    name: 'Routz Shipping',
    handle: 'routz-shipping',
    version: '1.0.0',
    
    // Scopes required
    scopes: [
        'read_orders',
        'write_orders',
        'read_products',
        'read_inventory',
        'write_inventory',
        'read_locations',
        'read_fulfillments',
        'write_fulfillments',
        'read_shipping',
        'write_shipping',
        'read_customers',
        'read_checkouts',
        'write_checkouts'
    ],
    
    // Webhooks
    webhooks: [
        { topic: 'orders/create', path: '/webhooks/orders/create' },
        { topic: 'orders/updated', path: '/webhooks/orders/updated' },
        { topic: 'orders/cancelled', path: '/webhooks/orders/cancelled' },
        { topic: 'fulfillments/create', path: '/webhooks/fulfillments/create' },
        { topic: 'fulfillments/update', path: '/webhooks/fulfillments/update' },
        { topic: 'app/uninstalled', path: '/webhooks/app/uninstalled' }
    ],
    
    // Carrier Service
    carrierService: {
        name: 'Routz Shipping Rates',
        callback_url: '/carrier_service/callback',
        service_discovery: true
    }
};

// ============================================
// SHOPIFY APP SERVER
// ============================================

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

class ShopifyApp {
    constructor(config = {}) {
        this.config = {
            apiKey: process.env.SHOPIFY_API_KEY,
            apiSecret: process.env.SHOPIFY_API_SECRET,
            scopes: SHOPIFY_APP_CONFIG.scopes,
            hostName: process.env.SHOPIFY_APP_HOST,
            ...config
        };
        
        this.router = express.Router();
        this.setupRoutes();
    }

    // ----------------------------------------
    // OAUTH & INSTALLATION
    // ----------------------------------------

    setupRoutes() {
        // OAuth flow
        this.router.get('/auth', this.handleAuth.bind(this));
        this.router.get('/auth/callback', this.handleAuthCallback.bind(this));
        
        // Webhooks
        this.router.post('/webhooks/:topic', this.verifyWebhook.bind(this), this.handleWebhook.bind(this));
        
        // Carrier Service
        this.router.post('/carrier_service/callback', this.handleCarrierServiceCallback.bind(this));
        
        // App Bridge endpoints
        this.router.get('/api/shop', this.requireSession.bind(this), this.getShopInfo.bind(this));
        this.router.get('/api/orders', this.requireSession.bind(this), this.getOrders.bind(this));
        this.router.post('/api/orders/:id/fulfill', this.requireSession.bind(this), this.fulfillOrder.bind(this));
        this.router.get('/api/settings', this.requireSession.bind(this), this.getSettings.bind(this));
        this.router.put('/api/settings', this.requireSession.bind(this), this.updateSettings.bind(this));
        
        // Tracking page proxy
        this.router.get('/pages/tracking', this.trackingPage.bind(this));
        
        // Returns portal proxy  
        this.router.get('/pages/returns', this.returnsPortal.bind(this));
    }

    async handleAuth(req, res) {
        const { shop } = req.query;
        
        if (!shop) {
            return res.status(400).send('Missing shop parameter');
        }

        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = `https://${this.config.hostName}/shopify/auth/callback`;
        const scopes = this.config.scopes.join(',');

        // Store state for verification
        await db.query(
            'INSERT INTO shopify_oauth_states (state, shop, created_at) VALUES ($1, $2, NOW())',
            [state, shop]
        );

        const authUrl = `https://${shop}/admin/oauth/authorize?` +
            `client_id=${this.config.apiKey}&` +
            `scope=${scopes}&` +
            `redirect_uri=${encodeURIComponent(redirectUri)}&` +
            `state=${state}`;

        res.redirect(authUrl);
    }

    async handleAuthCallback(req, res) {
        const { shop, code, state, hmac } = req.query;

        // Verify state
        const stateResult = await db.query(
            'SELECT * FROM shopify_oauth_states WHERE state = $1 AND shop = $2',
            [state, shop]
        );

        if (stateResult.rows.length === 0) {
            return res.status(403).send('Invalid state parameter');
        }

        // Verify HMAC
        if (!this.verifyHmac(req.query)) {
            return res.status(403).send('Invalid HMAC');
        }

        // Exchange code for access token
        const accessTokenResponse = await axios.post(
            `https://${shop}/admin/oauth/access_token`,
            {
                client_id: this.config.apiKey,
                client_secret: this.config.apiSecret,
                code
            }
        );

        const { access_token, scope } = accessTokenResponse.data;

        // Store shop credentials
        await this.saveShopCredentials(shop, access_token, scope);

        // Register webhooks
        await this.registerWebhooks(shop, access_token);

        // Register carrier service
        await this.registerCarrierService(shop, access_token);

        // Clean up state
        await db.query('DELETE FROM shopify_oauth_states WHERE state = $1', [state]);

        // Redirect to app
        res.redirect(`https://${shop}/admin/apps/${SHOPIFY_APP_CONFIG.handle}`);
    }

    async saveShopCredentials(shop, accessToken, scope) {
        // Create or get organization
        let orgResult = await db.query(
            'SELECT id FROM organizations WHERE shopify_domain = $1',
            [shop]
        );

        let orgId;
        if (orgResult.rows.length === 0) {
            // Create new organization
            const newOrg = await db.query(`
                INSERT INTO organizations (name, shopify_domain, created_at)
                VALUES ($1, $2, NOW())
                RETURNING id
            `, [shop.replace('.myshopify.com', ''), shop]);
            orgId = newOrg.rows[0].id;
        } else {
            orgId = orgResult.rows[0].id;
        }

        // Store credentials (encrypted in production)
        await db.query(`
            INSERT INTO shopify_shops (
                shop_domain, organization_id, access_token, scope, installed_at
            ) VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (shop_domain) DO UPDATE SET
                access_token = EXCLUDED.access_token,
                scope = EXCLUDED.scope,
                updated_at = NOW()
        `, [shop, orgId, accessToken, scope]);
    }

    async registerWebhooks(shop, accessToken) {
        const client = this.createShopifyClient(shop, accessToken);

        for (const webhook of SHOPIFY_APP_CONFIG.webhooks) {
            try {
                await client.post('/webhooks.json', {
                    webhook: {
                        topic: webhook.topic,
                        address: `https://${this.config.hostName}/shopify${webhook.path}`,
                        format: 'json'
                    }
                });
            } catch (error) {
                console.error(`Failed to register webhook ${webhook.topic}:`, error.message);
            }
        }
    }

    async registerCarrierService(shop, accessToken) {
        const client = this.createShopifyClient(shop, accessToken);

        try {
            await client.post('/carrier_services.json', {
                carrier_service: {
                    name: SHOPIFY_APP_CONFIG.carrierService.name,
                    callback_url: `https://${this.config.hostName}/shopify/carrier_service/callback`,
                    service_discovery: true
                }
            });
        } catch (error) {
            console.error('Failed to register carrier service:', error.message);
        }
    }

    // ----------------------------------------
    // WEBHOOKS
    // ----------------------------------------

    verifyWebhook(req, res, next) {
        const hmac = req.get('X-Shopify-Hmac-Sha256');
        const body = req.rawBody || JSON.stringify(req.body);
        
        const hash = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(body, 'utf8')
            .digest('base64');

        if (hash !== hmac) {
            return res.status(401).send('Invalid webhook signature');
        }

        next();
    }

    async handleWebhook(req, res) {
        const topic = req.params.topic;
        const shop = req.get('X-Shopify-Shop-Domain');
        const data = req.body;

        console.log(`Received webhook: ${topic} from ${shop}`);

        try {
            switch (topic) {
                case 'orders/create':
                    await this.handleOrderCreate(shop, data);
                    break;
                case 'orders/updated':
                    await this.handleOrderUpdate(shop, data);
                    break;
                case 'orders/cancelled':
                    await this.handleOrderCancel(shop, data);
                    break;
                case 'fulfillments/create':
                    await this.handleFulfillmentCreate(shop, data);
                    break;
                case 'fulfillments/update':
                    await this.handleFulfillmentUpdate(shop, data);
                    break;
                case 'app/uninstalled':
                    await this.handleAppUninstall(shop);
                    break;
            }

            res.status(200).send('OK');
        } catch (error) {
            console.error(`Webhook error (${topic}):`, error);
            res.status(500).send('Error processing webhook');
        }
    }

    async handleOrderCreate(shop, orderData) {
        const shopInfo = await this.getShopByDomain(shop);
        if (!shopInfo) return;

        // Import order to Routz
        const order = {
            organization_id: shopInfo.organization_id,
            external_id: orderData.id.toString(),
            external_platform: 'shopify',
            order_number: orderData.name,
            
            // Customer
            customer_email: orderData.email,
            customer_name: `${orderData.shipping_address?.first_name || ''} ${orderData.shipping_address?.last_name || ''}`.trim(),
            customer_phone: orderData.shipping_address?.phone,
            
            // Shipping address
            shipping_address: {
                name: `${orderData.shipping_address?.first_name} ${orderData.shipping_address?.last_name}`,
                company: orderData.shipping_address?.company,
                address1: orderData.shipping_address?.address1,
                address2: orderData.shipping_address?.address2,
                city: orderData.shipping_address?.city,
                province: orderData.shipping_address?.province,
                postalCode: orderData.shipping_address?.zip,
                country: orderData.shipping_address?.country_code,
                phone: orderData.shipping_address?.phone
            },
            
            // Items
            items: orderData.line_items.map(item => ({
                external_id: item.id.toString(),
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                price: parseFloat(item.price),
                weight: item.grams / 1000, // Convert to kg
                variant_id: item.variant_id?.toString()
            })),
            
            // Totals
            subtotal: parseFloat(orderData.subtotal_price),
            shipping_cost: parseFloat(orderData.total_shipping_price_set?.shop_money?.amount || 0),
            total: parseFloat(orderData.total_price),
            currency: orderData.currency,
            
            // Weight
            total_weight: orderData.total_weight ? orderData.total_weight / 1000 : null,
            
            // Status
            status: orderData.fulfillment_status === 'fulfilled' ? 'fulfilled' : 'pending_fulfillment',
            financial_status: orderData.financial_status,
            
            // Shipping method
            shipping_method: orderData.shipping_lines?.[0]?.title,
            carrier: this.mapShippingCarrier(orderData.shipping_lines?.[0]),
            
            // Metadata
            tags: orderData.tags,
            note: orderData.note,
            
            created_at: orderData.created_at
        };

        await db.query(`
            INSERT INTO orders (
                organization_id, external_id, external_platform, order_number,
                customer_email, customer_name, customer_phone,
                shipping_address, items, subtotal, shipping_cost, total, currency,
                total_weight, status, financial_status, shipping_method, carrier,
                tags, note, external_created_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
            ON CONFLICT (organization_id, external_id, external_platform) DO UPDATE SET
                status = EXCLUDED.status,
                financial_status = EXCLUDED.financial_status,
                updated_at = NOW()
        `, [
            order.organization_id, order.external_id, order.external_platform, order.order_number,
            order.customer_email, order.customer_name, order.customer_phone,
            JSON.stringify(order.shipping_address), JSON.stringify(order.items),
            order.subtotal, order.shipping_cost, order.total, order.currency,
            order.total_weight, order.status, order.financial_status,
            order.shipping_method, order.carrier, order.tags, order.note, order.created_at
        ]);
    }

    async handleOrderUpdate(shop, orderData) {
        const shopInfo = await this.getShopByDomain(shop);
        if (!shopInfo) return;

        await db.query(`
            UPDATE orders SET
                status = $1,
                financial_status = $2,
                updated_at = NOW()
            WHERE organization_id = $3 
            AND external_id = $4 
            AND external_platform = 'shopify'
        `, [
            orderData.fulfillment_status === 'fulfilled' ? 'fulfilled' : 
            orderData.fulfillment_status === 'partial' ? 'partially_fulfilled' : 'pending_fulfillment',
            orderData.financial_status,
            shopInfo.organization_id,
            orderData.id.toString()
        ]);
    }

    async handleOrderCancel(shop, orderData) {
        const shopInfo = await this.getShopByDomain(shop);
        if (!shopInfo) return;

        await db.query(`
            UPDATE orders SET
                status = 'cancelled',
                cancelled_at = NOW(),
                updated_at = NOW()
            WHERE organization_id = $1 
            AND external_id = $2 
            AND external_platform = 'shopify'
        `, [shopInfo.organization_id, orderData.id.toString()]);
    }

    async handleFulfillmentCreate(shop, data) {
        // Update shipment tracking if fulfillment has tracking
        if (data.tracking_number) {
            const shopInfo = await this.getShopByDomain(shop);
            if (!shopInfo) return;

            // Find shipment and update
            await db.query(`
                UPDATE shipments SET
                    tracking_number = $1,
                    carrier = $2,
                    external_fulfillment_id = $3,
                    updated_at = NOW()
                WHERE organization_id = $4
                AND order_id IN (
                    SELECT id FROM orders 
                    WHERE external_id = $5 AND external_platform = 'shopify'
                )
            `, [
                data.tracking_number,
                data.tracking_company,
                data.id.toString(),
                shopInfo.organization_id,
                data.order_id.toString()
            ]);
        }
    }

    async handleFulfillmentUpdate(shop, data) {
        // Similar to create
        await this.handleFulfillmentCreate(shop, data);
    }

    async handleAppUninstall(shop) {
        await db.query(`
            UPDATE shopify_shops SET
                uninstalled_at = NOW(),
                access_token = NULL
            WHERE shop_domain = $1
        `, [shop]);
    }

    // ----------------------------------------
    // CARRIER SERVICE (Shipping Rates)
    // ----------------------------------------

    async handleCarrierServiceCallback(req, res) {
        const { rate } = req.body;
        
        if (!rate) {
            return res.status(400).json({ rates: [] });
        }

        const shop = req.get('X-Shopify-Shop-Domain') || rate.origin?.company_name;
        const shopInfo = await this.getShopByDomain(shop);
        
        if (!shopInfo) {
            return res.json({ rates: [] });
        }

        try {
            // Get settings
            const settings = await this.getShopSettings(shopInfo.organization_id);
            
            // Calculate package weight
            const totalWeight = rate.items.reduce((sum, item) => {
                return sum + (item.grams / 1000) * item.quantity;
            }, 0) || 0.5;

            // Get cart value
            const cartValue = rate.items.reduce((sum, item) => {
                return sum + (item.price / 100) * item.quantity;
            }, 0);

            // Get dynamic checkout options
            const { DynamicCheckoutService } = require('./dynamic-checkout');
            const checkoutService = new DynamicCheckoutService();
            
            const options = await checkoutService.getShippingOptions({
                orgId: shopInfo.organization_id,
                country: rate.destination.country,
                postalCode: rate.destination.postal_code,
                city: rate.destination.city,
                weight: totalWeight,
                cartValue,
                includePickupPoints: settings.enable_pickup_points !== false
            });

            // Convert to Shopify format
            const shopifyRates = this.convertToShopifyRates(options, settings);

            res.json({ rates: shopifyRates });
        } catch (error) {
            console.error('Carrier service error:', error);
            res.json({ rates: [] });
        }
    }

    convertToShopifyRates(options, settings) {
        const rates = [];

        for (const group of Object.values(options.options || {})) {
            for (const option of group.options) {
                rates.push({
                    service_name: option.serviceName,
                    service_code: option.serviceId,
                    total_price: Math.round(option.price * 100).toString(), // In cents
                    currency: options.currency || 'EUR',
                    min_delivery_date: this.calculateDeliveryDate(option.deliveryDays.min),
                    max_delivery_date: this.calculateDeliveryDate(option.deliveryDays.max),
                    description: option.description || ''
                });
            }
        }

        // Sort by price
        rates.sort((a, b) => parseInt(a.total_price) - parseInt(b.total_price));

        return rates;
    }

    calculateDeliveryDate(days) {
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString();
    }

    // ----------------------------------------
    // APP API ENDPOINTS
    // ----------------------------------------

    async requireSession(req, res, next) {
        const shop = req.get('X-Shopify-Shop-Domain') || req.query.shop;
        
        if (!shop) {
            return res.status(401).json({ error: 'Missing shop' });
        }

        const shopInfo = await this.getShopByDomain(shop);
        
        if (!shopInfo || !shopInfo.access_token) {
            return res.status(401).json({ error: 'Shop not authenticated' });
        }

        req.shopInfo = shopInfo;
        req.shopifyClient = this.createShopifyClient(shop, shopInfo.access_token);
        next();
    }

    async getShopInfo(req, res) {
        try {
            const response = await req.shopifyClient.get('/shop.json');
            res.json(response.data.shop);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async getOrders(req, res) {
        try {
            const { status, limit = 50, page_info } = req.query;
            
            let url = `/orders.json?limit=${limit}&status=any`;
            if (status) url += `&fulfillment_status=${status}`;
            if (page_info) url += `&page_info=${page_info}`;

            const response = await req.shopifyClient.get(url);
            
            // Get Routz shipment info for orders
            const orderIds = response.data.orders.map(o => o.id.toString());
            const shipmentsResult = await db.query(`
                SELECT o.external_id, s.tracking_number, s.status, s.carrier
                FROM orders o
                LEFT JOIN shipments s ON s.order_id = o.id
                WHERE o.organization_id = $1 
                AND o.external_id = ANY($2)
                AND o.external_platform = 'shopify'
            `, [req.shopInfo.organization_id, orderIds]);

            const shipmentsMap = {};
            shipmentsResult.rows.forEach(row => {
                shipmentsMap[row.external_id] = {
                    tracking_number: row.tracking_number,
                    status: row.status,
                    carrier: row.carrier
                };
            });

            // Merge shipment info
            const enrichedOrders = response.data.orders.map(order => ({
                ...order,
                routz_shipment: shipmentsMap[order.id.toString()] || null
            }));

            res.json({ orders: enrichedOrders });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    async fulfillOrder(req, res) {
        const { id } = req.params;
        const { carrier, service, tracking_number, notify_customer } = req.body;

        try {
            // Get order from Shopify
            const orderResponse = await req.shopifyClient.get(`/orders/${id}.json`);
            const order = orderResponse.data.order;

            // Create shipment in Routz
            const { id: routzOrderId } = await db.query(`
                SELECT id FROM orders 
                WHERE organization_id = $1 
                AND external_id = $2 
                AND external_platform = 'shopify'
            `, [req.shopInfo.organization_id, id]).then(r => r.rows[0] || {});

            if (routzOrderId) {
                // Create shipment via Routz
                const shipmentResult = await db.query(`
                    INSERT INTO shipments (
                        organization_id, order_id, carrier, service,
                        recipient_name, recipient_address1, recipient_city,
                        recipient_postal_code, recipient_country, recipient_email,
                        status, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW())
                    RETURNING *
                `, [
                    req.shopInfo.organization_id,
                    routzOrderId,
                    carrier,
                    service,
                    `${order.shipping_address.first_name} ${order.shipping_address.last_name}`,
                    order.shipping_address.address1,
                    order.shipping_address.city,
                    order.shipping_address.zip,
                    order.shipping_address.country_code,
                    order.email
                ]);

                // Generate label via carrier API
                // const label = await generateLabel(shipmentResult.rows[0]);
            }

            // Create fulfillment in Shopify
            const fulfillmentResponse = await req.shopifyClient.post(
                `/orders/${id}/fulfillments.json`,
                {
                    fulfillment: {
                        location_id: order.fulfillments?.[0]?.location_id || order.location_id,
                        tracking_number,
                        tracking_company: this.mapCarrierToShopify(carrier),
                        notify_customer: notify_customer !== false
                    }
                }
            );

            res.json({
                success: true,
                fulfillment: fulfillmentResponse.data.fulfillment
            });
        } catch (error) {
            console.error('Fulfillment error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    async getSettings(req, res) {
        const settings = await this.getShopSettings(req.shopInfo.organization_id);
        res.json(settings);
    }

    async updateSettings(req, res) {
        const settings = req.body;
        
        await db.query(`
            INSERT INTO shopify_settings (organization_id, settings, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (organization_id) DO UPDATE SET
                settings = EXCLUDED.settings,
                updated_at = NOW()
        `, [req.shopInfo.organization_id, JSON.stringify(settings)]);

        res.json({ success: true, settings });
    }

    // ----------------------------------------
    // PAGES (Tracking & Returns)
    // ----------------------------------------

    async trackingPage(req, res) {
        const { tracking, order } = req.query;
        const shop = req.query.shop;

        if (!tracking && !order) {
            return res.send(this.renderTrackingSearchPage(shop));
        }

        // Redirect to Routz tracking page
        const trackingUrl = `${process.env.ROUTZ_BASE_URL}/t/${tracking}?shop=${shop}`;
        res.redirect(trackingUrl);
    }

    async returnsPortal(req, res) {
        const { order } = req.query;
        const shop = req.query.shop;

        const shopInfo = await this.getShopByDomain(shop);
        if (!shopInfo) {
            return res.status(404).send('Shop not found');
        }

        // Redirect to Routz returns portal
        const returnsUrl = `${process.env.ROUTZ_BASE_URL}/returns/${shopInfo.organization_id}?order=${order || ''}`;
        res.redirect(returnsUrl);
    }

    renderTrackingSearchPage(shop) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Suivi de commande</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); padding: 40px; max-width: 500px; width: 100%; }
        h1 { font-size: 24px; margin-bottom: 8px; }
        p { color: #666; margin-bottom: 24px; }
        .form-group { margin-bottom: 16px; }
        label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 8px; }
        input { width: 100%; padding: 14px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 16px; }
        input:focus { outline: none; border-color: #2563eb; }
        button { width: 100%; padding: 16px; background: #2563eb; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
        button:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📦 Suivre ma commande</h1>
        <p>Entrez votre numéro de suivi ou de commande</p>
        <form action="/pages/tracking" method="GET">
            <input type="hidden" name="shop" value="${shop}">
            <div class="form-group">
                <label for="tracking">Numéro de suivi</label>
                <input type="text" id="tracking" name="tracking" placeholder="Ex: 6A12345678901">
            </div>
            <button type="submit">Rechercher</button>
        </form>
    </div>
</body>
</html>`;
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    verifyHmac(query) {
        const { hmac, ...params } = query;
        const message = Object.keys(params)
            .sort()
            .map(key => `${key}=${params[key]}`)
            .join('&');
        
        const hash = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(message)
            .digest('hex');

        return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
    }

    createShopifyClient(shop, accessToken) {
        return axios.create({
            baseURL: `https://${shop}/admin/api/2024-01`,
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json'
            }
        });
    }

    async getShopByDomain(shop) {
        const result = await db.query(
            'SELECT * FROM shopify_shops WHERE shop_domain = $1',
            [shop]
        );
        return result.rows[0];
    }

    async getShopSettings(orgId) {
        const result = await db.query(
            'SELECT settings FROM shopify_settings WHERE organization_id = $1',
            [orgId]
        );
        return result.rows[0]?.settings 
            ? JSON.parse(result.rows[0].settings) 
            : this.getDefaultSettings();
    }

    getDefaultSettings() {
        return {
            auto_import_orders: true,
            auto_fulfill: false,
            default_carrier: 'colissimo',
            enable_pickup_points: true,
            enable_returns_portal: true,
            tracking_page_enabled: true,
            notify_customer_on_shipment: true,
            free_shipping_threshold: 50
        };
    }

    mapShippingCarrier(shippingLine) {
        if (!shippingLine) return null;
        
        const title = shippingLine.title?.toLowerCase() || '';
        const code = shippingLine.code?.toLowerCase() || '';
        
        if (title.includes('colissimo') || code.includes('colissimo')) return 'colissimo';
        if (title.includes('chronopost') || code.includes('chronopost')) return 'chronopost';
        if (title.includes('mondial relay') || code.includes('mondial')) return 'mondial_relay';
        if (title.includes('dpd')) return 'dpd';
        if (title.includes('gls')) return 'gls';
        if (title.includes('ups')) return 'ups';
        if (title.includes('fedex')) return 'fedex';
        if (title.includes('dhl')) return 'dhl';
        if (title.includes('point relais') || title.includes('pickup')) return 'mondial_relay';
        
        return null;
    }

    mapCarrierToShopify(carrier) {
        const mapping = {
            colissimo: 'La Poste',
            chronopost: 'Chronopost',
            mondial_relay: 'Mondial Relay',
            dpd: 'DPD',
            gls: 'GLS',
            ups: 'UPS',
            fedex: 'FedEx',
            dhl: 'DHL'
        };
        return mapping[carrier] || carrier;
    }

    getRouter() {
        return this.router;
    }
}

// ============================================
// SHOPIFY THEME EXTENSION (Liquid Snippets)
// ============================================

const THEME_SNIPPETS = {
    // Tracking page snippet
    'routz-tracking.liquid': `
{% comment %}
  Routz Tracking Widget
  Add this to a page template
{% endcomment %}

<div id="routz-tracking-widget" data-shop="{{ shop.permanent_domain }}"></div>

<script src="https://cdn.routz.io/shopify/tracking-widget.js" async></script>
<script>
  document.addEventListener('DOMContentLoaded', function() {
    RoutzTracking.init({
      shop: '{{ shop.permanent_domain }}',
      orderId: {{ order.id | default: 'null' }},
      tracking: '{{ order.fulfillments.first.tracking_number | default: "" }}'
    });
  });
</script>
`,

    // Pickup point selector for checkout
    'routz-pickup-selector.liquid': `
{% comment %}
  Routz Pickup Point Selector
  Add this to cart or checkout
{% endcomment %}

<div id="routz-pickup-selector" 
     data-shop="{{ shop.permanent_domain }}"
     data-postal-code="{{ customer.default_address.zip }}"
     data-country="{{ customer.default_address.country_code | default: 'FR' }}">
</div>

<script src="https://cdn.routz.io/shopify/pickup-selector.js" async></script>
`,

    // Order status page enhancement
    'routz-order-status.liquid': `
{% comment %}
  Routz Enhanced Order Status
  Add this to order status page
{% endcomment %}

{% if fulfillment.tracking_number %}
<div class="routz-tracking-info" 
     data-tracking="{{ fulfillment.tracking_number }}"
     data-carrier="{{ fulfillment.tracking_company }}">
  <iframe 
    src="https://track.routz.io/t/{{ fulfillment.tracking_number }}?embed=true&shop={{ shop.permanent_domain }}"
    width="100%" 
    height="400" 
    frameborder="0"
    style="border-radius: 12px;">
  </iframe>
</div>
{% endif %}
`
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
    ShopifyApp,
    SHOPIFY_APP_CONFIG,
    THEME_SNIPPETS
};
