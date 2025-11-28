/**
 * Routz v4.0 - ERP Connectors
 * Intégration complète : SAP, Sage, Odoo, Microsoft Dynamics, NetSuite, Cegid
 */

// ==========================================
// BASE ERP CONNECTOR
// ==========================================

class BaseERPConnector {
    constructor(config) {
        this.baseUrl = config.baseUrl;
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.companyId = config.companyId;
        this.syncInterval = config.syncInterval || 300000; // 5 minutes
    }

    async connect() {
        throw new Error('Must be implemented by subclass');
    }

    async syncOrders() {
        throw new Error('Must be implemented by subclass');
    }

    async syncProducts() {
        throw new Error('Must be implemented by subclass');
    }

    async syncInventory() {
        throw new Error('Must be implemented by subclass');
    }

    async createShipment(orderData) {
        throw new Error('Must be implemented by subclass');
    }

    async updateOrderStatus(orderId, status) {
        throw new Error('Must be implemented by subclass');
    }
}

// ==========================================
// SAP BUSINESS ONE
// ==========================================

class SAPConnector extends BaseERPConnector {
    constructor(config) {
        super(config);
        this.sessionId = null;
        this.routeId = null;
    }

    async connect() {
        const response = await fetch(`${this.baseUrl}/b1s/v1/Login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CompanyDB: this.companyId,
                UserName: this.apiKey,
                Password: this.apiSecret
            })
        });

        const data = await response.json();
        this.sessionId = data.SessionId;
        this.routeId = response.headers.get('Set-Cookie')?.match(/ROUTEID=([^;]+)/)?.[1];
        return this.sessionId;
    }

    async request(method, endpoint, body = null) {
        if (!this.sessionId) await this.connect();

        const response = await fetch(`${this.baseUrl}/b1s/v1${endpoint}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `B1SESSION=${this.sessionId}; ROUTEID=${this.routeId}`
            },
            body: body ? JSON.stringify(body) : null
        });

        if (response.status === 401) {
            await this.connect();
            return this.request(method, endpoint, body);
        }

        return response.json();
    }

    async syncOrders(params = {}) {
        const filter = params.status ? `DocumentStatus eq '${params.status}'` : '';
        const orders = await this.request('GET', `/Orders?$filter=${filter}&$top=100`);
        return orders.value.map(order => this.normalizeOrder(order));
    }

    async syncProducts() {
        const products = await this.request('GET', '/Items?$top=1000');
        return products.value.map(product => this.normalizeProduct(product));
    }

    async syncInventory() {
        const inventory = await this.request('GET', '/ItemWarehouseInfoCollection');
        return inventory.value.map(item => ({
            sku: item.ItemCode,
            warehouseCode: item.WarehouseCode,
            quantity: item.InStock,
            committed: item.Committed,
            ordered: item.Ordered,
            available: item.InStock - item.Committed
        }));
    }

    async createDeliveryNote(orderData) {
        const deliveryNote = {
            CardCode: orderData.customerId,
            DocDate: new Date().toISOString().split('T')[0],
            DocumentLines: orderData.items.map((item, index) => ({
                LineNum: index,
                ItemCode: item.sku,
                Quantity: item.quantity,
                WarehouseCode: item.warehouseCode
            })),
            ShipToCode: orderData.shippingAddressCode,
            TrackingNumber: orderData.trackingNumber
        };

        return await this.request('POST', '/DeliveryNotes', deliveryNote);
    }

    async updateOrderStatus(orderId, status) {
        const sapStatus = this.mapStatusToSAP(status);
        return await this.request('PATCH', `/Orders(${orderId})`, {
            DocumentStatus: sapStatus
        });
    }

    normalizeOrder(sapOrder) {
        return {
            id: sapOrder.DocEntry.toString(),
            externalId: sapOrder.DocNum.toString(),
            source: 'sap',
            status: this.mapSAPStatus(sapOrder.DocumentStatus),
            customerId: sapOrder.CardCode,
            customerName: sapOrder.CardName,
            items: sapOrder.DocumentLines.map(line => ({
                sku: line.ItemCode,
                name: line.ItemDescription,
                quantity: line.Quantity,
                price: line.Price,
                warehouseCode: line.WarehouseCode
            })),
            totals: {
                subtotal: sapOrder.DocTotal - sapOrder.VatSum,
                tax: sapOrder.VatSum,
                total: sapOrder.DocTotal,
                currency: sapOrder.DocCurrency
            },
            shippingAddress: {
                code: sapOrder.ShipToCode
            },
            createdAt: sapOrder.DocDate,
            dueDate: sapOrder.DocDueDate
        };
    }

    normalizeProduct(sapProduct) {
        return {
            sku: sapProduct.ItemCode,
            name: sapProduct.ItemName,
            description: sapProduct.UserText,
            barcode: sapProduct.BarCode,
            weight: sapProduct.SalesUnitWeight,
            price: sapProduct.AvgStdPrice,
            category: sapProduct.ItemsGroupCode,
            active: sapProduct.Valid === 'tYES'
        };
    }

    mapSAPStatus(status) {
        const map = { 'bost_Open': 'pending', 'bost_Close': 'completed', 'bost_Paid': 'completed' };
        return map[status] || 'unknown';
    }

    mapStatusToSAP(status) {
        const map = { 'pending': 'bost_Open', 'completed': 'bost_Close', 'shipped': 'bost_Close' };
        return map[status] || 'bost_Open';
    }
}

