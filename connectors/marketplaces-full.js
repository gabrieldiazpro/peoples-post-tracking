/**
 * Routz v4.0 - Marketplace Connectors
 * Intégrations complètes avec les principales marketplaces
 */

const crypto = require('crypto');

// ==========================================
// BASE MARKETPLACE CONNECTOR
// ==========================================

class BaseMarketplaceConnector {
    constructor(config) {
        this.config = config;
        this.baseUrl = '';
        this.rateLimiter = new RateLimiter(config.rateLimit || { requests: 100, period: 60 });
    }

    async request(method, endpoint, data = null, headers = {}) {
        await this.rateLimiter.acquire();
        
        const url = `${this.baseUrl}${endpoint}`;
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...this.getAuthHeaders(),
                ...headers
            },
            body: data ? JSON.stringify(data) : null
        });

        if (!response.ok) {
            throw new MarketplaceError(
                `${this.constructor.name} API Error: ${response.status}`,
                response.status,
                await response.text()
            );
        }

        return response.json();
    }

    getAuthHeaders() {
        throw new Error('Must implement getAuthHeaders');
    }

    // Méthodes à implémenter par chaque connector
    async getOrders(params) { throw new Error('Not implemented'); }
    async getOrder(orderId) { throw new Error('Not implemented'); }
    async acknowledgeOrder(orderId) { throw new Error('Not implemented'); }
    async shipOrder(orderId, shipmentData) { throw new Error('Not implemented'); }
    async cancelOrder(orderId, reason) { throw new Error('Not implemented'); }
    async getProducts(params) { throw new Error('Not implemented'); }
    async updateStock(sku, quantity) { throw new Error('Not implemented'); }
    async updatePrice(sku, price) { throw new Error('Not implemented'); }
}

// ==========================================
// AMAZON SELLER CENTRAL (SP-API)
// ==========================================

class AmazonConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = config.sandbox 
            ? 'https://sandbox.sellingpartnerapi-eu.amazon.com'
            : 'https://sellingpartnerapi-eu.amazon.com';
        this.refreshToken = config.refreshToken;
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.marketplaceId = config.marketplaceId || 'A13V1IB3VIYZZH'; // FR
        this.sellerId = config.sellerId;
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    async refreshAccessToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        const response = await fetch('https://api.amazon.com/auth/o2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        return this.accessToken;
    }

    getAuthHeaders() {
        return {
            'x-amz-access-token': this.accessToken,
            'x-amz-date': new Date().toISOString()
        };
    }

    async getOrders(params = {}) {
        await this.refreshAccessToken();
        
        const queryParams = new URLSearchParams({
            MarketplaceIds: this.marketplaceId,
            CreatedAfter: params.createdAfter || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            OrderStatuses: params.statuses?.join(',') || 'Unshipped,PartiallyShipped'
        });

        const data = await this.request('GET', `/orders/v0/orders?${queryParams}`);
        
        return data.payload.Orders.map(order => this.normalizeOrder(order));
    }

    async getOrder(orderId) {
        await this.refreshAccessToken();
        
        const orderData = await this.request('GET', `/orders/v0/orders/${orderId}`);
        const itemsData = await this.request('GET', `/orders/v0/orders/${orderId}/orderItems`);
        
        return this.normalizeOrder(orderData.payload, itemsData.payload.OrderItems);
    }

    normalizeOrder(amazonOrder, items = []) {
        return {
            id: amazonOrder.AmazonOrderId,
            externalId: amazonOrder.AmazonOrderId,
            channel: 'amazon',
            marketplace: 'amazon_fr',
            orderNumber: amazonOrder.AmazonOrderId,
            status: this.mapOrderStatus(amazonOrder.OrderStatus),
            fulfillmentChannel: amazonOrder.FulfillmentChannel, // AFN (FBA) or MFN
            customer: {
                name: amazonOrder.BuyerInfo?.BuyerName || 'Client Amazon',
                email: amazonOrder.BuyerInfo?.BuyerEmail,
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
            items: items.map(item => ({
                id: item.OrderItemId,
                sku: item.SellerSKU,
                asin: item.ASIN,
                name: item.Title,
                quantity: parseInt(item.QuantityOrdered),
                price: parseFloat(item.ItemPrice?.Amount || 0),
                tax: parseFloat(item.ItemTax?.Amount || 0)
            })),
            totals: {
                subtotal: parseFloat(amazonOrder.OrderTotal?.Amount || 0),
                shipping: 0,
                tax: 0,
                total: parseFloat(amazonOrder.OrderTotal?.Amount || 0),
                currency: amazonOrder.OrderTotal?.CurrencyCode || 'EUR'
            },
            shippingService: amazonOrder.ShipServiceLevel,
            latestDeliveryDate: amazonOrder.LatestDeliveryDate,
            earliestDeliveryDate: amazonOrder.EarliestDeliveryDate,
            isPrime: amazonOrder.IsPrime,
            isBusinessOrder: amazonOrder.IsBusinessOrder,
            createdAt: amazonOrder.PurchaseDate,
            updatedAt: amazonOrder.LastUpdateDate
        };
    }

    mapOrderStatus(amazonStatus) {
        const statusMap = {
            'Pending': 'pending',
            'Unshipped': 'new',
            'PartiallyShipped': 'processing',
            'Shipped': 'shipped',
            'Canceled': 'cancelled',
            'Unfulfillable': 'cancelled'
        };
        return statusMap[amazonStatus] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        await this.refreshAccessToken();

        const feedContent = this.buildShipmentFeed(orderId, shipmentData);
        
        // Créer le feed
        const createFeed = await this.request('POST', '/feeds/2021-06-30/feeds', {
            feedType: 'POST_ORDER_FULFILLMENT_DATA',
            marketplaceIds: [this.marketplaceId],
            inputFeedDocumentId: await this.uploadFeedDocument(feedContent)
        });

        return {
            feedId: createFeed.feedId,
            trackingNumber: shipmentData.trackingNumber,
            carrier: shipmentData.carrier
        };
    }

    buildShipmentFeed(orderId, shipmentData) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${this.sellerId}</MerchantIdentifier>
  </Header>
  <MessageType>OrderFulfillment</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OrderFulfillment>
      <AmazonOrderID>${orderId}</AmazonOrderID>
      <FulfillmentDate>${new Date().toISOString()}</FulfillmentDate>
      <FulfillmentData>
        <CarrierName>${shipmentData.carrierName || shipmentData.carrier}</CarrierName>
        <ShippingMethod>${shipmentData.service || 'Standard'}</ShippingMethod>
        <ShipperTrackingNumber>${shipmentData.trackingNumber}</ShipperTrackingNumber>
      </FulfillmentData>
    </OrderFulfillment>
  </Message>
</AmazonEnvelope>`;
    }

    async updateStock(sku, quantity, fulfillmentLatency = 1) {
        await this.refreshAccessToken();

        const feedContent = `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${this.sellerId}</MerchantIdentifier>
  </Header>
  <MessageType>Inventory</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <Inventory>
      <SKU>${sku}</SKU>
      <Quantity>${quantity}</Quantity>
      <FulfillmentLatency>${fulfillmentLatency}</FulfillmentLatency>
    </Inventory>
  </Message>
</AmazonEnvelope>`;

        return this.submitFeed('POST_INVENTORY_AVAILABILITY_DATA', feedContent);
    }

    async uploadFeedDocument(content) {
        // Créer le document
        const doc = await this.request('POST', '/feeds/2021-06-30/documents', {
            contentType: 'text/xml; charset=UTF-8'
        });

        // Upload le contenu
        await fetch(doc.url, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
            body: content
        });

        return doc.feedDocumentId;
    }

    async submitFeed(feedType, content) {
        const docId = await this.uploadFeedDocument(content);
        return this.request('POST', '/feeds/2021-06-30/feeds', {
            feedType,
            marketplaceIds: [this.marketplaceId],
            inputFeedDocumentId: docId
        });
    }
}

// ==========================================
// EBAY
// ==========================================

class EbayConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = config.sandbox 
            ? 'https://api.sandbox.ebay.com'
            : 'https://api.ebay.com';
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.refreshToken = config.refreshToken;
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    async refreshAccessToken() {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        
        const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        return this.accessToken;
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Language': 'fr-FR',
            'Accept-Language': 'fr-FR'
        };
    }

    async getOrders(params = {}) {
        await this.refreshAccessToken();

        const queryParams = new URLSearchParams({
            filter: `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`,
            limit: params.limit || 50
        });

        if (params.createdAfter) {
            queryParams.set('filter', `creationdate:[${params.createdAfter}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`);
        }

        const data = await this.request('GET', `/sell/fulfillment/v1/order?${queryParams}`);
        
        return (data.orders || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(ebayOrder) {
        const buyer = ebayOrder.buyer || {};
        const fulfillment = ebayOrder.fulfillmentStartInstructions?.[0] || {};
        const shippingAddress = fulfillment.shippingStep?.shipTo || {};

        return {
            id: ebayOrder.orderId,
            externalId: ebayOrder.orderId,
            channel: 'ebay',
            marketplace: 'ebay_fr',
            orderNumber: ebayOrder.orderId,
            status: this.mapOrderStatus(ebayOrder.orderFulfillmentStatus),
            customer: {
                name: buyer.username,
                email: buyer.buyerRegistrationAddress?.email
            },
            shippingAddress: {
                firstName: shippingAddress.fullName?.split(' ')[0],
                lastName: shippingAddress.fullName?.split(' ').slice(1).join(' '),
                line1: shippingAddress.contactAddress?.addressLine1,
                line2: shippingAddress.contactAddress?.addressLine2,
                city: shippingAddress.contactAddress?.city,
                postalCode: shippingAddress.contactAddress?.postalCode,
                country: shippingAddress.contactAddress?.countryCode,
                phone: shippingAddress.primaryPhone?.phoneNumber
            },
            items: (ebayOrder.lineItems || []).map(item => ({
                id: item.lineItemId,
                sku: item.sku,
                name: item.title,
                quantity: item.quantity,
                price: parseFloat(item.lineItemCost?.value || 0)
            })),
            totals: {
                subtotal: parseFloat(ebayOrder.pricingSummary?.priceSubtotal?.value || 0),
                shipping: parseFloat(ebayOrder.pricingSummary?.deliveryCost?.value || 0),
                tax: parseFloat(ebayOrder.pricingSummary?.tax?.value || 0),
                total: parseFloat(ebayOrder.pricingSummary?.total?.value || 0),
                currency: ebayOrder.pricingSummary?.total?.currency || 'EUR'
            },
            createdAt: ebayOrder.creationDate,
            updatedAt: ebayOrder.lastModifiedDate
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'NOT_STARTED': 'new',
            'IN_PROGRESS': 'processing',
            'FULFILLED': 'shipped'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        await this.refreshAccessToken();

        const order = await this.request('GET', `/sell/fulfillment/v1/order/${orderId}`);
        const lineItemIds = order.lineItems.map(item => item.lineItemId);

        return this.request('POST', `/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`, {
            lineItems: lineItemIds.map(id => ({ lineItemId: id, quantity: 1 })),
            shippedDate: new Date().toISOString(),
            shippingCarrierCode: this.mapCarrierCode(shipmentData.carrier),
            trackingNumber: shipmentData.trackingNumber
        });
    }

    mapCarrierCode(carrier) {
        const carrierMap = {
            'colissimo': 'COLISSIMO',
            'chronopost': 'CHRONOPOST',
            'mondial_relay': 'MONDIAL_RELAY',
            'dhl': 'DHL',
            'ups': 'UPS',
            'fedex': 'FEDEX'
        };
        return carrierMap[carrier?.toLowerCase()] || carrier?.toUpperCase();
    }

    async updateStock(sku, quantity) {
        await this.refreshAccessToken();

        // Trouver l'inventaire par SKU
        const inventory = await this.request('GET', `/sell/inventory/v1/inventory_item/${sku}`);
        
        return this.request('PUT', `/sell/inventory/v1/inventory_item/${sku}`, {
            ...inventory,
            availability: {
                shipToLocationAvailability: {
                    quantity
                }
            }
        });
    }
}

// ==========================================
// CDISCOUNT
// ==========================================

class CdiscountConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://wsvc.cdiscount.com/MarketplaceAPIService.svc';
        this.login = config.login;
        this.password = config.password;
        this.token = null;
    }

    async authenticate() {
        if (this.token) return this.token;

        const response = await fetch(`${this.baseUrl}/GetToken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Login: this.login,
                Password: this.password
            })
        });

        const data = await response.json();
        this.token = data.TokenId;
        return this.token;
    }

    getAuthHeaders() {
        return { 'Authorization': `Bearer ${this.token}` };
    }

    async getOrders(params = {}) {
        await this.authenticate();

        const data = await this.request('POST', '/GetOrderList', {
            TokenId: this.token,
            OrderFilter: {
                States: params.statuses || ['WaitingForShipmentAcceptation', 'AcceptedBySeller'],
                BeginCreationDate: params.createdAfter || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
            }
        });

        return (data.OrderList || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(cdOrder) {
        return {
            id: cdOrder.OrderNumber,
            externalId: cdOrder.OrderNumber,
            channel: 'cdiscount',
            marketplace: 'cdiscount',
            orderNumber: cdOrder.OrderNumber,
            status: this.mapOrderStatus(cdOrder.OrderState),
            customer: {
                name: `${cdOrder.Customer.FirstName} ${cdOrder.Customer.LastName}`,
                email: cdOrder.Customer.Email,
                phone: cdOrder.Customer.Phone
            },
            shippingAddress: {
                firstName: cdOrder.ShippingAddress.FirstName,
                lastName: cdOrder.ShippingAddress.LastName,
                line1: cdOrder.ShippingAddress.Street,
                line2: cdOrder.ShippingAddress.Street2,
                city: cdOrder.ShippingAddress.City,
                postalCode: cdOrder.ShippingAddress.ZipCode,
                country: cdOrder.ShippingAddress.Country
            },
            items: (cdOrder.OrderLineList || []).map(item => ({
                id: item.OrderLineId,
                sku: item.SellerProductId,
                name: item.Name,
                quantity: item.Quantity,
                price: item.PurchasePrice
            })),
            totals: {
                subtotal: cdOrder.TotalProductsAmount,
                shipping: cdOrder.ShippingFee,
                total: cdOrder.TotalAmount,
                currency: 'EUR'
            },
            createdAt: cdOrder.CreationDate
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'WaitingForShipmentAcceptation': 'new',
            'AcceptedBySeller': 'processing',
            'Shipped': 'shipped',
            'Cancelled': 'cancelled'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        await this.authenticate();

        return this.request('POST', '/ValidateOrder', {
            TokenId: this.token,
            OrderNumber: orderId,
            TrackingNumber: shipmentData.trackingNumber,
            TrackingUrl: shipmentData.trackingUrl,
            CarrierName: shipmentData.carrier
        });
    }

    async updateStock(sku, quantity) {
        await this.authenticate();

        return this.request('POST', '/SubmitOfferPackage', {
            TokenId: this.token,
            Offers: [{
                ProductEan: sku,
                Stock: quantity
            }]
        });
    }
}

// ==========================================
// FNAC
// ==========================================

class FnacConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = config.sandbox 
            ? 'https://sandbox.fnacmarketplace.com/api'
            : 'https://fnacmarketplace.com/api';
        this.partnerId = config.partnerId;
        this.shopId = config.shopId;
        this.key = config.key;
    }

    getAuthHeaders() {
        const timestamp = new Date().toISOString();
        const signature = this.generateSignature(timestamp);
        
        return {
            'X-FNAC-Partner-Id': this.partnerId,
            'X-FNAC-Shop-Id': this.shopId,
            'X-FNAC-Timestamp': timestamp,
            'X-FNAC-Signature': signature
        };
    }

    generateSignature(timestamp) {
        const data = `${this.partnerId}${this.shopId}${timestamp}`;
        return crypto.createHmac('sha256', this.key).update(data).digest('hex');
    }

    async getOrders(params = {}) {
        const queryParams = new URLSearchParams({
            status: params.statuses?.join(',') || 'Created,Accepted',
            date_from: params.createdAfter || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        });

        const data = await this.request('GET', `/orders?${queryParams}`);
        return (data.orders || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(fnacOrder) {
        return {
            id: fnacOrder.order_id,
            externalId: fnacOrder.order_id,
            channel: 'fnac',
            marketplace: 'fnac',
            orderNumber: fnacOrder.order_id,
            status: this.mapOrderStatus(fnacOrder.state),
            customer: {
                name: `${fnacOrder.client.first_name} ${fnacOrder.client.last_name}`,
                email: fnacOrder.client.email,
                phone: fnacOrder.client.phone
            },
            shippingAddress: {
                firstName: fnacOrder.shipping_address.first_name,
                lastName: fnacOrder.shipping_address.last_name,
                line1: fnacOrder.shipping_address.address1,
                line2: fnacOrder.shipping_address.address2,
                city: fnacOrder.shipping_address.city,
                postalCode: fnacOrder.shipping_address.postal_code,
                country: fnacOrder.shipping_address.country
            },
            items: (fnacOrder.order_details || []).map(item => ({
                id: item.order_detail_id,
                sku: item.offer_seller_id,
                ean: item.product_ean,
                name: item.product_name,
                quantity: item.quantity,
                price: item.price
            })),
            totals: {
                subtotal: fnacOrder.total_products,
                shipping: fnacOrder.shipping_price,
                total: fnacOrder.total_price,
                currency: 'EUR'
            },
            createdAt: fnacOrder.created_at
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'Created': 'new',
            'Accepted': 'processing',
            'ToShip': 'ready',
            'Shipped': 'shipped',
            'Cancelled': 'cancelled'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        return this.request('POST', `/orders/${orderId}/ship`, {
            tracking_number: shipmentData.trackingNumber,
            tracking_company: shipmentData.carrier
        });
    }

    async updateStock(sku, quantity) {
        return this.request('POST', `/offers/${sku}/stock`, {
            quantity
        });
    }
}

// ==========================================
// MANOMANO
// ==========================================

class ManoManoConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.manomano.com';
        this.apiKey = config.apiKey;
        this.sellerId = config.sellerId;
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Seller-Id': this.sellerId
        };
    }

    async getOrders(params = {}) {
        const queryParams = new URLSearchParams({
            status: params.statuses?.join(',') || 'waiting_shipment',
            limit: params.limit || 100
        });

        const data = await this.request('GET', `/v1/orders?${queryParams}`);
        return (data.orders || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(mmOrder) {
        return {
            id: mmOrder.order_id,
            externalId: mmOrder.order_id,
            channel: 'manomano',
            marketplace: `manomano_${mmOrder.country}`,
            orderNumber: mmOrder.order_reference,
            status: this.mapOrderStatus(mmOrder.status),
            customer: {
                name: mmOrder.customer.name,
                email: mmOrder.customer.email,
                phone: mmOrder.customer.phone
            },
            shippingAddress: {
                firstName: mmOrder.shipping_address.first_name,
                lastName: mmOrder.shipping_address.last_name,
                line1: mmOrder.shipping_address.street1,
                line2: mmOrder.shipping_address.street2,
                city: mmOrder.shipping_address.city,
                postalCode: mmOrder.shipping_address.postal_code,
                country: mmOrder.shipping_address.country_code
            },
            items: (mmOrder.items || []).map(item => ({
                id: item.item_id,
                sku: item.seller_sku,
                name: item.title,
                quantity: item.quantity,
                price: item.unit_price
            })),
            totals: {
                subtotal: mmOrder.subtotal,
                shipping: mmOrder.shipping_cost,
                total: mmOrder.total,
                currency: mmOrder.currency
            },
            createdAt: mmOrder.created_at
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'waiting_shipment': 'new',
            'shipped': 'shipped',
            'delivered': 'delivered',
            'cancelled': 'cancelled'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        return this.request('POST', `/v1/orders/${orderId}/shipments`, {
            tracking_number: shipmentData.trackingNumber,
            carrier_code: shipmentData.carrier,
            shipped_at: new Date().toISOString()
        });
    }

    async updateStock(sku, quantity) {
        return this.request('PUT', `/v1/inventory/${sku}`, {
            quantity,
            updated_at: new Date().toISOString()
        });
    }
}

// ==========================================
// LEROY MERLIN
// ==========================================

class LeroyMerlinConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.leroymerlin.fr/marketplace';
        this.apiKey = config.apiKey;
        this.sellerId = config.sellerId;
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Seller-Id': this.sellerId
        };
    }

    async getOrders(params = {}) {
        const data = await this.request('GET', '/orders', {
            status: params.statuses || ['WAITING_FOR_SHIPMENT'],
            limit: params.limit || 100
        });
        return (data.orders || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(lmOrder) {
        return {
            id: lmOrder.orderId,
            externalId: lmOrder.orderId,
            channel: 'leroymerlin',
            marketplace: 'leroymerlin_fr',
            orderNumber: lmOrder.orderNumber,
            status: this.mapOrderStatus(lmOrder.status),
            customer: {
                name: `${lmOrder.customer.firstName} ${lmOrder.customer.lastName}`,
                email: lmOrder.customer.email,
                phone: lmOrder.customer.phone
            },
            shippingAddress: lmOrder.shippingAddress,
            items: lmOrder.items.map(item => ({
                id: item.lineId,
                sku: item.sellerSku,
                name: item.title,
                quantity: item.quantity,
                price: item.price
            })),
            totals: {
                subtotal: lmOrder.subtotal,
                shipping: lmOrder.shippingCost,
                total: lmOrder.total,
                currency: 'EUR'
            },
            createdAt: lmOrder.createdAt
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'WAITING_FOR_SHIPMENT': 'new',
            'SHIPPED': 'shipped',
            'DELIVERED': 'delivered'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        return this.request('POST', `/orders/${orderId}/ship`, {
            trackingNumber: shipmentData.trackingNumber,
            carrierCode: shipmentData.carrier
        });
    }
}

// ==========================================
// ZALANDO
// ==========================================

class ZalandoConnector extends BaseMarketplaceConnector {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.zalando.com/zrp';
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.accessToken = null;
    }

    async authenticate() {
        const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        
        const response = await fetch('https://api.zalando.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`
            },
            body: 'grant_type=client_credentials'
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        return this.accessToken;
    }

    getAuthHeaders() {
        return { 'Authorization': `Bearer ${this.accessToken}` };
    }

    async getOrders(params = {}) {
        await this.authenticate();
        
        const data = await this.request('GET', '/orders', {
            status: params.statuses || ['APPROVED'],
            limit: params.limit || 100
        });
        
        return (data.items || []).map(order => this.normalizeOrder(order));
    }

    normalizeOrder(zOrder) {
        return {
            id: zOrder.order_number,
            externalId: zOrder.order_number,
            channel: 'zalando',
            marketplace: 'zalando',
            orderNumber: zOrder.order_number,
            status: this.mapOrderStatus(zOrder.status),
            shippingAddress: zOrder.delivery_address,
            items: (zOrder.order_lines || []).map(item => ({
                id: item.order_line_id,
                sku: item.article_number,
                ean: item.ean,
                name: item.article_name,
                quantity: item.quantity,
                price: item.price.amount
            })),
            totals: {
                total: zOrder.total_amount,
                currency: zOrder.currency
            },
            createdAt: zOrder.created_at
        };
    }

    mapOrderStatus(status) {
        const statusMap = {
            'APPROVED': 'new',
            'SHIPPED': 'shipped',
            'DELIVERED': 'delivered'
        };
        return statusMap[status] || 'unknown';
    }

    async shipOrder(orderId, shipmentData) {
        await this.authenticate();
        
        return this.request('POST', `/orders/${orderId}/shipments`, {
            tracking_number: shipmentData.trackingNumber,
            carrier: shipmentData.carrier
        });
    }
}

// ==========================================
// HELPERS
// ==========================================

class RateLimiter {
    constructor(config) {
        this.maxRequests = config.requests || 100;
        this.period = config.period || 60; // seconds
        this.requests = [];
    }

    async acquire() {
        const now = Date.now();
        this.requests = this.requests.filter(t => now - t < this.period * 1000);
        
        if (this.requests.length >= this.maxRequests) {
            const waitTime = this.period * 1000 - (now - this.requests[0]);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.requests.push(Date.now());
    }
}

class MarketplaceError extends Error {
    constructor(message, statusCode, responseBody) {
        super(message);
        this.name = 'MarketplaceError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}

// ==========================================
// UNIFIED MARKETPLACE SERVICE
// ==========================================

class MarketplaceService {
    constructor(config = {}) {
        this.connectors = new Map();
        this.config = config;
    }

    registerConnector(name, connector) {
        this.connectors.set(name, connector);
    }

    getConnector(name) {
        const connector = this.connectors.get(name);
        if (!connector) throw new Error(`Marketplace ${name} not configured`);
        return connector;
    }

    async syncOrders(marketplace, params = {}) {
        const connector = this.getConnector(marketplace);
        return connector.getOrders(params);
    }

    async syncAllOrders(params = {}) {
        const results = {};
        for (const [name, connector] of this.connectors) {
            try {
                results[name] = await connector.getOrders(params);
            } catch (error) {
                results[name] = { error: error.message };
            }
        }
        return results;
    }

    async shipOrder(marketplace, orderId, shipmentData) {
        const connector = this.getConnector(marketplace);
        return connector.shipOrder(orderId, shipmentData);
    }

    async updateStock(marketplace, sku, quantity) {
        const connector = this.getConnector(marketplace);
        return connector.updateStock(sku, quantity);
    }

    async updateStockAll(sku, quantity) {
        const results = {};
        for (const [name, connector] of this.connectors) {
            try {
                results[name] = await connector.updateStock(sku, quantity);
            } catch (error) {
                results[name] = { error: error.message };
            }
        }
        return results;
    }
}

module.exports = {
    MarketplaceService,
    AmazonConnector,
    EbayConnector,
    CdiscountConnector,
    FnacConnector,
    ManoManoConnector,
    LeroyMerlinConnector,
    ZalandoConnector,
    MarketplaceError
};
