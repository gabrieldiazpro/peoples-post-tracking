/**
 * Routz v4.0 - E-commerce Connectors
 * Shopify, WooCommerce, PrestaShop, Magento
 */

const axios = require('axios');
const crypto = require('crypto');

// ==========================================
// BASE E-COMMERCE CONNECTOR
// ==========================================

class BaseEcommerceConnector {
    constructor(config) {
        this.config = config;
        this.storeUrl = config.storeUrl;
    }

    async request(method, endpoint, data = null, headers = {}) {
        try {
            const response = await axios({
                method,
                url: `${this.storeUrl}${endpoint}`,
                data,
                headers: { 'Content-Type': 'application/json', ...headers },
                timeout: 30000
            });
            return response.data;
        } catch (error) {
            throw new Error(`E-commerce API error: ${error.response?.data?.message || error.message}`);
        }
    }

    normalizeOrder(rawOrder) {
        throw new Error('normalizeOrder must be implemented');
    }

    normalizeProduct(rawProduct) {
        throw new Error('normalizeProduct must be implemented');
    }
}

// ==========================================
// SHOPIFY
// ==========================================

class ShopifyConnector extends BaseEcommerceConnector {
    constructor(config) {
        super(config);
        this.apiVersion = config.apiVersion || '2024-01';
        this.accessToken = config.accessToken;
        this.baseUrl = `${this.storeUrl}/admin/api/${this.apiVersion}`;
    }

    getHeaders() {
        return {
            'X-Shopify-Access-Token': this.accessToken,
            'Content-Type': 'application/json'
        };
    }

    async getOrders(params = {}) {
        const { status = 'any', limit = 50, since_id, created_at_min, created_at_max, fulfillment_status } = params;
        
        let url = `${this.baseUrl}/orders.json?status=${status}&limit=${limit}`;
        if (since_id) url += `&since_id=${since_id}`;
        if (created_at_min) url += `&created_at_min=${created_at_min}`;
        if (created_at_max) url += `&created_at_max=${created_at_max}`;
        if (fulfillment_status) url += `&fulfillment_status=${fulfillment_status}`;

        const response = await axios.get(url, { headers: this.getHeaders() });
        return response.data.orders.map(o => this.normalizeOrder(o));
    }

    async getOrder(orderId) {
        const response = await axios.get(
            `${this.baseUrl}/orders/${orderId}.json`,
            { headers: this.getHeaders() }
        );
        return this.normalizeOrder(response.data.order);
    }

    async createFulfillment(orderId, fulfillmentData) {
        const { trackingNumber, carrier, trackingUrl, lineItems } = fulfillmentData;
        
        const payload = {
            fulfillment: {
                tracking_number: trackingNumber,
                tracking_company: carrier,
                tracking_url: trackingUrl,
                notify_customer: true
            }
        };

        if (lineItems) {
            payload.fulfillment.line_items = lineItems.map(li => ({
                id: li.lineItemId,
                quantity: li.quantity
            }));
        }

        const response = await axios.post(
            `${this.baseUrl}/orders/${orderId}/fulfillments.json`,
            payload,
            { headers: this.getHeaders() }
        );

        return response.data.fulfillment;
    }

    async getProducts(params = {}) {
        const { limit = 50, since_id, collection_id } = params;
        
        let url = `${this.baseUrl}/products.json?limit=${limit}`;
        if (since_id) url += `&since_id=${since_id}`;
        if (collection_id) url += `&collection_id=${collection_id}`;

        const response = await axios.get(url, { headers: this.getHeaders() });
        return response.data.products.map(p => this.normalizeProduct(p));
    }

    async updateInventory(inventoryItemId, locationId, quantity) {
        const response = await axios.post(
            `${this.baseUrl}/inventory_levels/set.json`,
            {
                inventory_item_id: inventoryItemId,
                location_id: locationId,
                available: quantity
            },
            { headers: this.getHeaders() }
        );
        return response.data.inventory_level;
    }

    async getLocations() {
        const response = await axios.get(
            `${this.baseUrl}/locations.json`,
            { headers: this.getHeaders() }
        );
        return response.data.locations;
    }