// ==========================================
// SAGE X3 / SAGE 100
// ==========================================

class SageConnector extends BaseERPConnector {
    constructor(config) {
        super(config);
        this.version = config.version || 'x3'; // x3, 100, 50
        this.accessToken = null;
    }

    async connect() {
        const response = await fetch(`${this.baseUrl}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.apiKey,
                client_secret: this.apiSecret,
                scope: 'api'
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        return this.accessToken;
    }

    async request(method, endpoint, body = null) {
        if (!this.accessToken) await this.connect();

        const response = await fetch(`${this.baseUrl}/api/v1${endpoint}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                'X-Sage-Company': this.companyId
            },
            body: body ? JSON.stringify(body) : null
        });

        return response.json();
    }

    async syncOrders(params = {}) {
        const orders = await this.request('GET', '/sales/orders', {
            status: params.status,
            modifiedSince: params.since
        });
        return orders.map(order => this.normalizeOrder(order));
    }

    async syncProducts() {
        const products = await this.request('GET', '/inventory/items');
        return products.map(product => this.normalizeProduct(product));
    }

    async syncInventory() {
        const stock = await this.request('GET', '/inventory/stock-levels');
        return stock.map(item => ({
            sku: item.itemCode,
            warehouseCode: item.warehouseCode,
            quantity: item.quantityOnHand,
            available: item.quantityAvailable,
            reserved: item.quantityReserved
        }));
    }

    async createShipment(orderData) {
        return await this.request('POST', '/sales/deliveries', {
            orderNumber: orderData.orderId,
            deliveryDate: new Date().toISOString(),
            carrier: orderData.carrier,
            trackingNumber: orderData.trackingNumber,
            lines: orderData.items.map(item => ({
                itemCode: item.sku,
                quantity: item.quantity
            }))
        });
    }

    normalizeOrder(sageOrder) {
        return {
            id: sageOrder.id,
            externalId: sageOrder.orderNumber,
            source: 'sage',
            status: this.mapSageStatus(sageOrder.status),
            customerId: sageOrder.customerCode,
            customerName: sageOrder.customerName,
            items: sageOrder.lines.map(line => ({
                sku: line.itemCode,
                name: line.description,
                quantity: line.quantity,
                price: line.unitPrice
            })),
            totals: {
                subtotal: sageOrder.totalExclTax,
                tax: sageOrder.taxAmount,
                total: sageOrder.totalInclTax,
                currency: sageOrder.currency
            },
            createdAt: sageOrder.createdDate
        };
    }

    normalizeProduct(sageProduct) {
        return {
            sku: sageProduct.itemCode,
            name: sageProduct.description,
            barcode: sageProduct.barcode,
            weight: sageProduct.weight,
            price: sageProduct.standardPrice,
            category: sageProduct.category,
            active: sageProduct.status === 'active'
        };
    }

    mapSageStatus(status) {
        const map = { 'draft': 'pending', 'confirmed': 'processing', 'delivered': 'shipped', 'invoiced': 'completed' };
        return map[status] || 'unknown';
    }
}

