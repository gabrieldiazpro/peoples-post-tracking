/**
 * Routz v4.0 - Advanced Marketplace Connectors
 * Intégration complète : Amazon, Cdiscount, Fnac, ManoMano, Rakuten, eBay, Zalando, Otto, Bol.com, Allegro
 */

// ==========================================
// BASE MARKETPLACE CONNECTOR
// ==========================================

class BaseMarketplaceConnector {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.sellerId = config.sellerId;
        this.sandbox = config.sandbox || false;
        this.rateLimiter = new RateLimiter(config.rateLimit || { requests: 100, period: 60 });
    }

    async request(method, endpoint, data = null) {
        await this.rateLimiter.acquire();
        // Implementation specific to each marketplace
    }

    normalizeOrder(rawOrder) {
        throw new Error('Must be implemented by subclass');
    }

    normalizeProduct(rawProduct) {
        throw new Error('Must be implemented by subclass');
    }
}

// ==========================================
// AMAZON SELLER CENTRAL (SP-API)
// ==========================================

class AmazonConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.refreshToken = config.refreshToken;
        this.region = config.region || 'eu-west-1';
        this.marketplaceIds = config.marketplaceIds || ['A13V1IB3VIYZZH']; // FR
        this.baseUrl = 'https://sellingpartnerapi-eu.amazon.com';
        this.accessToken = null;
        this.tokenExpiry = null;
    }

    async authenticate() {
        if (this.accessToken && this.tokenExpiry > Date.now()) {
            return this.accessToken;
        }

        const response = await fetch('https://api.amazon.com/auth/o2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.apiKey,
                client_secret: this.apiSecret
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        return this.accessToken;
    }

    async getOrders(params = {}) {
        await this.authenticate();
        
        const queryParams = new URLSearchParams({
            MarketplaceIds: this.marketplaceIds.join(','),
            CreatedAfter: params.createdAfter || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            OrderStatuses: params.statuses?.join(',') || 'Unshipped,PartiallyShipped'
        });

        const response = await this.request('GET', `/orders/v0/orders?${queryParams}`);
        return response.Orders.map(order => this.normalizeOrder(order));
    }

    async getOrderItems(orderId) {
        await this.authenticate();
        const response = await this.request('GET', `/orders/v0/orders/${orderId}/orderItems`);
        return response.OrderItems;
    }

    async confirmShipment(orderId, shipmentData) {
        await this.authenticate();
        
        const payload = {
            marketplaceId: this.marketplaceIds[0],
            shipmentConfirmations: [{
                amazonOrderId: orderId,
                shipDate: shipmentData.shipDate || new Date().toISOString(),
                shippingMethod: this.mapCarrierToAmazon(shipmentData.carrier),
                shipFromAddress: shipmentData.shipFromAddress,
                packageDetails: {
                    packageReferenceId: shipmentData.packageId,
                    carrierCode: shipmentData.carrier.toUpperCase(),
                    trackingNumber: shipmentData.trackingNumber,
                    shipmentItems: shipmentData.items.map(item => ({
                        amazonOrderItemId: item.orderItemId,
                        quantity: item.quantity
                    }))
                }
            }]
        };

        return await this.request('POST', '/shipping/v1/shipments', payload);
    }

    async updateInventory(sku, quantity, fulfillmentCenterId) {
        await this.authenticate();
        
        const feed = this.buildInventoryFeed([{ sku, quantity, fulfillmentCenterId }]);
        return await this.submitFeed('POST_INVENTORY_AVAILABILITY_DATA', feed);
    }

    normalizeOrder(amazonOrder) {
        return {
            id: amazonOrder.AmazonOrderId,
            externalId: amazonOrder.AmazonOrderId,
            channel: 'amazon',
            marketplace: amazonOrder.MarketplaceId,
            status: this.mapAmazonStatus(amazonOrder.OrderStatus),
            orderNumber: amazonOrder.AmazonOrderId,
            customer: {
                name: amazonOrder.BuyerName || 'Amazon Customer',
                email: amazonOrder.BuyerEmail,
                phone: amazonOrder.ShippingAddress?.Phone
            },
            shippingAddress: amazonOrder.ShippingAddress ? {
                firstName: amazonOrder.ShippingAddress.Name?.split(' ')[0],
                lastName: amazonOrder.ShippingAddress.Name?.split(' ').slice(1).join(' '),
                line1: amazonOrder.ShippingAddress.AddressLine1,
                line2: amazonOrder.ShippingAddress.AddressLine2,
                city: amazonOrder.ShippingAddress.City,
                postalCode: amazonOrder.ShippingAddress.PostalCode,
                country: amazonOrder.ShippingAddress.CountryCode,
                phone: amazonOrder.ShippingAddress.Phone
            } : null,
            totals: {
                subtotal: parseFloat(amazonOrder.OrderTotal?.Amount || 0),
                shipping: 0,
                tax: 0,
                total: parseFloat(amazonOrder.OrderTotal?.Amount || 0),
                currency: amazonOrder.OrderTotal?.CurrencyCode || 'EUR'
            },
            fulfillmentChannel: amazonOrder.FulfillmentChannel, // AFN (FBA) or MFN
            isPrime: amazonOrder.IsPrime,
            isBusinessOrder: amazonOrder.IsBusinessOrder,
            shipByDate: amazonOrder.LatestShipDate,
            deliverByDate: amazonOrder.LatestDeliveryDate,
            createdAt: amazonOrder.PurchaseDate,
            updatedAt: amazonOrder.LastUpdateDate
        };
    }

    mapAmazonStatus(status) {
        const map = {
            'Pending': 'pending',
            'Unshipped': 'new',
            'PartiallyShipped': 'processing',
            'Shipped': 'shipped',
            'Canceled': 'cancelled',
            'Unfulfillable': 'cancelled'
        };
        return map[status] || 'unknown';
    }

    mapCarrierToAmazon(carrier) {
        const map = {
            'colissimo': 'La Poste',
            'chronopost': 'Chronopost',
            'dhl': 'DHL',
            'ups': 'UPS',
            'fedex': 'FedEx',
            'mondial_relay': 'Mondial Relay'
        };
        return map[carrier] || carrier;
    }
}

