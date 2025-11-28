/**
 * Routz v4.0 - WMS (Warehouse Management System) Connectors
 * Intégrations Manhattan, Blue Yonder, SAP EWM, Oracle WMS, HighJump
 */

class BaseWMSConnector {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.baseUrl;
        this.apiKey = config.apiKey;
    }

    async request(method, endpoint, data = null) {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            method,
            headers: this.getHeaders(),
            body: data ? JSON.stringify(data) : null
        });

        if (!response.ok) {
            throw new Error(`WMS API error: ${response.status}`);
        }

        return response.json();
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
        };
    }

    // Méthodes abstraites
    async getInventory() { throw new Error('Not implemented'); }
    async createOutboundOrder() { throw new Error('Not implemented'); }
    async getOrderStatus() { throw new Error('Not implemented'); }
    async confirmShipment() { throw new Error('Not implemented'); }
}

// ==========================================
// MANHATTAN ASSOCIATES WMS
// ==========================================

class ManhattanWMSConnector extends BaseWMSConnector {
    constructor(config) {
        super(config);
        this.facilityId = config.facilityId;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
            'X-Facility-ID': this.facilityId
        };
    }

    async getInventory(filters = {}) {
        const params = new URLSearchParams({
            facilityId: this.facilityId,
            ...(filters.sku && { itemNumber: filters.sku }),
            ...(filters.location && { locationId: filters.location })
        });

        const response = await this.request('GET', `/wm/inventory/items?${params}`);

        return response.items.map(item => ({
            sku: item.itemNumber,
            name: item.description,
            quantity: item.availableQuantity,
            reserved: item.allocatedQuantity,
            location: item.locationId,
            lot: item.lotNumber,
            expirationDate: item.expirationDate,
            lastUpdated: item.lastModifiedDate
        }));
    }

    async createOutboundOrder(order) {
        const manhattanOrder = {
            orderNumber: order.orderNumber,
            orderType: 'OUTBOUND',
            facilityId: this.facilityId,
            priority: this.mapPriority(order.priority),
            requestedShipDate: order.requestedShipDate,
            carrier: {
                carrierCode: order.carrier,
                serviceCode: order.service
            },
            shipTo: {
                name: order.recipient.name,
                address1: order.recipient.address1,
                address2: order.recipient.address2,
                city: order.recipient.city,
                state: order.recipient.state,
                postalCode: order.recipient.postalCode,
                country: order.recipient.country,
                phone: order.recipient.phone,
                email: order.recipient.email
            },
            lines: order.items.map((item, index) => ({
                lineNumber: index + 1,
                itemNumber: item.sku,
                orderedQuantity: item.quantity,
                unitOfMeasure: item.unit || 'EA'
            }))
        };

        const response = await this.request('POST', '/wm/outbound/orders', manhattanOrder);

        return {
            success: true,
            wmsOrderId: response.orderId,
            status: response.status,
            estimatedShipDate: response.estimatedShipDate
        };
    }

    async getOrderStatus(orderNumber) {
        const response = await this.request('GET', `/wm/outbound/orders/${orderNumber}`);

        return {
            orderNumber: response.orderNumber,
            status: this.mapStatus(response.status),
            wmsStatus: response.status,
            pickedQuantity: response.pickedQuantity,
            shippedQuantity: response.shippedQuantity,
            trackingNumbers: response.shipments?.map(s => s.trackingNumber) || [],
            shipDate: response.actualShipDate,
            carrier: response.carrier?.carrierCode
        };
    }

    async confirmShipment(shipmentData) {
        const response = await this.request('POST', `/wm/outbound/orders/${shipmentData.orderNumber}/ship`, {
            shipmentId: shipmentData.shipmentId,
            trackingNumber: shipmentData.trackingNumber,
            carrier: shipmentData.carrier,
            weight: shipmentData.weight,
            packages: shipmentData.packages?.map(pkg => ({
                packageId: pkg.id,
                trackingNumber: pkg.trackingNumber,
                weight: pkg.weight,
                dimensions: pkg.dimensions
            }))
        });

        return {
            success: true,
            shipmentId: response.shipmentId,
            confirmedAt: response.confirmationDate
        };
    }

    async getWaves() {
        const response = await this.request('GET', `/wm/outbound/waves?facilityId=${this.facilityId}`);
        return response.waves.map(wave => ({
            waveId: wave.waveNumber,
            status: wave.status,
            orderCount: wave.orderCount,
            lineCount: wave.lineCount,
            createdAt: wave.createDate,
            releasedAt: wave.releaseDate
        }));
    }

    mapPriority(priority) {
        const mapping = { urgent: 1, high: 2, normal: 3, low: 4 };
        return mapping[priority] || 3;
    }

    mapStatus(wmsStatus) {
        const mapping = {
            'CREATED': 'pending',
            'RELEASED': 'processing',
            'PICKING': 'picking',
            'PICKED': 'picked',
            'PACKING': 'packing',
            'PACKED': 'packed',
            'SHIPPED': 'shipped',
            'CANCELLED': 'cancelled'
        };
        return mapping[wmsStatus] || 'unknown';
    }
}

