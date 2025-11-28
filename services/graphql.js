/**
 * Routz v4.0 - GraphQL API
 * API GraphQL complète avec subscriptions temps réel
 */

const { 
    GraphQLSchema, 
    GraphQLObjectType, 
    GraphQLString, 
    GraphQLInt, 
    GraphQLFloat,
    GraphQLBoolean,
    GraphQLList,
    GraphQLNonNull,
    GraphQLInputObjectType,
    GraphQLEnumType,
    GraphQLID
} = require('graphql');

// ==========================================
// ENUMS
// ==========================================

const ShipmentStatusEnum = new GraphQLEnumType({
    name: 'ShipmentStatus',
    values: {
        PENDING: { value: 'pending' },
        PROCESSING: { value: 'processing' },
        SHIPPED: { value: 'shipped' },
        IN_TRANSIT: { value: 'in_transit' },
        OUT_FOR_DELIVERY: { value: 'out_for_delivery' },
        DELIVERED: { value: 'delivered' },
        RETURNED: { value: 'returned' },
        EXCEPTION: { value: 'exception' },
        CANCELLED: { value: 'cancelled' }
    }
});

const CarrierEnum = new GraphQLEnumType({
    name: 'Carrier',
    values: {
        COLISSIMO: { value: 'colissimo' },
        CHRONOPOST: { value: 'chronopost' },
        MONDIAL_RELAY: { value: 'mondial_relay' },
        RELAIS_COLIS: { value: 'relais_colis' },
        DHL: { value: 'dhl' },
        UPS: { value: 'ups' },
        FEDEX: { value: 'fedex' },
        DPD: { value: 'dpd' },
        GLS: { value: 'gls' }
    }
});

const OrderStatusEnum = new GraphQLEnumType({
    name: 'OrderStatus',
    values: {
        NEW: { value: 'new' },
        PROCESSING: { value: 'processing' },
        READY: { value: 'ready' },
        SHIPPED: { value: 'shipped' },
        DELIVERED: { value: 'delivered' },
        CANCELLED: { value: 'cancelled' }
    }
});

const SortOrderEnum = new GraphQLEnumType({
    name: 'SortOrder',
    values: {
        ASC: { value: 'ASC' },
        DESC: { value: 'DESC' }
    }
});

// ==========================================
// TYPES
// ==========================================

const AddressType = new GraphQLObjectType({
    name: 'Address',
    fields: () => ({
        name: { type: GraphQLString },
        company: { type: GraphQLString },
        line1: { type: GraphQLString },
        line2: { type: GraphQLString },
        city: { type: GraphQLString },
        postalCode: { type: GraphQLString },
        country: { type: GraphQLString },
        phone: { type: GraphQLString },
        email: { type: GraphQLString }
    })
});

const ParcelType = new GraphQLObjectType({
    name: 'Parcel',
    fields: () => ({
        weight: { type: GraphQLFloat },
        length: { type: GraphQLFloat },
        width: { type: GraphQLFloat },
        height: { type: GraphQLFloat },
        quantity: { type: GraphQLInt }
    })
});

const TrackingEventType = new GraphQLObjectType({
    name: 'TrackingEvent',
    fields: () => ({
        status: { type: GraphQLString },
        description: { type: GraphQLString },
        location: { type: GraphQLString },
        timestamp: { type: GraphQLString }
    })
});

const LabelType = new GraphQLObjectType({
    name: 'Label',
    fields: () => ({
        format: { type: GraphQLString },
        url: { type: GraphQLString },
        base64: { type: GraphQLString }
    })
});

const ShipmentType = new GraphQLObjectType({
    name: 'Shipment',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        trackingNumber: { type: GraphQLString },
        carrier: { type: CarrierEnum },
        service: { type: GraphQLString },
        status: { type: ShipmentStatusEnum },
        sender: { type: AddressType },
        recipient: { type: AddressType },
        parcels: { type: new GraphQLList(ParcelType) },
        label: { type: LabelType },
        trackingEvents: { type: new GraphQLList(TrackingEventType) },
        estimatedDelivery: { type: GraphQLString },
        actualDelivery: { type: GraphQLString },
        cost: { type: GraphQLFloat },
        orderId: { type: GraphQLString },
        reference: { type: GraphQLString },
        metadata: { type: GraphQLString },
        createdAt: { type: GraphQLString },
        updatedAt: { type: GraphQLString }
    })
});

const OrderItemType = new GraphQLObjectType({
    name: 'OrderItem',
    fields: () => ({
        sku: { type: GraphQLString },
        name: { type: GraphQLString },
        quantity: { type: GraphQLInt },
        price: { type: GraphQLFloat },
        weight: { type: GraphQLFloat }
    })
});

