/**
 * Routz v4.0 - GraphQL API
 * Schema complet avec resolvers
 */

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { PubSub, withFilter } = require('graphql-subscriptions');
const DataLoader = require('dataloader');

const pubsub = new PubSub();

// ==========================================
// SCHEMA DEFINITIONS
// ==========================================

const typeDefs = `#graphql
  # ==========================================
  # SCALARS
  # ==========================================
  scalar DateTime
  scalar JSON
  scalar Upload

  # ==========================================
  # ENUMS
  # ==========================================
  enum ShipmentStatus {
    PENDING
    PROCESSING
    LABEL_CREATED
    SHIPPED
    IN_TRANSIT
    OUT_FOR_DELIVERY
    DELIVERED
    RETURNED
    EXCEPTION
    CANCELLED
  }

  enum OrderStatus {
    NEW
    PROCESSING
    READY
    SHIPPED
    DELIVERED
    CANCELLED
    REFUNDED
  }

  enum CarrierCode {
    COLISSIMO
    CHRONOPOST
    MONDIAL_RELAY
    RELAIS_COLIS
    DHL
    UPS
    FEDEX
    DPD
    GLS
    TNT
  }

  enum ServiceType {
    STANDARD
    EXPRESS
    ECONOMY
    SAME_DAY
    RELAY_POINT
  }

  enum WebhookEvent {
    SHIPMENT_CREATED
    SHIPMENT_SHIPPED
    SHIPMENT_IN_TRANSIT
    SHIPMENT_DELIVERED
    SHIPMENT_EXCEPTION
    ORDER_CREATED
    ORDER_UPDATED
    RETURN_CREATED
    RETURN_RECEIVED
    LABEL_GENERATED
    TRACKING_UPDATED
  }

  enum SortOrder {
    ASC
    DESC
  }

  # ==========================================
  # INPUT TYPES
  # ==========================================
  input AddressInput {
    firstName: String!
    lastName: String!
    company: String
    line1: String!
    line2: String
    city: String!
    postalCode: String!
    country: String!
    phone: String
    email: String
  }

  input ParcelInput {
    weight: Float!
    length: Float
    width: Float
    height: Float
    reference: String
  }

  input CreateShipmentInput {
    orderId: String
    carrier: CarrierCode!
    service: ServiceType!
    sender: AddressInput!
    recipient: AddressInput!
    parcels: [ParcelInput!]!
    options: ShipmentOptionsInput
  }

  input ShipmentOptionsInput {
    signature: Boolean
    insurance: Boolean
    insuranceValue: Float
    saturdayDelivery: Boolean
    returnLabel: Boolean
    customsInfo: CustomsInfoInput
  }

  input CustomsInfoInput {
    contents: String!
    value: Float!
    currency: String!
    items: [CustomsItemInput!]!
  }

  input CustomsItemInput {
    description: String!
    quantity: Int!
    value: Float!
    weight: Float!
    hsCode: String
    originCountry: String!
  }

  input ShipmentFilterInput {
    status: [ShipmentStatus!]
    carrier: [CarrierCode!]
    dateFrom: DateTime
    dateTo: DateTime
    search: String
  }

  input PaginationInput {
    page: Int = 1
    limit: Int = 20
  }

  input SortInput {
    field: String!
    order: SortOrder = DESC
  }

  input CreateWebhookInput {
    url: String!
    events: [WebhookEvent!]!
    secret: String
    active: Boolean = true
  }

  input RateRequestInput {
    sender: AddressInput!
    recipient: AddressInput!
    parcels: [ParcelInput!]!
    carriers: [CarrierCode!]
  }

  # ==========================================
  # TYPES
  # ==========================================
  type Address {
    firstName: String!
    lastName: String!
    fullName: String!
    company: String
    line1: String!
    line2: String
    city: String!
    postalCode: String!
    country: String!
    phone: String
    email: String
    formatted: String!
  }

  type Parcel {
    id: ID!
    weight: Float!
    length: Float
    width: Float
    height: Float
    reference: String
    trackingNumber: String
  }

  type Shipment {
    id: ID!
    orderId: String
    trackingNumber: String!
    carrier: Carrier!
    service: ServiceType!
    status: ShipmentStatus!
    sender: Address!
    recipient: Address!
    parcels: [Parcel!]!
    label: Label
    trackingEvents: [TrackingEvent!]!
    estimatedDelivery: DateTime
    actualDelivery: DateTime
    shippingCost: Money
    options: ShipmentOptions
    createdAt: DateTime!
    updatedAt: DateTime!
    # Relations
    order: Order
    returns: [Return!]!
  }

  type ShipmentOptions {
    signature: Boolean
    insurance: Boolean
    insuranceValue: Float
    saturdayDelivery: Boolean
    returnLabel: Boolean
  }

  type Label {
    id: ID!
    format: String!
    url: String!
    base64: String
    createdAt: DateTime!
  }

  type TrackingEvent {
    id: ID!
    status: ShipmentStatus!
    description: String!
    location: String
    timestamp: DateTime!
    carrierCode: String
  }

  type Carrier {
    code: CarrierCode!
    name: String!
    logo: String
    services: [CarrierService!]!
    trackingUrl: String
  }

  type CarrierService {
    code: ServiceType!
    name: String!
    estimatedDays: Int!
    features: [String!]!
  }

  type Order {
    id: ID!
    orderNumber: String!
    externalId: String
    channel: String!
    status: OrderStatus!
    customer: Customer!
    items: [OrderItem!]!
    shippingAddress: Address!
    billingAddress: Address
    subtotal: Money!
    shippingCost: Money!
    tax: Money!
    total: Money!
    shipments: [Shipment!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type OrderItem {
    id: ID!
    sku: String!
    name: String!
    quantity: Int!
    price: Money!
    weight: Float
    imageUrl: String
  }

  type Customer {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    fullName: String!
    phone: String
    ordersCount: Int!
    totalSpent: Money!
    addresses: [Address!]!
    orders: [Order!]!
    createdAt: DateTime!
  }

  type Return {
    id: ID!
    shipmentId: ID!
    reason: String!
    status: String!
    trackingNumber: String
    label: Label
    createdAt: DateTime!
    receivedAt: DateTime
  }

  type Money {
    amount: Float!
    currency: String!
    formatted: String!
  }

  type Rate {
    carrier: Carrier!
    service: CarrierService!
    price: Money!
    estimatedDays: Int!
    deliveryDate: DateTime
  }

  type Webhook {
    id: ID!
    url: String!
    events: [WebhookEvent!]!
    secret: String
    active: Boolean!
    lastTriggered: DateTime
    failureCount: Int!
    createdAt: DateTime!
  }

  type WebhookDelivery {
    id: ID!
    webhookId: ID!
    event: WebhookEvent!
    payload: JSON!
    responseCode: Int
    responseBody: String
    success: Boolean!
    duration: Int!
    createdAt: DateTime!
  }

  # ==========================================
  # ANALYTICS TYPES
  # ==========================================
  type DashboardStats {
    shipmentsToday: Int!
    shipmentsThisWeek: Int!
    shipmentsThisMonth: Int!
    deliveryRate: Float!
    averageDeliveryTime: Float!
    topCarriers: [CarrierStats!]!
    recentActivity: [ActivityItem!]!
  }

  type CarrierStats {
    carrier: Carrier!
    shipments: Int!
    deliveryRate: Float!
    averageTime: Float!
  }

  type ActivityItem {
    type: String!
    message: String!
    timestamp: DateTime!
    metadata: JSON
  }

  type ShipmentAnalytics {
    period: String!
    totalShipments: Int!
    delivered: Int!
    inTransit: Int!
    exceptions: Int!
    byCarrier: [CarrierAnalytics!]!
    byDay: [DayAnalytics!]!
  }

  type CarrierAnalytics {
    carrier: CarrierCode!
    count: Int!
    percentage: Float!
  }

  type DayAnalytics {
    date: DateTime!
    count: Int!
    delivered: Int!
  }

  # ==========================================
  # PAGINATION
  # ==========================================
  type PageInfo {
    currentPage: Int!
    totalPages: Int!
    totalItems: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  type ShipmentConnection {
    items: [Shipment!]!
    pageInfo: PageInfo!
  }

  type OrderConnection {
    items: [Order!]!
    pageInfo: PageInfo!
  }

  type CustomerConnection {
    items: [Customer!]!
    pageInfo: PageInfo!
  }

  # ==========================================
  # QUERIES
  # ==========================================
  type Query {
    # Shipments
    shipment(id: ID!): Shipment
    shipmentByTracking(trackingNumber: String!): Shipment
    shipments(
      filter: ShipmentFilterInput
      pagination: PaginationInput
      sort: SortInput
    ): ShipmentConnection!

    # Orders
    order(id: ID!): Order
    orderByNumber(orderNumber: String!): Order
    orders(
      status: [OrderStatus!]
      channel: String
      pagination: PaginationInput
    ): OrderConnection!

    # Customers
    customer(id: ID!): Customer
    customerByEmail(email: String!): Customer
    customers(
      search: String
      pagination: PaginationInput
    ): CustomerConnection!

    # Carriers & Rates
    carriers: [Carrier!]!
    carrier(code: CarrierCode!): Carrier
    rates(input: RateRequestInput!): [Rate!]!

    # Returns
    return(id: ID!): Return
    returns(shipmentId: ID): [Return!]!

    # Webhooks
    webhooks: [Webhook!]!
    webhook(id: ID!): Webhook
    webhookDeliveries(webhookId: ID!, limit: Int = 20): [WebhookDelivery!]!

    # Analytics
    dashboardStats: DashboardStats!
    shipmentAnalytics(
      dateFrom: DateTime!
      dateTo: DateTime!
    ): ShipmentAnalytics!

    # Search
    search(query: String!, types: [String!]): SearchResult!
  }

  type SearchResult {
    shipments: [Shipment!]!
    orders: [Order!]!
    customers: [Customer!]!
  }

  # ==========================================
  # MUTATIONS
  # ==========================================
  type Mutation {
    # Shipments
    createShipment(input: CreateShipmentInput!): Shipment!
    createBulkShipments(inputs: [CreateShipmentInput!]!): BulkShipmentResult!
    cancelShipment(id: ID!): Shipment!
    regenerateLabel(id: ID!, format: String): Label!

    # Orders
    syncOrders(channel: String!): SyncResult!
    updateOrderStatus(id: ID!, status: OrderStatus!): Order!

    # Returns
    createReturn(shipmentId: ID!, reason: String!): Return!
    markReturnReceived(id: ID!): Return!

    # Webhooks
    createWebhook(input: CreateWebhookInput!): Webhook!
    updateWebhook(id: ID!, input: CreateWebhookInput!): Webhook!
    deleteWebhook(id: ID!): Boolean!
    testWebhook(id: ID!): WebhookDelivery!

    # Tracking
    refreshTracking(shipmentId: ID!): Shipment!
    bulkRefreshTracking(shipmentIds: [ID!]!): [Shipment!]!
  }

  type BulkShipmentResult {
    successful: [Shipment!]!
    failed: [BulkShipmentError!]!
    totalSuccess: Int!
    totalFailed: Int!
  }

  type BulkShipmentError {
    index: Int!
    message: String!
    code: String!
  }

  type SyncResult {
    imported: Int!
    updated: Int!
    errors: Int!
    duration: Int!
  }

  # ==========================================
  # SUBSCRIPTIONS
  # ==========================================
  type Subscription {
    shipmentUpdated(id: ID): Shipment!
    trackingUpdated(trackingNumber: String): TrackingEvent!
    orderCreated: Order!
    webhookTriggered: WebhookDelivery!
  }
`;