// ==========================================
// ODOO (OpenERP)
// ==========================================

class OdooConnector extends BaseERPConnector {
    constructor(config) {
        super(config);
        this.database = config.database;
        this.uid = null;
    }

    async connect() {
        // XML-RPC authentication
        const response = await this.xmlRpcCall('common', 'authenticate', [
            this.database,
            this.apiKey,
            this.apiSecret,
            {}
        ]);
        this.uid = response;
        return this.uid;
    }

    async xmlRpcCall(service, method, args) {
        const response = await fetch(`${this.baseUrl}/xmlrpc/2/${service}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml' },
            body: this.buildXmlRpcRequest(method, args)
        });
        return this.parseXmlRpcResponse(await response.text());
    }

    async execute(model, method, args, kwargs = {}) {
        if (!this.uid) await this.connect();
        
        return this.xmlRpcCall('object', 'execute_kw', [
            this.database,
            this.uid,
            this.apiSecret,
            model,
            method,
            args,
            kwargs
        ]);
    }

    async syncOrders(params = {}) {
        const domain = [['state', 'in', ['sale', 'done']]];
        if (params.since) {
            domain.push(['write_date', '>=', params.since]);
        }

        const orderIds = await this.execute('sale.order', 'search', [domain]);
        const orders = await this.execute('sale.order', 'read', [orderIds], {
            fields: ['name', 'partner_id', 'order_line', 'amount_total', 'state', 'date_order']
        });

        return orders.map(order => this.normalizeOrder(order));
    }

    async syncProducts() {
        const productIds = await this.execute('product.product', 'search', [[['sale_ok', '=', true]]]);
        const products = await this.execute('product.product', 'read', [productIds], {
            fields: ['default_code', 'name', 'barcode', 'weight', 'list_price', 'categ_id', 'active']
        });

        return products.map(product => this.normalizeProduct(product));
    }

    async syncInventory() {
        const quantIds = await this.execute('stock.quant', 'search', [[['quantity', '>', 0]]]);
        const quants = await this.execute('stock.quant', 'read', [quantIds], {
            fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity']
        });

        return quants.map(quant => ({
            productId: quant.product_id[0],
            sku: quant.product_id[1],
            locationId: quant.location_id[0],
            quantity: quant.quantity,
            reserved: quant.reserved_quantity,
            available: quant.quantity - quant.reserved_quantity
        }));
    }

    async createDeliveryOrder(orderData) {
        const pickingId = await this.execute('stock.picking', 'create', [{
            partner_id: orderData.partnerId,
            picking_type_id: orderData.pickingTypeId || 2, // Delivery
            location_id: orderData.locationId,
            location_dest_id: orderData.destinationId,
            origin: orderData.orderId,
            carrier_tracking_ref: orderData.trackingNumber,
            move_lines: orderData.items.map(item => [0, 0, {
                product_id: item.productId,
                product_uom_qty: item.quantity,
                name: item.name
            }])
        }]);

        // Confirm and validate
        await this.execute('stock.picking', 'action_confirm', [[pickingId]]);
        await this.execute('stock.picking', 'action_assign', [[pickingId]]);

        return { pickingId };
    }

    normalizeOrder(odooOrder) {
        return {
            id: odooOrder.id.toString(),
            externalId: odooOrder.name,
            source: 'odoo',
            status: this.mapOdooStatus(odooOrder.state),
            customerId: odooOrder.partner_id[0],
            customerName: odooOrder.partner_id[1],
            totals: {
                total: odooOrder.amount_total,
                currency: 'EUR'
            },
            createdAt: odooOrder.date_order
        };
    }

    normalizeProduct(odooProduct) {
        return {
            id: odooProduct.id,
            sku: odooProduct.default_code || odooProduct.id.toString(),
            name: odooProduct.name,
            barcode: odooProduct.barcode,
            weight: odooProduct.weight,
            price: odooProduct.list_price,
            category: odooProduct.categ_id?.[1],
            active: odooProduct.active
        };
    }

    mapOdooStatus(status) {
        const map = { 'draft': 'pending', 'sent': 'pending', 'sale': 'processing', 'done': 'completed', 'cancel': 'cancelled' };
        return map[status] || 'unknown';
    }

    buildXmlRpcRequest(method, args) {
        // Build XML-RPC request
        return `<?xml version="1.0"?>
        <methodCall>
            <methodName>${method}</methodName>
            <params>${args.map(arg => `<param><value>${this.valueToXml(arg)}</value></param>`).join('')}</params>
        </methodCall>`;
    }

    valueToXml(value) {
        if (typeof value === 'string') return `<string>${value}</string>`;
        if (typeof value === 'number') return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
        if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
        if (Array.isArray(value)) return `<array><data>${value.map(v => `<value>${this.valueToXml(v)}</value>`).join('')}</data></array>`;
        if (typeof value === 'object') return `<struct>${Object.entries(value).map(([k, v]) => `<member><name>${k}</name><value>${this.valueToXml(v)}</value></member>`).join('')}</struct>`;
        return '';
    }

    parseXmlRpcResponse(xml) {
        // Simple XML-RPC response parser
        return xml; // Would need proper XML parsing
    }
}

// ==========================================
// MICROSOFT DYNAMICS 365
// ==========================================

class DynamicsConnector extends BaseERPConnector {
    constructor(config) {
        super(config);
        this.tenantId = config.tenantId;
        this.environment = config.environment;
        this.accessToken = null;
    }

    async connect() {
        const response = await fetch(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.apiKey,
                client_secret: this.apiSecret,
                scope: `${this.baseUrl}/.default`,
                grant_type: 'client_credentials'
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        return this.accessToken;
    }

    async request(method, endpoint, body = null) {
        if (!this.accessToken) await this.connect();

        const response = await fetch(`${this.baseUrl}/data${endpoint}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                'OData-Version': '4.0'
            },
            body: body ? JSON.stringify(body) : null
        });

        return response.json();
    }

    async syncOrders(params = {}) {
        const filter = params.status ? `SalesOrderStatus eq '${params.status}'` : '';
        const orders = await this.request('GET', `/SalesOrderHeaders?$filter=${filter}&$expand=SalesOrderLines`);
        return orders.value.map(order => this.normalizeOrder(order));
    }

    async syncProducts() {
        const products = await this.request('GET', '/ReleasedProducts');
        return products.value.map(product => this.normalizeProduct(product));
    }

    async syncInventory() {
        const inventory = await this.request('GET', '/InventoryOnhandEntities');
        return inventory.value.map(item => ({
            sku: item.ItemNumber,
            warehouseId: item.WarehouseId,
            quantity: item.PhysicalInventory,
            available: item.AvailablePhysical,
            reserved: item.ReservedPhysical
        }));
    }

    async createShipment(orderData) {
        return await this.request('POST', '/SalesOrderShipments', {
            SalesOrderNumber: orderData.orderId,
            ShipDate: new Date().toISOString(),
            CarrierId: orderData.carrier,
            TrackingNumber: orderData.trackingNumber,
            Lines: orderData.items.map(item => ({
                ItemNumber: item.sku,
                Quantity: item.quantity
            }))
        });
    }

    normalizeOrder(d365Order) {
        return {
            id: d365Order.SalesOrderNumber,
            externalId: d365Order.SalesOrderNumber,
            source: 'dynamics365',
            status: this.mapD365Status(d365Order.SalesOrderStatus),
            customerId: d365Order.CustomerAccount,
            customerName: d365Order.CustomerName,
            items: d365Order.SalesOrderLines?.map(line => ({
                sku: line.ItemNumber,
                name: line.ProductName,
                quantity: line.SalesQuantity,
                price: line.SalesPrice
            })) || [],
            totals: {
                total: d365Order.TotalAmount,
                currency: d365Order.CurrencyCode
            },
            createdAt: d365Order.RequestedReceiptDate
        };
    }

    normalizeProduct(d365Product) {
        return {
            sku: d365Product.ItemNumber,
            name: d365Product.ProductName,
            description: d365Product.ProductDescription,
            weight: d365Product.GrossWeight,
            price: d365Product.SalesPrice,
            active: d365Product.IsActive
        };
    }

    mapD365Status(status) {
        const map = { 'Open': 'pending', 'Confirmed': 'processing', 'Delivered': 'shipped', 'Invoiced': 'completed' };
        return map[status] || 'unknown';
    }
}