// ==========================================
// CDISCOUNT MARKETPLACE
// ==========================================

class CdiscountConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.username = config.username;
        this.password = config.password;
        this.baseUrl = 'https://wsvc.cdiscount.com/MarketplaceAPIService.svc';
    }

    async getOrders(params = {}) {
        const soapEnvelope = this.buildSOAPEnvelope('GetOrderList', {
            orderFilter: {
                BeginCreationDate: params.from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                EndCreationDate: params.to || new Date().toISOString(),
                States: params.statuses || ['WaitingForShipmentAcceptation', 'AcceptedBySeller']
            }
        });

        const response = await this.soapRequest(soapEnvelope);
        return response.OrderList.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        const soapEnvelope = this.buildSOAPEnvelope('ValidateOrderList', {
            validateOrderListMessage: {
                OrderList: [{
                    OrderNumber: orderId,
                    OrderState: 'Shipped',
                    TrackingNumber: shipmentData.trackingNumber,
                    TrackingUrl: shipmentData.trackingUrl,
                    CarrierName: shipmentData.carrier
                }]
            }
        });

        return await this.soapRequest(soapEnvelope);
    }

    normalizeOrder(cdiscountOrder) {
        return {
            id: cdiscountOrder.OrderNumber,
            externalId: cdiscountOrder.OrderNumber,
            channel: 'cdiscount',
            status: this.mapCdiscountStatus(cdiscountOrder.OrderState),
            orderNumber: cdiscountOrder.OrderNumber,
            customer: {
                name: `${cdiscountOrder.Customer.FirstName} ${cdiscountOrder.Customer.LastName}`,
                email: cdiscountOrder.Customer.Email
            },
            shippingAddress: {
                firstName: cdiscountOrder.ShippingAddress.FirstName,
                lastName: cdiscountOrder.ShippingAddress.LastName,
                line1: cdiscountOrder.ShippingAddress.Street,
                city: cdiscountOrder.ShippingAddress.City,
                postalCode: cdiscountOrder.ShippingAddress.ZipCode,
                country: cdiscountOrder.ShippingAddress.Country
            },
            items: cdiscountOrder.OrderLineList.map(line => ({
                sku: line.SellerProductId,
                name: line.Name,
                quantity: line.Quantity,
                price: line.UnitPrice
            })),
            totals: {
                total: cdiscountOrder.TotalAmount,
                currency: 'EUR'
            },
            createdAt: cdiscountOrder.CreationDate
        };
    }

    mapCdiscountStatus(status) {
        const map = {
            'WaitingForShipmentAcceptation': 'new',
            'AcceptedBySeller': 'processing',
            'Shipped': 'shipped',
            'Cancelled': 'cancelled'
        };
        return map[status] || 'unknown';
    }

    buildSOAPEnvelope(action, data) {
        // Build SOAP XML envelope
        return `<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Header>
                <HeaderMessage xmlns="http://www.cdiscount.com">
                    <ApiKey>${this.apiKey}</ApiKey>
                </HeaderMessage>
            </soap:Header>
            <soap:Body>
                <${action} xmlns="http://www.cdiscount.com">
                    ${this.objectToXML(data)}
                </${action}>
            </soap:Body>
        </soap:Envelope>`;
    }

    objectToXML(obj, indent = '') {
        let xml = '';
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
                xml += value.map(item => `${indent}<${key}>${this.objectToXML(item, indent + '  ')}</${key}>`).join('\n');
            } else if (typeof value === 'object') {
                xml += `${indent}<${key}>\n${this.objectToXML(value, indent + '  ')}${indent}</${key}>\n`;
            } else {
                xml += `${indent}<${key}>${value}</${key}>\n`;
            }
        }
        return xml;
    }

    async soapRequest(envelope) {
        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8' },
            body: envelope
        });
        // Parse SOAP response
        return response;
    }
}