// ==========================================
// RESOLVERS
// ==========================================

const resolvers = {
    Query: {
        // Shipments
        shipment: async (_, { id }, { dataSources }) => {
            return dataSources.shipments.getById(id);
        },
        
        shipmentByTracking: async (_, { trackingNumber }, { dataSources }) => {
            return dataSources.shipments.getByTracking(trackingNumber);
        },
        
        shipments: async (_, { filter, pagination, sort }, { dataSources }) => {
            const { page = 1, limit = 20 } = pagination || {};
            const result = await dataSources.shipments.list({ filter, page, limit, sort });
            return {
                items: result.items,
                pageInfo: {
                    currentPage: page,
                    totalPages: Math.ceil(result.total / limit),
                    totalItems: result.total,
                    hasNextPage: page * limit < result.total,
                    hasPreviousPage: page > 1
                }
            };
        },

        // Orders
        order: async (_, { id }, { dataSources }) => {
            return dataSources.orders.getById(id);
        },
        
        orders: async (_, { status, channel, pagination }, { dataSources }) => {
            const { page = 1, limit = 20 } = pagination || {};
            const result = await dataSources.orders.list({ status, channel, page, limit });
            return {
                items: result.items,
                pageInfo: {
                    currentPage: page,
                    totalPages: Math.ceil(result.total / limit),
                    totalItems: result.total,
                    hasNextPage: page * limit < result.total,
                    hasPreviousPage: page > 1
                }
            };
        },

        // Customers
        customer: async (_, { id }, { dataSources }) => {
            return dataSources.customers.getById(id);
        },
        
        customers: async (_, { search, pagination }, { dataSources }) => {
            const { page = 1, limit = 20 } = pagination || {};
            const result = await dataSources.customers.list({ search, page, limit });
            return {
                items: result.items,
                pageInfo: {
                    currentPage: page,
                    totalPages: Math.ceil(result.total / limit),
                    totalItems: result.total,
                    hasNextPage: page * limit < result.total,
                    hasPreviousPage: page > 1
                }
            };
        },

        // Carriers
        carriers: async (_, __, { dataSources }) => {
            return dataSources.carriers.list();
        },
        
        carrier: async (_, { code }, { dataSources }) => {
            return dataSources.carriers.getByCode(code);
        },
        
        rates: async (_, { input }, { dataSources }) => {
            return dataSources.carriers.getRates(input);
        },

        // Analytics
        dashboardStats: async (_, __, { dataSources }) => {
            return dataSources.analytics.getDashboardStats();
        },
        
        shipmentAnalytics: async (_, { dateFrom, dateTo }, { dataSources }) => {
            return dataSources.analytics.getShipmentAnalytics(dateFrom, dateTo);
        },

        // Webhooks
        webhooks: async (_, __, { dataSources }) => {
            return dataSources.webhooks.list();
        },
        
        webhook: async (_, { id }, { dataSources }) => {
            return dataSources.webhooks.getById(id);
        },

        // Search
        search: async (_, { query, types }, { dataSources }) => {
            const searchTypes = types || ['shipments', 'orders', 'customers'];
            const results = { shipments: [], orders: [], customers: [] };
            
            if (searchTypes.includes('shipments')) {
                results.shipments = await dataSources.shipments.search(query);
            }
            if (searchTypes.includes('orders')) {
                results.orders = await dataSources.orders.search(query);
            }
            if (searchTypes.includes('customers')) {
                results.customers = await dataSources.customers.search(query);
            }
            
            return results;
        }
    },

    Mutation: {
        // Shipments
        createShipment: async (_, { input }, { dataSources }) => {
            const shipment = await dataSources.shipments.create(input);
            pubsub.publish('SHIPMENT_CREATED', { shipmentUpdated: shipment });
            return shipment;
        },
        
        createBulkShipments: async (_, { inputs }, { dataSources }) => {
            const results = { successful: [], failed: [] };
            
            for (let i = 0; i < inputs.length; i++) {
                try {
                    const shipment = await dataSources.shipments.create(inputs[i]);
                    results.successful.push(shipment);
                } catch (error) {
                    results.failed.push({
                        index: i,
                        message: error.message,
                        code: error.code || 'UNKNOWN_ERROR'
                    });
                }
            }
            
            return {
                ...results,
                totalSuccess: results.successful.length,
                totalFailed: results.failed.length
            };
        },
        
        cancelShipment: async (_, { id }, { dataSources }) => {
            return dataSources.shipments.cancel(id);
        },

        // Webhooks
        createWebhook: async (_, { input }, { dataSources }) => {
            return dataSources.webhooks.create(input);
        },
        
        deleteWebhook: async (_, { id }, { dataSources }) => {
            await dataSources.webhooks.delete(id);
            return true;
        },
        
        testWebhook: async (_, { id }, { dataSources }) => {
            return dataSources.webhooks.test(id);
        },

        // Returns
        createReturn: async (_, { shipmentId, reason }, { dataSources }) => {
            return dataSources.returns.create(shipmentId, reason);
        },

        // Sync
        syncOrders: async (_, { channel }, { dataSources }) => {
            return dataSources.orders.sync(channel);
        }
    },

    Subscription: {
        shipmentUpdated: {
            subscribe: withFilter(
                () => pubsub.asyncIterator(['SHIPMENT_CREATED', 'SHIPMENT_UPDATED']),
                (payload, variables) => {
                    if (!variables.id) return true;
                    return payload.shipmentUpdated.id === variables.id;
                }
            )
        },
        
        trackingUpdated: {
            subscribe: withFilter(
                () => pubsub.asyncIterator(['TRACKING_UPDATED']),
                (payload, variables) => {
                    if (!variables.trackingNumber) return true;
                    return payload.trackingUpdated.trackingNumber === variables.trackingNumber;
                }
            )
        },
        
        orderCreated: {
            subscribe: () => pubsub.asyncIterator(['ORDER_CREATED'])
        }
    },

    // Field resolvers
    Shipment: {
        carrier: async (shipment, _, { loaders }) => {
            return loaders.carriers.load(shipment.carrierCode);
        },
        order: async (shipment, _, { loaders }) => {
            if (!shipment.orderId) return null;
            return loaders.orders.load(shipment.orderId);
        },
        trackingEvents: async (shipment, _, { dataSources }) => {
            return dataSources.tracking.getEvents(shipment.trackingNumber);
        }
    },

    Order: {
        customer: async (order, _, { loaders }) => {
            return loaders.customers.load(order.customerId);
        },
        shipments: async (order, _, { dataSources }) => {
            return dataSources.shipments.getByOrderId(order.id);
        }
    },

    Customer: {
        fullName: (customer) => `${customer.firstName} ${customer.lastName}`,
        orders: async (customer, _, { dataSources }) => {
            return dataSources.orders.getByCustomerId(customer.id);
        }
    },

    Address: {
        fullName: (address) => `${address.firstName} ${address.lastName}`,
        formatted: (address) => {
            const lines = [
                address.company,
                `${address.firstName} ${address.lastName}`,
                address.line1,
                address.line2,
                `${address.postalCode} ${address.city}`,
                address.country
            ].filter(Boolean);
            return lines.join('\n');
        }
    },

    Money: {
        formatted: (money) => {
            return new Intl.NumberFormat('fr-FR', {
                style: 'currency',
                currency: money.currency
            }).format(money.amount);
        }
    }
};