// ==========================================
// NETSUITE
// ==========================================

class NetSuiteConnector extends BaseERPConnector {
    constructor(config) {
        super(config);
        this.accountId = config.accountId;
        this.consumerKey = config.consumerKey;
        this.consumerSecret = config.consumerSecret;
        this.tokenId = config.tokenId;
        this.tokenSecret = config.tokenSecret;
    }

    generateOAuthHeader(method, url) {
        const oauth = require('oauth-1.0a');
        const crypto = require('crypto');

        const oauthClient = oauth({
            consumer: { key: this.consumerKey, secret: this.consumerSecret },
            signature_method: 'HMAC-SHA256',
            hash_function: (baseString, key) => crypto.createHmac('sha256', key).update(baseString).digest('base64')
        });

        const token = { key: this.tokenId, secret: this.tokenSecret };
        return oauthClient.toHeader(oauthClient.authorize({ url, method }, token));
    }

    async request(method, endpoint, body = null) {
        const url = `https://${this.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1${endpoint}`;
        const oauthHeader = this.generateOAuthHeader(method, url);

        const response = await fetch(url, {
            method,
            headers: {
                ...oauthHeader,
                'Content-Type': 'application/json',
                'Prefer': 'respond-async'
            },
            body: body ? JSON.stringify(body) : null
        });

        return response.json();
    }