const OrderType = new GraphQLObjectType({
    name: 'Order',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        orderNumber: { type: GraphQLString },
        externalId: { type: GraphQLString },
        channel: { type: GraphQLString },
        status: { type: OrderStatusEnum },
        customer: { type: AddressType },
        shippingAddress: { type: AddressType },
        billingAddress: { type: AddressType },
        items: { type: new GraphQLList(OrderItemType) },
        subtotal: { type: GraphQLFloat },
        shippingCost: { type: GraphQLFloat },
        tax: { type: GraphQLFloat },
        total: { type: GraphQLFloat },
        currency: { type: GraphQLString },
        shipments: { type: new GraphQLList(ShipmentType) },
        notes: { type: GraphQLString },
        createdAt: { type: GraphQLString },
        updatedAt: { type: GraphQLString }
    })
});

const CustomerType = new GraphQLObjectType({
    name: 'Customer',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        email: { type: GraphQLString },
        firstName: { type: GraphQLString },
        lastName: { type: GraphQLString },
        phone: { type: GraphQLString },
        address: { type: AddressType },
        totalOrders: { type: GraphQLInt },
        totalSpent: { type: GraphQLFloat },
        averageOrderValue: { type: GraphQLFloat },
        lastOrderAt: { type: GraphQLString },
        isVip: { type: GraphQLBoolean },
        createdAt: { type: GraphQLString }
    })
});

const WarehouseType = new GraphQLObjectType({
    name: 'Warehouse',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        name: { type: GraphQLString },
        code: { type: GraphQLString },
        type: { type: GraphQLString },
        status: { type: GraphQLString },
        address: { type: AddressType },
        priority: { type: GraphQLInt },
        productCount: { type: GraphQLInt },
        orderCount: { type: GraphQLInt },
        utilization: { type: GraphQLFloat }
    })
});

const InventoryItemType = new GraphQLObjectType({
    name: 'InventoryItem',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        sku: { type: GraphQLString },
        productName: { type: GraphQLString },
        warehouse: { type: WarehouseType },
        location: { type: GraphQLString },
        quantity: { type: GraphQLInt },
        reserved: { type: GraphQLInt },
        available: { type: GraphQLInt },
        reorderPoint: { type: GraphQLInt },
        costPrice: { type: GraphQLFloat },
        status: { type: GraphQLString }
    })
});

const CarrierRateType = new GraphQLObjectType({
    name: 'CarrierRate',
    fields: () => ({
        carrier: { type: CarrierEnum },
        service: { type: GraphQLString },
        serviceName: { type: GraphQLString },
        price: { type: GraphQLFloat },
        currency: { type: GraphQLString },
        estimatedDays: { type: GraphQLInt },
        estimatedDelivery: { type: GraphQLString }
    })
});

const AnalyticsType = new GraphQLObjectType({
    name: 'Analytics',
    fields: () => ({
        period: { type: GraphQLString },
        shipments: { type: GraphQLInt },
        delivered: { type: GraphQLInt },
        deliveryRate: { type: GraphQLFloat },
        averageDeliveryDays: { type: GraphQLFloat },
        revenue: { type: GraphQLFloat },
        shippingCosts: { type: GraphQLFloat },
        topCarriers: { type: new GraphQLList(GraphQLString) }
    })
});

const PaginationType = new GraphQLObjectType({
    name: 'Pagination',
    fields: () => ({
        total: { type: GraphQLInt },
        page: { type: GraphQLInt },
        perPage: { type: GraphQLInt },
        totalPages: { type: GraphQLInt },
        hasNext: { type: GraphQLBoolean },
        hasPrev: { type: GraphQLBoolean }
    })
});

const ShipmentConnectionType = new GraphQLObjectType({
    name: 'ShipmentConnection',
    fields: () => ({
        nodes: { type: new GraphQLList(ShipmentType) },
        pagination: { type: PaginationType }
    })
});

const OrderConnectionType = new GraphQLObjectType({
    name: 'OrderConnection',
    fields: () => ({
        nodes: { type: new GraphQLList(OrderType) },
        pagination: { type: PaginationType }
    })
});

// ==========================================
// INPUT TYPES
// ==========================================

const AddressInput = new GraphQLInputObjectType({
    name: 'AddressInput',
    fields: () => ({
        name: { type: new GraphQLNonNull(GraphQLString) },
        company: { type: GraphQLString },
        line1: { type: new GraphQLNonNull(GraphQLString) },
        line2: { type: GraphQLString },
        city: { type: new GraphQLNonNull(GraphQLString) },
        postalCode: { type: new GraphQLNonNull(GraphQLString) },
        country: { type: new GraphQLNonNull(GraphQLString) },
        phone: { type: GraphQLString },
        email: { type: GraphQLString }
    })
});