    normalizeOrder(order) {
        return {
            id: order.id.toString(),
            orderNumber: order.name || order.order_number?.toString(),
            externalId: order.id.toString(),
            source: 'shopify',
            status: this.mapOrderStatus(order),
            fulfillmentStatus: order.fulfillment_status || 'unfulfilled',
            financialStatus: order.financial_status,
            customer: {
                id: order.customer?.id?.toString(),
                name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
                email: order.customer?.email || order.email,
                phone: order.customer?.phone || order.phone
            },
            shippingAddress: order.shipping_address ? {
                name: order.shipping_address.name,
                company: order.shipping_address.company,
                address1: order.shipping_address.address1,
                address2: order.shipping_address.address2,
                city: order.shipping_address.city,
                state: order.shipping_address.province,
                postalCode: order.shipping_address.zip,
                country: order.shipping_address.country_code,
                phone: order.shipping_address.phone
            } : null,
            billingAddress: order.billing_address ? {
                name: order.billing_address.name,
                address1: order.billing_address.address1,
                city: order.billing_address.city,
                postalCode: order.billing_address.zip,
                country: order.billing_address.country_code
            } : null,
            items: order.line_items.map(li => ({
                id: li.id.toString(),
                sku: li.sku,
                name: li.name,
                quantity: li.quantity,
                price: parseFloat(li.price),
                weight: li.grams / 1000,
                variantId: li.variant_id?.toString(),
                productId: li.product_id?.toString()
            })),
            subtotal: parseFloat(order.subtotal_price),
            shippingCost: parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0),
            tax: parseFloat(order.total_tax),
            total: parseFloat(order.total_price),
            currency: order.currency,
            notes: order.note,
            tags: order.tags ? order.tags.split(',').map(t => t.trim()) : [],
            createdAt: order.created_at,
            updatedAt: order.updated_at
        };
    }

    normalizeProduct(product) {
        return {
            id: product.id.toString(),
            name: product.title,
            description: product.body_html,
            vendor: product.vendor,
            productType: product.product_type,
            status: product.status,
            tags: product.tags ? product.tags.split(',').map(t => t.trim()) : [],
            variants: product.variants.map(v => ({
                id: v.id.toString(),
                sku: v.sku,
                name: v.title,
                price: parseFloat(v.price),
                compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
                weight: v.weight,
                weightUnit: v.weight_unit,
                inventoryItemId: v.inventory_item_id?.toString(),
                inventoryQuantity: v.inventory_quantity,
                barcode: v.barcode
            })),
            images: product.images.map(img => ({
                id: img.id.toString(),
                src: img.src,
                position: img.position
            })),
            createdAt: product.created_at,
            updatedAt: product.updated_at
        };
    }

    mapOrderStatus(order) {
        if (order.cancelled_at) return 'cancelled';
        if (order.fulfillment_status === 'fulfilled') return 'shipped';
        if (order.financial_status === 'paid') return 'processing';
        return 'pending';
    }

    // Webhook verification
    verifyWebhook(body, hmacHeader) {
        const hash = crypto
            .createHmac('sha256', this.config.webhookSecret)
            .update(body, 'utf8')
            .digest('base64');
        return hash === hmacHeader;
    }
}

// ==========================================
// WOOCOMMERCE
// ==========================================

class WooCommerceConnector extends BaseEcommerceConnector {
    constructor(config) {
        super(config);
        this.consumerKey = config.consumerKey;
        this.consumerSecret = config.consumerSecret;
        this.baseUrl = `${this.storeUrl}/wp-json/wc/v3`;
    }

    getAuth() {
        return {
            username: this.consumerKey,
            password: this.consumerSecret
        };
    }

    async getOrders(params = {}) {
        const { status, per_page = 50, page = 1, after, before } = params;
        
        let url = `${this.baseUrl}/orders?per_page=${per_page}&page=${page}`;
        if (status) url += `&status=${status}`;
        if (after) url += `&after=${after}`;
        if (before) url += `&before=${before}`;

        const response = await axios.get(url, { auth: this.getAuth() });
        return response.data.map(o => this.normalizeOrder(o));
    }