    async syncOrders(params = {}) {
        const orders = await this.request('GET', '/salesOrder');
        return orders.items.map(order => this.normalizeOrder(order));
    }

    async syncProducts() {
        const products = await this.request('GET', '/inventoryItem');
        return products.items.map(product => this.normalizeProduct(product));
    }

    async createItemFulfillment(orderData) {
        return await this.request('POST', '/itemFulfillment', {
            createdFrom: { id: orderData.orderId },
            shipDate: new Date().toISOString().split('T')[0],
            shipMethod: { id: orderData.shipMethodId },
            linkedTrackingNumbers: orderData.trackingNumber,
            item: {
                items: orderData.items.map(item => ({
                    item: { id: item.itemId },
                    quantity: item.quantity
                }))
            }
        });
    }

    normalizeOrder(nsOrder) {
        return {
            id: nsOrder.id,
            externalId: nsOrder.tranId,
            source: 'netsuite',
            status: this.mapNetSuiteStatus(nsOrder.status?.id),
            customerId: nsOrder.entity?.id,
            customerName: nsOrder.entity?.refName,
            totals: {
                total: nsOrder.total,
                currency: nsOrder.currency?.refName || 'USD'
            },
            createdAt: nsOrder.tranDate
        };
    }

    normalizeProduct(nsProduct) {
        return {
            id: nsProduct.id,
            sku: nsProduct.itemId,
            name: nsProduct.displayName,
            barcode: nsProduct.upcCode,
            weight: nsProduct.weight,
            price: nsProduct.basePrice,
            active: !nsProduct.isInactive
        };
    }

    mapNetSuiteStatus(statusId) {
        const map = { 'pendingApproval': 'pending', 'pendingFulfillment': 'processing', 'fullyBilled': 'completed' };
        return map[statusId] || 'unknown';
    }
}

// ==========================================
// UNIFIED ERP SERVICE
// ==========================================

class ERPService {
    constructor() {
        this.connectors = new Map();
    }

    registerConnector(name, connector) {
        this.connectors.set(name, connector);
    }

    getConnector(name) {
        return this.connectors.get(name);
    }

    async syncFromAllERPs() {
        const results = { orders: [], products: [], inventory: [], errors: [] };

        for (const [name, connector] of this.connectors) {
            try {
                results.orders.push(...await connector.syncOrders());
                results.products.push(...await connector.syncProducts());
                results.inventory.push(...await connector.syncInventory());
            } catch (error) {
                results.errors.push({ erp: name, error: error.message });
            }
        }

        return results;
    }

    async pushShipmentToERP(erpName, shipmentData) {
        const connector = this.getConnector(erpName);
        if (!connector) throw new Error(`Unknown ERP: ${erpName}`);
        return connector.createShipment(shipmentData);
    }
}

module.exports = {
    ERPService,
    SAPConnector,
    SageConnector,
    OdooConnector,
    DynamicsConnector,
    NetSuiteConnector
};