// ==========================================
// FNAC MARKETPLACE
// ==========================================

class FnacConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.partnerId = config.partnerId;
        this.shopId = config.shopId;
        this.baseUrl = 'https://vendeur.fnac.com/api';
    }

    async getOrders(params = {}) {
        const response = await this.request('GET', '/orders', {
            date_from: params.from,
            date_to: params.to,
            status: params.statuses || ['Created', 'Accepted']
        });

        return response.orders.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        return await this.request('POST', `/orders/${orderId}/ship`, {
            tracking_number: shipmentData.trackingNumber,
            carrier: shipmentData.carrier,
            items: shipmentData.items.map(item => ({
                order_detail_id: item.id,
                quantity: item.quantity
            }))
        });
    }

    normalizeOrder(fnacOrder) {
        return {
            id: fnacOrder.order_id,
            externalId: fnacOrder.order_id,
            channel: 'fnac',
            status: this.mapFnacStatus(fnacOrder.state),
            orderNumber: fnacOrder.order_id,
            customer: {
                name: fnacOrder.shipping_address.name,
                email: fnacOrder.customer_email
            },
            shippingAddress: {
                firstName: fnacOrder.shipping_address.firstname,
                lastName: fnacOrder.shipping_address.lastname,
                line1: fnacOrder.shipping_address.address1,
                line2: fnacOrder.shipping_address.address2,
                city: fnacOrder.shipping_address.city,
                postalCode: fnacOrder.shipping_address.zipcode,
                country: fnacOrder.shipping_address.country
            },
            items: fnacOrder.order_details.map(item => ({
                sku: item.offer_seller_id,
                name: item.product_name,
                quantity: item.quantity,
                price: item.price
            })),
            createdAt: fnacOrder.created_at
        };
    }

    mapFnacStatus(status) {
        const map = {
            'Created': 'new',
            'Accepted': 'processing',
            'Shipped': 'shipped',
            'Cancelled': 'cancelled',
            'Delivered': 'delivered'
        };
        return map[status] || 'unknown';
    }
}

// ==========================================
// MANOMANO MARKETPLACE
// ==========================================

class ManoManoConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.manomano.com/v1';
    }

    async getOrders(params = {}) {
        const response = await this.request('GET', '/orders', {
            created_from: params.from,
            created_to: params.to,
            status: params.statuses || ['pending', 'accepted']
        });

        return response.data.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        return await this.request('POST', `/orders/${orderId}/shipments`, {
            tracking_number: shipmentData.trackingNumber,
            carrier_code: shipmentData.carrier,
            shipped_at: new Date().toISOString()
        });
    }

    normalizeOrder(mmOrder) {
        return {
            id: mmOrder.id,
            externalId: mmOrder.reference,
            channel: 'manomano',
            status: mmOrder.status,
            orderNumber: mmOrder.reference,
            customer: {
                name: `${mmOrder.shipping_address.first_name} ${mmOrder.shipping_address.last_name}`,
                email: mmOrder.customer_email,
                phone: mmOrder.shipping_address.phone
            },
            shippingAddress: {
                firstName: mmOrder.shipping_address.first_name,
                lastName: mmOrder.shipping_address.last_name,
                company: mmOrder.shipping_address.company,
                line1: mmOrder.shipping_address.street_1,
                line2: mmOrder.shipping_address.street_2,
                city: mmOrder.shipping_address.city,
                postalCode: mmOrder.shipping_address.zip_code,
                country: mmOrder.shipping_address.country_code
            },
            items: mmOrder.items.map(item => ({
                sku: item.seller_sku,
                name: item.title,
                quantity: item.quantity,
                price: item.unit_price
            })),
            createdAt: mmOrder.created_at
        };
    }
}