    async getOrder(orderId) {
        const response = await axios.get(
            `${this.baseUrl}/orders/${orderId}`,
            { auth: this.getAuth() }
        );
        return this.normalizeOrder(response.data);
    }

    async updateOrder(orderId, data) {
        const response = await axios.put(
            `${this.baseUrl}/orders/${orderId}`,
            data,
            { auth: this.getAuth() }
        );
        return this.normalizeOrder(response.data);
    }

    async addOrderNote(orderId, note, customerNote = false) {
        const response = await axios.post(
            `${this.baseUrl}/orders/${orderId}/notes`,
            { note, customer_note: customerNote },
            { auth: this.getAuth() }
        );
        return response.data;
    }

    async markAsShipped(orderId, trackingNumber, carrier) {
        // Update order status and add tracking note
        await this.updateOrder(orderId, { status: 'completed' });
        await this.addOrderNote(
            orderId,
            `Shipped via ${carrier}. Tracking: ${trackingNumber}`,
            true
        );
    }

    async getProducts(params = {}) {
        const { per_page = 50, page = 1, category, status } = params;
        
        let url = `${this.baseUrl}/products?per_page=${per_page}&page=${page}`;
        if (category) url += `&category=${category}`;
        if (status) url += `&status=${status}`;

        const response = await axios.get(url, { auth: this.getAuth() });
        return response.data.map(p => this.normalizeProduct(p));
    }

    async updateStock(productId, quantity, variationId = null) {
        const endpoint = variationId
            ? `${this.baseUrl}/products/${productId}/variations/${variationId}`
            : `${this.baseUrl}/products/${productId}`;

        const response = await axios.put(
            endpoint,
            { stock_quantity: quantity, manage_stock: true },
            { auth: this.getAuth() }
        );
        return response.data;
    }

    normalizeOrder(order) {
        return {
            id: order.id.toString(),
            orderNumber: order.number?.toString() || order.id.toString(),
            externalId: order.id.toString(),
            source: 'woocommerce',
            status: this.mapOrderStatus(order.status),
            customer: {
                id: order.customer_id?.toString(),
                name: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim(),
                email: order.billing?.email,
                phone: order.billing?.phone
            },
            shippingAddress: order.shipping ? {
                name: `${order.shipping.first_name} ${order.shipping.last_name}`.trim(),
                company: order.shipping.company,
                address1: order.shipping.address_1,
                address2: order.shipping.address_2,
                city: order.shipping.city,
                state: order.shipping.state,
                postalCode: order.shipping.postcode,
                country: order.shipping.country,
                phone: order.shipping.phone
            } : null,
            items: order.line_items.map(li => ({
                id: li.id.toString(),
                sku: li.sku,
                name: li.name,
                quantity: li.quantity,
                price: parseFloat(li.price),
                productId: li.product_id?.toString(),
                variationId: li.variation_id?.toString()
            })),
            subtotal: parseFloat(order.subtotal || 0),
            shippingCost: parseFloat(order.shipping_total || 0),
            tax: parseFloat(order.total_tax || 0),
            total: parseFloat(order.total),
            currency: order.currency,
            paymentMethod: order.payment_method_title,
            notes: order.customer_note,
            createdAt: order.date_created,
            updatedAt: order.date_modified
        };
    }