// ==========================================
// BLUE YONDER (JDA) WMS
// ==========================================

class BlueYonderWMSConnector extends BaseWMSConnector {
    constructor(config) {
        super(config);
        this.tenantId = config.tenantId;
        this.accessToken = null;
        this.tokenExpiry = 0;
    }

    async authenticate() {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        const response = await fetch(`${this.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                scope: 'wms.read wms.write'
            })
        });

        const data = await response.json();
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

        return this.accessToken;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
            'X-Tenant-ID': this.tenantId
        };
    }

    async request(method, endpoint, data = null) {
        await this.authenticate();
        return super.request(method, endpoint, data);
    }

    async getInventory(filters = {}) {
        const response = await this.request('GET', '/fulfillment/v1/inventory', {
            query: {
                ...(filters.sku && { itemId: filters.sku }),
                ...(filters.warehouse && { nodeId: filters.warehouse })
            }
        });

        return response.inventory.map(inv => ({
            sku: inv.itemId,
            name: inv.itemDescription,
            quantity: inv.availableToPromise,
            onHand: inv.onHandQuantity,
            reserved: inv.reservedQuantity,
            warehouse: inv.nodeId,
            zone: inv.zone,
            lastUpdated: inv.lastUpdatedTimestamp
        }));
    }

    async createOutboundOrder(order) {
        const byOrder = {
            orderId: order.orderNumber,
            orderType: 'FULFILLMENT',
            nodeId: order.warehouseId,
            requestedDeliveryDate: order.requestedDeliveryDate,
            shipToAddress: {
                firstName: order.recipient.firstName,
                lastName: order.recipient.lastName,
                company: order.recipient.company,
                addressLine1: order.recipient.address1,
                addressLine2: order.recipient.address2,
                city: order.recipient.city,
                state: order.recipient.state,
                postalCode: order.recipient.postalCode,
                country: order.recipient.country,
                phoneNumber: order.recipient.phone,
                emailAddress: order.recipient.email
            },
            carrier: {
                carrierId: order.carrier,
                serviceType: order.service
            },
            orderLines: order.items.map((item, idx) => ({
                orderLineId: `${order.orderNumber}-${idx + 1}`,
                itemId: item.sku,
                orderedQuantity: { value: item.quantity, unitOfMeasure: 'EA' }
            }))
        };

        const response = await this.request('POST', '/fulfillment/v1/orders', byOrder);

        return {
            success: true,
            wmsOrderId: response.fulfillmentOrderId,
            status: response.orderStatus,
            estimatedShipDate: response.estimatedShipDate
        };
    }

    async getOrderStatus(orderNumber) {
        const response = await this.request('GET', `/fulfillment/v1/orders/${orderNumber}`);

        return {
            orderNumber: response.orderId,
            status: this.mapStatus(response.orderStatus),
            wmsStatus: response.orderStatus,
            fulfilledLines: response.orderLines?.filter(l => l.status === 'FULFILLED').length || 0,
            totalLines: response.orderLines?.length || 0,
            shipments: response.shipments?.map(s => ({
                shipmentId: s.shipmentId,
                trackingNumber: s.trackingNumber,
                carrier: s.carrierId,
                status: s.shipmentStatus
            })) || []
        };
    }

    async confirmShipment(shipmentData) {
        const response = await this.request('POST', `/fulfillment/v1/orders/${shipmentData.orderNumber}/ship`, {
            shipmentId: shipmentData.shipmentId,
            trackingNumber: shipmentData.trackingNumber,
            carrierId: shipmentData.carrier,
            shipDate: new Date().toISOString(),
            packages: shipmentData.packages
        });

        return {
            success: true,
            shipmentId: response.shipmentId
        };
    }

    mapStatus(byStatus) {
        const mapping = {
            'CREATED': 'pending',
            'RELEASED_FOR_FULFILLMENT': 'processing',
            'IN_PICKING': 'picking',
            'PICKED': 'picked',
            'IN_PACKING': 'packing',
            'READY_TO_SHIP': 'packed',
            'SHIPPED': 'shipped',
            'DELIVERED': 'delivered',
            'CANCELLED': 'cancelled'
        };
        return mapping[byStatus] || 'unknown';
    }
}

// ==========================================
// SAP EXTENDED WAREHOUSE MANAGEMENT (EWM)
// ==========================================

class SAPEWMConnector extends BaseWMSConnector {
    constructor(config) {
        super(config);
        this.warehouseNumber = config.warehouseNumber;
        this.client = config.client;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
            'sap-client': this.client,
            'X-CSRF-Token': 'Fetch'
        };
    }

    async getCSRFToken() {
        const response = await fetch(`${this.baseUrl}/sap/opu/odata/sap/API_WAREHOUSE_OUTBOUND_DELIVERY_SRV`, {
            method: 'GET',
            headers: this.getHeaders()
        });

        return response.headers.get('x-csrf-token');
    }

    async getInventory(filters = {}) {
        const params = new URLSearchParams({
            $filter: this.buildODataFilter(filters),
            $select: 'Material,Batch,StorageBin,AvailableStock,StockType'
        });

        const response = await this.request('GET', `/sap/opu/odata/sap/API_WAREHOUSE_STOCK_SRV/WarehouseStock?${params}`);

        return response.d.results.map(stock => ({
            sku: stock.Material,
            batch: stock.Batch,
            location: stock.StorageBin,
            quantity: parseFloat(stock.AvailableStock),
            stockType: stock.StockType,
            warehouse: this.warehouseNumber
        }));
    }

    async createOutboundOrder(order) {
        const csrfToken = await this.getCSRFToken();

        const ewmOrder = {
            WarehouseNumber: this.warehouseNumber,
            OutboundDeliveryOrder: order.orderNumber,
            ShipToParty: order.recipient.customerId,
            RequestedDeliveryDate: this.formatSAPDate(order.requestedDeliveryDate),
            ShippingCondition: order.shippingCondition || '01',
            to_Item: order.items.map((item, idx) => ({
                OutboundDeliveryOrderItem: String(idx + 1).padStart(6, '0'),
                Material: item.sku,
                RequestedQuantity: item.quantity,
                RequestedQuantityUnit: item.unit || 'EA'
            }))
        };

        const response = await fetch(`${this.baseUrl}/sap/opu/odata/sap/API_WAREHOUSE_OUTBOUND_DELIVERY_SRV/OutboundDeliveryOrder`, {
            method: 'POST',
            headers: {
                ...this.getHeaders(),
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify(ewmOrder)
        });

        const data = await response.json();

        return {
            success: true,
            wmsOrderId: data.d.OutboundDeliveryOrder,
            status: data.d.OverallStatus
        };
    }

    async getOrderStatus(orderNumber) {
        const response = await this.request('GET', 
            `/sap/opu/odata/sap/API_WAREHOUSE_OUTBOUND_DELIVERY_SRV/OutboundDeliveryOrder('${orderNumber}')?$expand=to_Item`
        );

        return {
            orderNumber: response.d.OutboundDeliveryOrder,
            status: this.mapStatus(response.d.OverallStatus),
            wmsStatus: response.d.OverallStatus,
            items: response.d.to_Item?.results.map(item => ({
                sku: item.Material,
                orderedQty: parseFloat(item.RequestedQuantity),
                pickedQty: parseFloat(item.PickedQuantity),
                packedQty: parseFloat(item.PackedQuantity)
            }))
        };
    }

    async confirmShipment(shipmentData) {
        const csrfToken = await this.getCSRFToken();

        const response = await fetch(
            `${this.baseUrl}/sap/opu/odata/sap/API_WAREHOUSE_OUTBOUND_DELIVERY_SRV/ConfirmShipment`,
            {
                method: 'POST',
                headers: {
                    ...this.getHeaders(),
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    OutboundDeliveryOrder: shipmentData.orderNumber,
                    TrackingNumber: shipmentData.trackingNumber,
                    Carrier: shipmentData.carrier,
                    ActualGoodsIssueDate: this.formatSAPDate(new Date())
                })
            }
        );

        return { success: response.ok };
    }

    buildODataFilter(filters) {
        const conditions = [];
        conditions.push(`WarehouseNumber eq '${this.warehouseNumber}'`);
        if (filters.sku) conditions.push(`Material eq '${filters.sku}'`);
        if (filters.location) conditions.push(`StorageBin eq '${filters.location}'`);
        return conditions.join(' and ');
    }

    formatSAPDate(date) {
        return `/Date(${new Date(date).getTime()})/`;
    }

    mapStatus(sapStatus) {
        const mapping = {
            'A': 'pending',
            'B': 'processing',
            'C': 'shipped'
        };
        return mapping[sapStatus] || 'unknown';
    }
}

// ==========================================
// ORACLE WMS CLOUD
// ==========================================

class OracleWMSConnector extends BaseWMSConnector {
    constructor(config) {
        super(config);
        this.facilityId = config.facilityId;
    }

    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'X-Oracle-Facility': this.facilityId
        };
    }

    async getInventory(filters = {}) {
        const params = new URLSearchParams({
            facilityId: this.facilityId,
            ...(filters.sku && { itemNumber: filters.sku })
        });

        const response = await this.request('GET', `/wms/v1/inventory?${params}`);

        return response.items.map(item => ({
            sku: item.itemNumber,
            name: item.itemDescription,
            quantity: item.availableQuantity,
            allocated: item.allocatedQuantity,
            onHold: item.onHoldQuantity,
            location: item.locationId,
            lpn: item.lpnNumber
        }));
    }

    async createOutboundOrder(order) {
        const oracleOrder = {
            orderNumber: order.orderNumber,
            orderType: 'SALES',
            facilityId: this.facilityId,
            shipToAddress: {
                name: order.recipient.name,
                address1: order.recipient.address1,
                city: order.recipient.city,
                state: order.recipient.state,
                postalCode: order.recipient.postalCode,
                country: order.recipient.country
            },
            carrier: order.carrier,
            serviceLevel: order.service,
            orderLines: order.items.map(item => ({
                itemNumber: item.sku,
                quantity: item.quantity
            }))
        };

        const response = await this.request('POST', '/wms/v1/orders', oracleOrder);

        return {
            success: true,
            wmsOrderId: response.orderId,
            status: response.status
        };
    }

    async getOrderStatus(orderNumber) {
        const response = await this.request('GET', `/wms/v1/orders/${orderNumber}`);

        return {
            orderNumber: response.orderNumber,
            status: this.mapStatus(response.status),
            wmsStatus: response.status,
            shipments: response.shipments || []
        };
    }

    async confirmShipment(shipmentData) {
        const response = await this.request('POST', `/wms/v1/orders/${shipmentData.orderNumber}/ship`, {
            trackingNumber: shipmentData.trackingNumber,
            carrier: shipmentData.carrier
        });

        return { success: true, shipmentId: response.shipmentId };
    }

    mapStatus(status) {
        const mapping = {
            'NEW': 'pending',
            'ALLOCATED': 'processing',
            'PICKING': 'picking',
            'PICKED': 'picked',
            'PACKING': 'packing',
            'SHIPPED': 'shipped'
        };
        return mapping[status] || 'unknown';
    }
}

// ==========================================
// HIGHJUMP (Körber) WMS
// ==========================================

class HighJumpWMSConnector extends BaseWMSConnector {
    constructor(config) {
        super(config);
        this.companyCode = config.companyCode;
        this.warehouseCode = config.warehouseCode;
    }

    async getInventory(filters = {}) {
        const response = await this.request('POST', '/api/inventory/query', {
            companyCode: this.companyCode,
            warehouseCode: this.warehouseCode,
            filters: {
                itemNumber: filters.sku,
                locationId: filters.location
            }
        });

        return response.inventoryRecords.map(inv => ({
            sku: inv.itemNumber,
            description: inv.itemDescription,
            quantity: inv.quantityOnHand,
            available: inv.quantityAvailable,
            allocated: inv.quantityAllocated,
            location: inv.locationId,
            lot: inv.lotNumber
        }));
    }

    async createOutboundOrder(order) {
        const hjOrder = {
            companyCode: this.companyCode,
            warehouseCode: this.warehouseCode,
            orderNumber: order.orderNumber,
            orderType: 'SO',
            shipTo: {
                name: order.recipient.name,
                address1: order.recipient.address1,
                city: order.recipient.city,
                state: order.recipient.state,
                zip: order.recipient.postalCode,
                country: order.recipient.country
            },
            carrier: {
                code: order.carrier,
                service: order.service
            },
            lines: order.items.map((item, idx) => ({
                lineNumber: idx + 1,
                itemNumber: item.sku,
                quantityOrdered: item.quantity
            }))
        };

        const response = await this.request('POST', '/api/orders/outbound', hjOrder);

        return {
            success: true,
            wmsOrderId: response.orderKey,
            status: response.status
        };
    }

    async getOrderStatus(orderNumber) {
        const response = await this.request('GET', `/api/orders/outbound/${orderNumber}`);

        return {
            orderNumber: response.orderNumber,
            status: this.mapStatus(response.status),
            wmsStatus: response.status,
            pickedLines: response.lines?.filter(l => l.quantityPicked > 0).length || 0,
            totalLines: response.lines?.length || 0
        };
    }

    async confirmShipment(shipmentData) {
        const response = await this.request('POST', `/api/orders/outbound/${shipmentData.orderNumber}/confirm`, {
            trackingNumber: shipmentData.trackingNumber,
            carrierCode: shipmentData.carrier,
            shipDate: new Date().toISOString()
        });

        return { success: true };
    }

    mapStatus(status) {
        const mapping = {
            '10': 'pending',
            '20': 'processing',
            '30': 'picking',
            '40': 'picked',
            '50': 'packing',
            '60': 'shipped'
        };
        return mapping[status] || 'unknown';
    }
}

// ==========================================
// WMS SERVICE (Unified)
// ==========================================

class WMSService {
    constructor() {
        this.connectors = new Map();
    }

    registerConnector(wmsType, config) {
        const connectorClasses = {
            manhattan: ManhattanWMSConnector,
            blueyonder: BlueYonderWMSConnector,
            sap_ewm: SAPEWMConnector,
            oracle: OracleWMSConnector,
            highjump: HighJumpWMSConnector
        };

        const ConnectorClass = connectorClasses[wmsType];
        if (!ConnectorClass) {
            throw new Error(`Unknown WMS type: ${wmsType}`);
        }

        this.connectors.set(config.id || wmsType, new ConnectorClass(config));
    }

    getConnector(connectorId) {
        return this.connectors.get(connectorId);
    }

    async getInventoryFromAll() {
        const results = [];
        for (const [id, connector] of this.connectors) {
            try {
                const inventory = await connector.getInventory();
                results.push({ wmsId: id, inventory });
            } catch (error) {
                results.push({ wmsId: id, error: error.message });
            }
        }
        return results;
    }

    async syncOrderToWMS(wmsId, order) {
        const connector = this.connectors.get(wmsId);
        if (!connector) throw new Error(`WMS connector not found: ${wmsId}`);
        return connector.createOutboundOrder(order);
    }
}

module.exports = { 
    WMSService,
    ManhattanWMSConnector,
    BlueYonderWMSConnector,
    SAPEWMConnector,
    OracleWMSConnector,
    HighJumpWMSConnector
};