// ==========================================
// DATA LOADERS
// ==========================================

const createLoaders = (dataSources) => ({
    carriers: new DataLoader(async (codes) => {
        const carriers = await dataSources.carriers.getByCodesBatch(codes);
        return codes.map(code => carriers.find(c => c.code === code));
    }),
    
    orders: new DataLoader(async (ids) => {
        const orders = await dataSources.orders.getByIdsBatch(ids);
        return ids.map(id => orders.find(o => o.id === id));
    }),
    
    customers: new DataLoader(async (ids) => {
        const customers = await dataSources.customers.getByIdsBatch(ids);
        return ids.map(id => customers.find(c => c.id === id));
    })
});

// ==========================================
// SERVER SETUP
// ==========================================

const createGraphQLServer = async (dataSources) => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    
    const server = new ApolloServer({
        schema,
        introspection: true,
        plugins: [
            {
                requestDidStart: async () => ({
                    didEncounterErrors: async ({ errors }) => {
                        console.error('GraphQL Errors:', errors);
                    }
                })
            }
        ]
    });

    await server.start();

    return {
        server,
        middleware: expressMiddleware(server, {
            context: async ({ req }) => ({
                dataSources,
                loaders: createLoaders(dataSources),
                user: req.user,
                organizationId: req.organizationId
            })
        })
    };
};

module.exports = {
    typeDefs,
    resolvers,
    createGraphQLServer,
    pubsub
};