    normalizeProduct(product) {
        return {
            id: product.id.toString(),
            sku: product.sku,
            name: product.name,
            description: product.description,
            shortDescription: product.short_description,
            status: product.status,
            price: parseFloat(product.price || 0),
            regularPrice: parseFloat(product.regular_price || 0),
            salePrice: product.sale_price ? parseFloat(product.sale_price) : null,
            stockQuantity: product.stock_quantity,
            stockStatus: product.stock_status,
            manageStock: product.manage_stock,
            weight: product.weight ? parseFloat(product.weight) : null,
            dimensions: {
                length: product.dimensions?.length,
                width: product.dimensions?.width,
                height: product.dimensions?.height
            },
            categories: product.categories?.map(c => ({ id: c.id.toString(), name: c.name })) || [],
            images: product.images?.map(img => ({ id: img.id.toString(), src: img.src })) || [],
            variations: product.variations || [],
            createdAt: product.date_created,
            updatedAt: product.date_modified
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'pending': 'pending',
            'processing': 'processing',
            'on-hold': 'pending',
            'completed': 'shipped',
            'cancelled': 'cancelled',
            'refunded': 'refunded',
            'failed': 'cancelled'
        };
        return statusMap[status] || 'pending';
    }
}

// ==========================================
// PRESTASHOP
// ==========================================

class PrestaShopConnector extends BaseEcommerceConnector {
    constructor(config) {
        super(config);
        this.apiKey = config.apiKey;
        this.baseUrl = `${this.storeUrl}/api`;
    }

    getHeaders() {
        const auth = Buffer.from(`${this.apiKey}:`).toString('base64');
        return {
            'Authorization': `Basic ${auth}`,
            'Output-Format': 'JSON'
        };
    }

    async getOrders(params = {}) {
        const { limit = 50, filter_state } = params;
        
        let url = `${this.baseUrl}/orders?display=full&limit=${limit}`;
        if (filter_state) url += `&filter[current_state]=${filter_state}`;

        const response = await axios.get(url, { headers: this.getHeaders() });
        const orders = response.data.orders || [];
        return orders.map(o => this.normalizeOrder(o));
    }

    async getOrder(orderId) {
        const response = await axios.get(
            `${this.baseUrl}/orders/${orderId}?display=full`,
            { headers: this.getHeaders() }
        );
        return this.normalizeOrder(response.data.order);
    }

    async updateOrderStatus(orderId, statusId) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
            <prestashop>
                <order>
                    <id>${orderId}</id>
                    <current_state>${statusId}</current_state>
                </order>
            </prestashop>`;

        const response = await axios.put(
            `${this.baseUrl}/orders/${orderId}`,
            xml,
            { headers: { ...this.getHeaders(), 'Content-Type': 'text/xml' } }
        );
        return response.data;
    }

    async addTracking(orderId, carrier, trackingNumber) {
        // PrestaShop uses order_carrier for tracking
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
            <prestashop>
                <order_carrier>
                    <id_order>${orderId}</id_order>
                    <tracking_number>${trackingNumber}</tracking_number>
                </order_carrier>
            </prestashop>`;