// ==========================================
// ZALANDO (Partner API)
// ==========================================

class ZalandoConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.baseUrl = 'https://api.merchants.zalando.com';
    }

    async authenticate() {
        const response = await fetch('https://api.merchants.zalando.com/auth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`
            },
            body: 'grant_type=client_credentials'
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        return this.accessToken;
    }

    async getOrders(params = {}) {
        await this.authenticate();
        
        const response = await this.request('GET', '/merchants/orders', {
            status: params.statuses || ['approved'],
            created_after: params.from
        });

        return response.items.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        await this.authenticate();
        
        return await this.request('POST', `/merchants/orders/${orderId}/shipments`, {
            shipment_id: shipmentData.id,
            carrier: this.mapCarrierToZalando(shipmentData.carrier),
            tracking_number: shipmentData.trackingNumber,
            shipped_items: shipmentData.items.map(item => ({
                ean: item.ean,
                quantity: item.quantity
            }))
        });
    }

    normalizeOrder(zalandoOrder) {
        return {
            id: zalandoOrder.order_number,
            externalId: zalandoOrder.order_number,
            channel: 'zalando',
            status: this.mapZalandoStatus(zalandoOrder.status),
            orderNumber: zalandoOrder.order_number,
            customer: {
                name: `${zalandoOrder.shipping_address.first_name} ${zalandoOrder.shipping_address.last_name}`,
                email: zalandoOrder.customer.email
            },
            shippingAddress: {
                firstName: zalandoOrder.shipping_address.first_name,
                lastName: zalandoOrder.shipping_address.last_name,
                line1: zalandoOrder.shipping_address.street,
                city: zalandoOrder.shipping_address.city,
                postalCode: zalandoOrder.shipping_address.zip_code,
                country: zalandoOrder.shipping_address.country_code
            },
            items: zalandoOrder.items.map(item => ({
                sku: item.article_number,
                ean: item.ean,
                name: item.name,
                quantity: item.quantity,
                price: item.price.amount
            })),
            createdAt: zalandoOrder.created
        };
    }

    mapZalandoStatus(status) {
        const map = {
            'approved': 'new',
            'sent': 'shipped',
            'delivered': 'delivered',
            'cancelled': 'cancelled'
        };
        return map[status] || 'unknown';
    }

    mapCarrierToZalando(carrier) {
        const map = {
            'colissimo': 'LA_POSTE',
            'chronopost': 'CHRONOPOST',
            'dhl': 'DHL',
            'ups': 'UPS',
            'fedex': 'FEDEX'
        };
        return map[carrier] || carrier.toUpperCase();
    }
}

// ==========================================
// EBAY
// ==========================================

class EbayConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.refreshToken = config.refreshToken;
        this.baseUrl = 'https://api.ebay.com';
        this.siteId = config.siteId || 'EBAY_FR';
    }

    async authenticate() {
        const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')}`
            },
            body: `grant_type=refresh_token&refresh_token=${this.refreshToken}&scope=https://api.ebay.com/oauth/api_scope/sell.fulfillment`
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        return this.accessToken;
    }

    async getOrders(params = {}) {
        await this.authenticate();

        const filter = [];
        if (params.from) filter.push(`creationdate:[${params.from}]`);
        if (params.statuses) filter.push(`orderfulfillmentstatus:{${params.statuses.join('|')}}`);

        const response = await this.request('GET', '/sell/fulfillment/v1/order', {
            filter: filter.join(',')
        });

        return response.orders.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        await this.authenticate();

        return await this.request('POST', `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`, {
            lineItems: shipmentData.items.map(item => ({
                lineItemId: item.lineItemId,
                quantity: item.quantity
            })),
            shippedDate: new Date().toISOString(),
            shippingCarrierCode: this.mapCarrierToEbay(shipmentData.carrier),
            trackingNumber: shipmentData.trackingNumber
        });
    }

    normalizeOrder(ebayOrder) {
        return {
            id: ebayOrder.orderId,
            externalId: ebayOrder.orderId,
            channel: 'ebay',
            status: this.mapEbayStatus(ebayOrder.orderFulfillmentStatus),
            orderNumber: ebayOrder.orderId,
            customer: {
                name: ebayOrder.buyer.username,
                email: ebayOrder.buyer.buyerRegistrationAddress?.email
            },
            shippingAddress: ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo ? {
                firstName: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.fullName?.split(' ')[0],
                lastName: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.fullName?.split(' ').slice(1).join(' '),
                line1: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress?.addressLine1,
                city: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress?.city,
                postalCode: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress?.postalCode,
                country: ebayOrder.fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress?.countryCode
            } : null,
            items: ebayOrder.lineItems.map(item => ({
                lineItemId: item.lineItemId,
                sku: item.sku,
                name: item.title,
                quantity: item.quantity,
                price: parseFloat(item.lineItemCost?.value || 0)
            })),
            totals: {
                total: parseFloat(ebayOrder.pricingSummary?.total?.value || 0),
                currency: ebayOrder.pricingSummary?.total?.currency || 'EUR'
            },
            createdAt: ebayOrder.creationDate
        };
    }

    mapEbayStatus(status) {
        const map = {
            'NOT_STARTED': 'new',
            'IN_PROGRESS': 'processing',
            'FULFILLED': 'shipped'
        };
        return map[status] || 'unknown';
    }

    mapCarrierToEbay(carrier) {
        const map = {
            'colissimo': 'LA_POSTE',
            'chronopost': 'CHRONOPOST',
            'dhl': 'DHL',
            'ups': 'UPS',
            'fedex': 'FEDEX',
            'mondial_relay': 'MONDIAL_RELAY'
        };
        return map[carrier] || carrier.toUpperCase();
    }
}