const ParcelInput = new GraphQLInputObjectType({
    name: 'ParcelInput',
    fields: () => ({
        weight: { type: new GraphQLNonNull(GraphQLFloat) },
        length: { type: GraphQLFloat },
        width: { type: GraphQLFloat },
        height: { type: GraphQLFloat },
        quantity: { type: GraphQLInt }
    })
});

const CreateShipmentInput = new GraphQLInputObjectType({
    name: 'CreateShipmentInput',
    fields: () => ({
        carrier: { type: new GraphQLNonNull(CarrierEnum) },
        service: { type: new GraphQLNonNull(GraphQLString) },
        sender: { type: AddressInput },
        recipient: { type: new GraphQLNonNull(AddressInput) },
        parcels: { type: new GraphQLNonNull(new GraphQLList(ParcelInput)) },
        orderId: { type: GraphQLString },
        reference: { type: GraphQLString },
        metadata: { type: GraphQLString }
    })
});

const ShipmentFilterInput = new GraphQLInputObjectType({
    name: 'ShipmentFilterInput',
    fields: () => ({
        status: { type: ShipmentStatusEnum },
        carrier: { type: CarrierEnum },
        dateFrom: { type: GraphQLString },
        dateTo: { type: GraphQLString },
        search: { type: GraphQLString }
    })
});

const GetRatesInput = new GraphQLInputObjectType({
    name: 'GetRatesInput',
    fields: () => ({
        sender: { type: new GraphQLNonNull(AddressInput) },
        recipient: { type: new GraphQLNonNull(AddressInput) },
        parcels: { type: new GraphQLNonNull(new GraphQLList(ParcelInput)) },
        carriers: { type: new GraphQLList(CarrierEnum) }
    })
});

// ==========================================
// QUERIES
// ==========================================

const QueryType = new GraphQLObjectType({
    name: 'Query',
    fields: () => ({
        // Shipments
        shipment: {
            type: ShipmentType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) }
            },
            resolve: async (_, { id }, context) => {
                return context.dataSources.shipments.getById(id);
            }
        },
        shipmentByTracking: {
            type: ShipmentType,
            args: {
                trackingNumber: { type: new GraphQLNonNull(GraphQLString) }
            },
            resolve: async (_, { trackingNumber }, context) => {
                return context.dataSources.shipments.getByTracking(trackingNumber);
            }
        },
        shipments: {
            type: ShipmentConnectionType,
            args: {
                filter: { type: ShipmentFilterInput },
                page: { type: GraphQLInt },
                perPage: { type: GraphQLInt },
                sortBy: { type: GraphQLString },
                sortOrder: { type: SortOrderEnum }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.shipments.list(args);
            }
        },

        // Orders
        order: {
            type: OrderType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) }
            },
            resolve: async (_, { id }, context) => {
                return context.dataSources.orders.getById(id);
            }
        },
        orders: {
            type: OrderConnectionType,
            args: {
                status: { type: OrderStatusEnum },
                channel: { type: GraphQLString },
                page: { type: GraphQLInt },
                perPage: { type: GraphQLInt }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.orders.list(args);
            }
        },

        // Customers
        customer: {
            type: CustomerType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) }
            },
            resolve: async (_, { id }, context) => {
                return context.dataSources.customers.getById(id);
            }
        },
        customers: {
            type: new GraphQLList(CustomerType),
            args: {
                search: { type: GraphQLString },
                vipOnly: { type: GraphQLBoolean },
                limit: { type: GraphQLInt }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.customers.list(args);
            }
        },

        // Warehouses & Inventory
        warehouses: {
            type: new GraphQLList(WarehouseType),
            resolve: async (_, __, context) => {
                return context.dataSources.warehouses.list();
            }
        },
        inventory: {
            type: new GraphQLList(InventoryItemType),
            args: {
                warehouseId: { type: GraphQLID },
                sku: { type: GraphQLString },
                lowStockOnly: { type: GraphQLBoolean }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.inventory.list(args);
            }
        },

        // Rates
        rates: {
            type: new GraphQLList(CarrierRateType),
            args: {
                input: { type: new GraphQLNonNull(GetRatesInput) }
            },
            resolve: async (_, { input }, context) => {
                return context.dataSources.carriers.getRates(input);
            }
        },

        // Analytics
        analytics: {
            type: AnalyticsType,
            args: {
                period: { type: GraphQLString },
                dateFrom: { type: GraphQLString },
                dateTo: { type: GraphQLString }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.analytics.get(args);
            }
        }
    })
});

// ==========================================
// MUTATIONS
// ==========================================