        const response = await axios.post(
            `${this.baseUrl}/order_carriers`,
            xml,
            { headers: { ...this.getHeaders(), 'Content-Type': 'text/xml' } }
        );
        return response.data;
    }

    async getProducts(params = {}) {
        const { limit = 50, active = 1 } = params;
        
        const url = `${this.baseUrl}/products?display=full&limit=${limit}&filter[active]=${active}`;
        const response = await axios.get(url, { headers: this.getHeaders() });
        const products = response.data.products || [];
        return products.map(p => this.normalizeProduct(p));
    }

    async updateStock(productId, quantity, combinationId = null) {
        const url = combinationId
            ? `${this.baseUrl}/stock_availables?filter[id_product]=${productId}&filter[id_product_attribute]=${combinationId}`
            : `${this.baseUrl}/stock_availables?filter[id_product]=${productId}&filter[id_product_attribute]=0`;

        // First get the stock available ID
        const getResponse = await axios.get(url, { headers: this.getHeaders() });
        const stockId = getResponse.data.stock_availables?.[0]?.id;

        if (stockId) {
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
                <prestashop>
                    <stock_available>
                        <id>${stockId}</id>
                        <quantity>${quantity}</quantity>
                    </stock_available>
                </prestashop>`;

            await axios.put(
                `${this.baseUrl}/stock_availables/${stockId}`,
                xml,
                { headers: { ...this.getHeaders(), 'Content-Type': 'text/xml' } }
            );
        }
    }

    normalizeOrder(order) {
        return {
            id: order.id?.toString(),
            orderNumber: order.reference || order.id?.toString(),
            externalId: order.id?.toString(),
            source: 'prestashop',
            status: this.mapOrderStatus(order.current_state),
            customer: {
                id: order.id_customer?.toString(),
                name: `${order.firstname || ''} ${order.lastname || ''}`.trim(),
                email: order.email
            },
            shippingAddress: order.id_address_delivery ? {
                name: `${order.address_delivery?.firstname || ''} ${order.address_delivery?.lastname || ''}`.trim(),
                company: order.address_delivery?.company,
                address1: order.address_delivery?.address1,
                address2: order.address_delivery?.address2,
                city: order.address_delivery?.city,
                postalCode: order.address_delivery?.postcode,
                country: order.address_delivery?.country,
                phone: order.address_delivery?.phone
            } : null,
            items: (order.associations?.order_rows || []).map(li => ({
                id: li.id?.toString(),
                sku: li.product_reference,
                name: li.product_name,
                quantity: parseInt(li.product_quantity),
                price: parseFloat(li.product_price),
                productId: li.product_id?.toString()
            })),
            total: parseFloat(order.total_paid || 0),
            currency: order.id_currency?.toString(),
            paymentMethod: order.payment,
            createdAt: order.date_add,
            updatedAt: order.date_upd
        };
    }

    normalizeProduct(product) {
        return {
            id: product.id?.toString(),
            sku: product.reference,
            name: product.name?.[0]?.value || product.name,
            description: product.description?.[0]?.value || '',
            price: parseFloat(product.price || 0),
            active: product.active === '1',
            quantity: parseInt(product.quantity || 0),
            weight: parseFloat(product.weight || 0),
            createdAt: product.date_add,
            updatedAt: product.date_upd
        };
    }

    mapOrderStatus(stateId) {
        // PrestaShop default states
        const statusMap = {
            1: 'pending',      // Awaiting check payment
            2: 'pending',      // Payment accepted
            3: 'processing',   // Processing in progress
            4: 'shipped',      // Shipped
            5: 'delivered',    // Delivered
            6: 'cancelled',    // Canceled
            7: 'refunded'      // Refunded
        };
        return statusMap[parseInt(stateId)] || 'pending';
    }
}

// ==========================================
// MAGENTO 2
// ==========================================

class MagentoConnector extends BaseEcommerceConnector {
    constructor(config) {
        super(config);
        this.accessToken = config.accessToken;
        this.baseUrl = `${this.storeUrl}/rest/V1`;
    }

    getHeaders() {
        return {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
        };
    }

    async getOrders(params = {}) {
        const { pageSize = 50, currentPage = 1, status } = params;
        
        let url = `${this.baseUrl}/orders?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${currentPage}`;
        if (status) {
            url += `&searchCriteria[filter_groups][0][filters][0][field]=status&searchCriteria[filter_groups][0][filters][0][value]=${status}`;
        }

        const response = await axios.get(url, { headers: this.getHeaders() });
        return response.data.items.map(o => this.normalizeOrder(o));
    }

    async getOrder(orderId) {
        const response = await axios.get(
            `${this.baseUrl}/orders/${orderId}`,
            { headers: this.getHeaders() }
        );
        return this.normalizeOrder(response.data);
    }

    async createShipment(orderId, items, trackingNumber, carrier) {
        const payload = {
            items: items.map(item => ({
                order_item_id: item.orderItemId,
                qty: item.quantity
            })),
            tracks: [{
                track_number: trackingNumber,
                title: carrier,
                carrier_code: carrier.toLowerCase().replace(/\s+/g, '_')
            }],
            notify: true
        };

        const response = await axios.post(
            `${this.baseUrl}/order/${orderId}/ship`,
            payload,
            { headers: this.getHeaders() }
        );
        return response.data;
    }

    async getProducts(params = {}) {
        const { pageSize = 50, currentPage = 1 } = params;
        
        const url = `${this.baseUrl}/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${currentPage}`;
        const response = await axios.get(url, { headers: this.getHeaders() });
        return response.data.items.map(p => this.normalizeProduct(p));
    }

    async updateStock(sku, quantity, sourceCode = 'default') {
        const response = await axios.put(
            `${this.baseUrl}/inventory/source-items`,
            {
                sourceItems: [{
                    sku,
                    source_code: sourceCode,
                    quantity,
                    status: quantity > 0 ? 1 : 0
                }]
            },
            { headers: this.getHeaders() }
        );
        return response.data;
    }

    normalizeOrder(order) {
        const shippingAddress = order.extension_attributes?.shipping_assignments?.[0]?.shipping?.address;
        
        return {
            id: order.entity_id?.toString(),
            orderNumber: order.increment_id,
            externalId: order.entity_id?.toString(),
            source: 'magento',
            status: this.mapOrderStatus(order.status),
            customer: {
                id: order.customer_id?.toString(),
                name: `${order.customer_firstname || ''} ${order.customer_lastname || ''}`.trim(),
                email: order.customer_email
            },
            shippingAddress: shippingAddress ? {
                name: `${shippingAddress.firstname} ${shippingAddress.lastname}`.trim(),
                company: shippingAddress.company,
                address1: shippingAddress.street?.[0],
                address2: shippingAddress.street?.[1],
                city: shippingAddress.city,
                state: shippingAddress.region,
                postalCode: shippingAddress.postcode,
                country: shippingAddress.country_id,
                phone: shippingAddress.telephone
            } : null,
            items: order.items.map(li => ({
                id: li.item_id?.toString(),
                sku: li.sku,
                name: li.name,
                quantity: li.qty_ordered,
                price: parseFloat(li.price),
                productId: li.product_id?.toString()
            })),
            subtotal: parseFloat(order.subtotal || 0),
            shippingCost: parseFloat(order.shipping_amount || 0),
            tax: parseFloat(order.tax_amount || 0),
            total: parseFloat(order.grand_total),
            currency: order.order_currency_code,
            createdAt: order.created_at,
            updatedAt: order.updated_at
        };
    }

    normalizeProduct(product) {
        return {
            id: product.id?.toString(),
            sku: product.sku,
            name: product.name,
            status: product.status === 1 ? 'active' : 'inactive',
            price: parseFloat(product.price || 0),
            weight: product.weight ? parseFloat(product.weight) : null,
            typeId: product.type_id,
            createdAt: product.created_at,
            updatedAt: product.updated_at
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'pending': 'pending',
            'pending_payment': 'pending',
            'processing': 'processing',
            'complete': 'shipped',
            'closed': 'delivered',
            'canceled': 'cancelled',
            'holded': 'pending'
        };
        return statusMap[status] || 'pending';
    }
}

// ==========================================
// E-COMMERCE SERVICE
// ==========================================

class EcommerceService {
    constructor() {
        this.connectors = {};
    }

    registerStore(storeId, connector) {
        this.connectors[storeId] = connector;
    }

    getStore(storeId) {
        return this.connectors[storeId];
    }

    async syncOrders(storeId, params = {}) {
        const store = this.getStore(storeId);
        if (!store) throw new Error(`Store ${storeId} not configured`);
        return store.getOrders(params);
    }

    async markAsShipped(storeId, orderId, trackingNumber, carrier) {
        const store = this.getStore(storeId);
        if (!store) throw new Error(`Store ${storeId} not configured`);
        
        if (store.createFulfillment) {
            return store.createFulfillment(orderId, { trackingNumber, carrier });
        } else if (store.markAsShipped) {
            return store.markAsShipped(orderId, trackingNumber, carrier);
        }
        throw new Error('Store does not support fulfillment');
    }

    async updateStock(storeId, productId, quantity, variantId = null) {
        const store = this.getStore(storeId);
        if (!store) throw new Error(`Store ${storeId} not configured`);
        return store.updateStock(productId, quantity, variantId);
    }
}

module.exports = {
    BaseEcommerceConnector,
    ShopifyConnector,
    WooCommerceConnector,
    PrestaShopConnector,
    MagentoConnector,
    EcommerceService
};