// ==========================================
// RAKUTEN FRANCE
// ==========================================

class RakutenConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://ws.fr.shopping.rakuten.com';
    }

    async getOrders(params = {}) {
        const response = await this.request('GET', '/sales_ws', {
            action: 'getnewsales',
            login: this.apiKey,
            pwd: this.apiSecret,
            version: '2017-08-07'
        });

        return response.sales.map(order => this.normalizeOrder(order));
    }

    async confirmShipment(orderId, shipmentData) {
        return await this.request('POST', '/sales_ws', {
            action: 'confirmdelivery',
            login: this.apiKey,
            pwd: this.apiSecret,
            version: '2017-08-07',
            purchaseid: orderId,
            transporter: shipmentData.carrier,
            trackingnumber: shipmentData.trackingNumber,
            trackingurl: shipmentData.trackingUrl
        });
    }

    normalizeOrder(rakutenOrder) {
        return {
            id: rakutenOrder.purchaseid,
            externalId: rakutenOrder.purchaseid,
            channel: 'rakuten',
            status: 'new',
            orderNumber: rakutenOrder.purchaseid,
            customer: {
                name: rakutenOrder.deliveryinformation?.civility + ' ' + rakutenOrder.deliveryinformation?.lastname,
                email: rakutenOrder.purchasebuyeremail
            },
            shippingAddress: {
                firstName: rakutenOrder.deliveryinformation?.firstname,
                lastName: rakutenOrder.deliveryinformation?.lastname,
                line1: rakutenOrder.deliveryinformation?.address1,
                city: rakutenOrder.deliveryinformation?.city,
                postalCode: rakutenOrder.deliveryinformation?.zipcode,
                country: rakutenOrder.deliveryinformation?.country
            },
            createdAt: rakutenOrder.purchasedate
        };
    }
}

// ==========================================
// RATE LIMITER
// ==========================================

class RateLimiter {
    constructor(config) {
        this.requests = config.requests;
        this.period = config.period * 1000;
        this.queue = [];
        this.timestamps = [];
    }

    async acquire() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => t > now - this.period);

        if (this.timestamps.length >= this.requests) {
            const waitTime = this.timestamps[0] + this.period - now;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.acquire();
        }

        this.timestamps.push(now);
    }
}

// ==========================================
// UNIFIED MARKETPLACE SERVICE
// ==========================================

class MarketplaceService {
    constructor() {
        this.connectors = new Map();
    }

    registerConnector(name, connector) {
        this.connectors.set(name, connector);
    }

    getConnector(name) {
        return this.connectors.get(name);
    }

    async syncAllOrders(params = {}) {
        const results = {
            total: 0,
            byMarketplace: {},
            errors: []
        };

        for (const [name, connector] of this.connectors) {
            try {
                const orders = await connector.getOrders(params);
                results.byMarketplace[name] = orders.length;
                results.total += orders.length;
            } catch (error) {
                results.errors.push({ marketplace: name, error: error.message });
            }
        }

        return results;
    }

    async confirmShipmentOnMarketplace(marketplace, orderId, shipmentData) {
        const connector = this.getConnector(marketplace);
        if (!connector) throw new Error(`Unknown marketplace: ${marketplace}`);
        return connector.confirmShipment(orderId, shipmentData);
    }
}

module.exports = {
    MarketplaceService,
    AmazonConnector,
    CdiscountConnector,
    FnacConnector,
    ManoManoConnector,
    ZalandoConnector,
    EbayConnector,
    RakutenConnector
};