const MutationType = new GraphQLObjectType({
    name: 'Mutation',
    fields: () => ({
        // Shipments
        createShipment: {
            type: ShipmentType,
            args: {
                input: { type: new GraphQLNonNull(CreateShipmentInput) }
            },
            resolve: async (_, { input }, context) => {
                return context.dataSources.shipments.create(input);
            }
        },
        cancelShipment: {
            type: ShipmentType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) }
            },
            resolve: async (_, { id }, context) => {
                return context.dataSources.shipments.cancel(id);
            }
        },
        refreshTracking: {
            type: ShipmentType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) }
            },
            resolve: async (_, { id }, context) => {
                return context.dataSources.shipments.refreshTracking(id);
            }
        },

        // Orders
        syncOrders: {
            type: new GraphQLObjectType({
                name: 'SyncResult',
                fields: () => ({
                    synced: { type: GraphQLInt },
                    created: { type: GraphQLInt },
                    updated: { type: GraphQLInt },
                    errors: { type: GraphQLInt }
                })
            }),
            args: {
                channel: { type: new GraphQLNonNull(GraphQLString) }
            },
            resolve: async (_, { channel }, context) => {
                return context.dataSources.orders.sync(channel);
            }
        },
        updateOrderStatus: {
            type: OrderType,
            args: {
                id: { type: new GraphQLNonNull(GraphQLID) },
                status: { type: new GraphQLNonNull(OrderStatusEnum) }
            },
            resolve: async (_, { id, status }, context) => {
                return context.dataSources.orders.updateStatus(id, status);
            }
        },

        // Inventory
        adjustInventory: {
            type: InventoryItemType,
            args: {
                warehouseId: { type: new GraphQLNonNull(GraphQLID) },
                sku: { type: new GraphQLNonNull(GraphQLString) },
                adjustment: { type: new GraphQLNonNull(GraphQLInt) },
                reason: { type: GraphQLString }
            },
            resolve: async (_, args, context) => {
                return context.dataSources.inventory.adjust(args);
            }
        },

        // Labels
        printLabel: {
            type: new GraphQLObjectType({
                name: 'PrintResult',
                fields: () => ({
                    success: { type: GraphQLBoolean },
                    printerId: { type: GraphQLString },
                    jobId: { type: GraphQLString }
                })
            }),
            args: {
                shipmentId: { type: new GraphQLNonNull(GraphQLID) },
                printerId: { type: GraphQLString }
            },
            resolve: async (_, { shipmentId, printerId }, context) => {
                return context.dataSources.labels.print(shipmentId, printerId);
            }
        }
    })
});

// ==========================================
// SUBSCRIPTIONS
// ==========================================

const SubscriptionType = new GraphQLObjectType({
    name: 'Subscription',
    fields: () => ({
        shipmentUpdated: {
            type: ShipmentType,
            args: {
                trackingNumber: { type: GraphQLString }
            },
            subscribe: (_, { trackingNumber }, context) => {
                return context.pubsub.asyncIterator(
                    trackingNumber ? `SHIPMENT_${trackingNumber}` : 'SHIPMENT_UPDATED'
                );
            }
        },
        orderCreated: {
            type: OrderType,
            args: {
                channel: { type: GraphQLString }
            },
            subscribe: (_, { channel }, context) => {
                return context.pubsub.asyncIterator(
                    channel ? `ORDER_${channel}` : 'ORDER_CREATED'
                );
            }
        },
        inventoryAlert: {
            type: InventoryItemType,
            args: {
                warehouseId: { type: GraphQLID }
            },
            subscribe: (_, { warehouseId }, context) => {
                return context.pubsub.asyncIterator(
                    warehouseId ? `INVENTORY_${warehouseId}` : 'INVENTORY_ALERT'
                );
            }
        }
    })
});

// ==========================================
// SCHEMA
// ==========================================

const schema = new GraphQLSchema({
    query: QueryType,
    mutation: MutationType,
    subscription: SubscriptionType
});

// ==========================================
// EXPRESS MIDDLEWARE
// ==========================================

const { graphqlHTTP } = require('express-graphql');
const DataLoader = require('dataloader');

const createGraphQLMiddleware = (services) => {
    return graphqlHTTP((req) => ({
        schema,
        graphiql: process.env.NODE_ENV !== 'production',
        context: {
            user: req.user,
            dataSources: {
                shipments: services.shipments,
                orders: services.orders,
                customers: services.customers,
                warehouses: services.warehouses,
                inventory: services.inventory,
                carriers: services.carriers,
                analytics: services.analytics,
                labels: services.labels
            },
            loaders: {
                shipment: new DataLoader(ids => services.shipments.getByIds(ids)),
                order: new DataLoader(ids => services.orders.getByIds(ids)),
                customer: new DataLoader(ids => services.customers.getByIds(ids))
            }
        }
    }));
};

module.exports = { schema, createGraphQLMiddleware };
