/**
 * ROUTZ - Validation Schemas (Zod)
 * Complete validation for all API endpoints
 */

const { z } = require('zod');

// ============================================
// COMMON SCHEMAS
// ============================================

// UUID
const uuid = z.string().uuid();

// Email
const email = z.string().email().toLowerCase().max(255);

// Phone (international format)
const phone = z.string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format')
    .optional();

// Postal code (flexible for international)
const postalCode = z.string()
    .min(3, 'Postal code too short')
    .max(10, 'Postal code too long')
    .regex(/^[A-Za-z0-9\s\-]+$/, 'Invalid postal code format');

// Country code (ISO 3166-1 alpha-2)
const countryCode = z.string()
    .length(2)
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Invalid country code');

// Currency (ISO 4217)
const currency = z.string()
    .length(3)
    .toUpperCase()
    .default('EUR');

// Positive decimal
const positiveDecimal = z.number()
    .positive()
    .multipleOf(0.01);

// Weight in kg
const weight = z.number()
    .positive()
    .max(100, 'Weight cannot exceed 100 kg');

// Dimension in cm
const dimension = z.number()
    .positive()
    .max(300, 'Dimension cannot exceed 300 cm')
    .optional();

// Pagination
const pagination = z.object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(20),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// Date range
const dateRange = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional()
}).refine(data => {
    if (data.from && data.to) {
        return new Date(data.from) <= new Date(data.to);
    }
    return true;
}, 'Start date must be before end date');

// ============================================
// ADDRESS SCHEMAS
// ============================================

const addressBase = z.object({
    companyName: z.string().max(100).optional(),
    firstName: z.string().max(50).optional(),
    lastName: z.string().max(50).optional(),
    name: z.string().max(100).optional(),
    line1: z.string().min(3).max(100),
    line2: z.string().max(100).optional(),
    line3: z.string().max(100).optional(),
    city: z.string().min(2).max(100),
    state: z.string().max(50).optional(),
    postalCode: postalCode,
    countryCode: countryCode,
    phone: phone,
    mobile: phone,
    email: email.optional(),
    doorCode1: z.string().max(10).optional(),
    doorCode2: z.string().max(10).optional(),
    intercom: z.string().max(50).optional(),
    instructions: z.string().max(500).optional()
}).refine(data => {
    return data.companyName || data.name || (data.firstName && data.lastName);
}, 'Either company name, name, or first/last name is required');

const senderAddress = addressBase.extend({
    email: email // Email required for sender
});

const recipientAddress = addressBase.extend({
    email: email.optional()
});

// ============================================
// PARCEL SCHEMAS
// ============================================

const parcel = z.object({
    weight: weight,
    length: dimension,
    width: dimension,
    height: dimension,
    description: z.string().max(255).optional(),
    value: positiveDecimal.optional(),
    reference: z.string().max(100).optional(),
    insuranceValue: positiveDecimal.optional()
}).refine(data => {
    if (data.length && data.width && data.height) {
        const girth = 2 * (data.width + data.height) + data.length;
        return girth <= 400;
    }
    return true;
}, 'Combined dimensions (L + 2*(W+H)) cannot exceed 400 cm');

const parcels = z.array(parcel).min(1).max(99);

// ============================================
// CUSTOMS SCHEMAS
// ============================================

const customsItem = z.object({
    description: z.string().min(3).max(255),
    quantity: z.number().int().positive(),
    weight: z.number().positive(),
    value: positiveDecimal,
    currency: currency,
    hsCode: z.string().regex(/^\d{6,10}$/).optional(),
    originCountry: countryCode.default('FR')
});

const customs = z.object({
    category: z.enum(['1', '2', '3', '4', '5']).transform(Number),
    // 1=Gift, 2=Sample, 3=Commercial, 4=Documents, 5=Other
    contents: z.array(customsItem).min(1).max(20),
    totalValue: positiveDecimal,
    currency: currency,
    invoiceNumber: z.string().max(50).optional(),
    licenseNumber: z.string().max(50).optional(),
    certificateNumber: z.string().max(50).optional()
});

// ============================================
// SHIPMENT SCHEMAS
// ============================================

const carriers = z.enum([
    'colissimo', 'chronopost', 'mondial_relay', 'dhl', 'ups', 
    'fedex', 'gls', 'dpd', 'tnt', 'hermes', 'postnl', 'bpost'
]);

const shipmentStatus = z.enum([
    'pending', 'label_created', 'picked_up', 'in_transit', 
    'out_for_delivery', 'delivered', 'exception', 'returned', 'cancelled'
]);

const createShipment = z.object({
    carrier: carriers,
    service: z.string().min(1).max(20),
    sender: senderAddress,
    recipient: recipientAddress,
    parcel: parcel.optional(),
    parcels: parcels.optional(),
    reference: z.string().max(100).optional(),
    orderNumber: z.string().max(100).optional(),
    depositDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pickupPointId: z.string().max(50).optional(),
    customs: customs.optional(),
    options: z.object({
        signature: z.boolean().default(false),
        insurance: z.boolean().default(false),
        insuranceValue: positiveDecimal.optional(),
        cod: z.boolean().default(false),
        codAmount: positiveDecimal.optional(),
        saturdayDelivery: z.boolean().default(false),
        returnLabel: z.boolean().default(false),
        notifications: z.object({
            email: z.boolean().default(true),
            sms: z.boolean().default(false)
        }).optional()
    }).optional(),
    labelFormat: z.enum(['PDF_A4', 'PDF_10x15', 'ZPL', 'PNG']).default('PDF_A4'),
    metadata: z.record(z.string()).optional()
}).refine(data => {
    return data.parcel || (data.parcels && data.parcels.length > 0);
}, 'Either parcel or parcels is required');

const updateShipment = z.object({
    reference: z.string().max(100).optional(),
    orderNumber: z.string().max(100).optional(),
    metadata: z.record(z.string()).optional()
});

const shipmentFilters = z.object({
    status: shipmentStatus.optional(),
    statuses: z.array(shipmentStatus).optional(),
    carrier: carriers.optional(),
    carriers: z.array(carriers).optional(),
    trackingNumber: z.string().optional(),
    reference: z.string().optional(),
    recipientEmail: email.optional(),
    recipientCity: z.string().optional(),
    recipientCountry: countryCode.optional(),
    createdAt: dateRange.optional(),
    deliveredAt: dateRange.optional()
}).merge(pagination);

// ============================================
// ORDER SCHEMAS
// ============================================

const orderStatus = z.enum([
    'pending', 'processing', 'shipped', 'delivered', 
    'cancelled', 'refunded', 'on_hold'
]);

const orderSource = z.enum([
    'shopify', 'woocommerce', 'prestashop', 'magento',
    'amazon', 'cdiscount', 'fnac', 'manomano',
    'api', 'manual', 'import'
]);

const orderItem = z.object({
    sku: z.string().max(100).optional(),
    name: z.string().min(1).max(255),
    quantity: z.number().int().positive(),
    price: positiveDecimal,
    weight: z.number().positive().optional(),
    variantId: z.string().optional(),
    productId: z.string().optional(),
    properties: z.record(z.string()).optional()
});

const createOrder = z.object({
    orderNumber: z.string().min(1).max(100),
    externalId: z.string().max(255).optional(),
    source: orderSource.default('api'),
    sourceUrl: z.string().url().optional(),
    customerName: z.string().max(255).optional(),
    customerEmail: email.optional(),
    customerPhone: phone,
    shippingAddress: recipientAddress.optional(),
    billingAddress: addressBase.optional(),
    items: z.array(orderItem).min(1),
    subtotal: positiveDecimal.optional(),
    shippingTotal: z.number().nonnegative().optional(),
    taxTotal: z.number().nonnegative().optional(),
    discountTotal: z.number().nonnegative().optional(),
    total: positiveDecimal,
    currency: currency,
    notes: z.string().max(1000).optional(),
    tags: z.array(z.string().max(50)).optional(),
    metadata: z.record(z.string()).optional(),
    orderDate: z.string().datetime().optional()
});

const updateOrder = z.object({
    status: orderStatus.optional(),
    customerName: z.string().max(255).optional(),
    customerEmail: email.optional(),
    shippingAddress: recipientAddress.optional(),
    notes: z.string().max(1000).optional(),
    tags: z.array(z.string().max(50)).optional(),
    metadata: z.record(z.string()).optional()
});

const orderFilters = z.object({
    status: orderStatus.optional(),
    statuses: z.array(orderStatus).optional(),
    source: orderSource.optional(),
    sources: z.array(orderSource).optional(),
    customerEmail: email.optional(),
    orderNumber: z.string().optional(),
    createdAt: dateRange.optional(),
    shippedAt: dateRange.optional()
}).merge(pagination);

const importOrders = z.object({
    source: orderSource.default('import'),
    orders: z.array(createOrder).min(1).max(1000),
    options: z.object({
        skipDuplicates: z.boolean().default(true),
        updateExisting: z.boolean().default(false)
    }).optional()
});

// ============================================
// RETURN SCHEMAS
// ============================================

const returnReason = z.enum([
    'defective', 'wrong_item', 'not_as_described', 
    'no_longer_needed', 'arrived_late', 'other'
]);

const returnStatus = z.enum([
    'requested', 'approved', 'rejected', 'label_sent',
    'in_transit', 'received', 'inspected', 'refunded', 'closed'
]);

const returnItem = z.object({
    orderItemId: z.string().optional(),
    sku: z.string().max(100).optional(),
    name: z.string().max(255),
    quantity: z.number().int().positive(),
    reason: returnReason,
    reasonDetails: z.string().max(500).optional(),
    condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional()
});

const createReturn = z.object({
    orderId: uuid.optional(),
    shipmentId: uuid.optional(),
    customerName: z.string().max(255),
    customerEmail: email,
    items: z.array(returnItem).min(1),
    reason: returnReason,
    reasonDetails: z.string().max(1000).optional(),
    pickupAddress: addressBase.optional(),
    preferredCarrier: carriers.optional()
}).refine(data => {
    return data.orderId || data.shipmentId;
}, 'Either orderId or shipmentId is required');

const processReturn = z.object({
    status: returnStatus,
    inspectionNotes: z.string().max(1000).optional(),
    refundAmount: positiveDecimal.optional(),
    refundMethod: z.enum(['original_payment', 'store_credit', 'manual']).optional()
});

// ============================================
// AUTH SCHEMAS
// ============================================

const passwordValidation = z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long')
    .regex(/[a-z]/, 'Password must contain lowercase letter')
    .regex(/[A-Z]/, 'Password must contain uppercase letter')
    .regex(/[0-9]/, 'Password must contain a number')
    .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Password must contain special character');

const register = z.object({
    email: email,
    password: passwordValidation,
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    organizationName: z.string().min(2).max(100).optional(),
    inviteToken: z.string().optional()
});

const login = z.object({
    email: email,
    password: z.string().min(1)
});

const verifyMFA = z.object({
    mfaToken: z.string().min(1),
    code: z.string().length(6).regex(/^\d+$/),
    method: z.enum(['totp', 'backup_code']).default('totp')
});

const refreshToken = z.object({
    refreshToken: z.string().min(1)
});

const resetPasswordRequest = z.object({
    email: email
});

const resetPassword = z.object({
    token: z.string().min(1),
    password: passwordValidation
});

const changePassword = z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordValidation
});

const updateProfile = z.object({
    firstName: z.string().min(1).max(50).optional(),
    lastName: z.string().min(1).max(50).optional(),
    phone: phone,
    language: z.enum(['fr', 'en', 'de', 'es', 'it']).optional(),
    timezone: z.string().max(50).optional()
});

// ============================================
// ORGANIZATION SCHEMAS
// ============================================

const createOrganization = z.object({
    name: z.string().min(2).max(100),
    billingEmail: email.optional(),
    address: addressBase.optional(),
    vatNumber: z.string().max(20).optional(),
    siret: z.string().regex(/^\d{14}$/).optional()
});

const updateOrganization = z.object({
    name: z.string().min(2).max(100).optional(),
    billingEmail: email.optional(),
    address: addressBase.optional(),
    vatNumber: z.string().max(20).optional(),
    settings: z.record(z.any()).optional()
});

const inviteUser = z.object({
    email: email,
    role: z.enum(['admin', 'manager', 'operator', 'viewer']),
    customPermissions: z.array(z.string()).optional()
});

// ============================================
// API KEY SCHEMAS
// ============================================

const createApiKey = z.object({
    name: z.string().min(1).max(100),
    permissions: z.array(z.string()).optional(),
    rateLimit: z.number().int().min(100).max(10000).optional(),
    expiresAt: z.string().datetime().optional()
});

// ============================================
// WEBHOOK SCHEMAS
// ============================================

const webhookEvents = z.array(z.enum([
    'shipment.created', 'shipment.updated', 'shipment.in_transit',
    'shipment.out_for_delivery', 'shipment.delivered', 'shipment.exception',
    'shipment.returned', 'shipment.cancelled',
    'order.created', 'order.updated', 'order.shipped', 'order.delivered',
    'return.requested', 'return.approved', 'return.received', 'return.refunded',
    'tracking.updated'
])).min(1);

const createWebhook = z.object({
    url: z.string().url().max(500),
    events: webhookEvents,
    secret: z.string().min(16).max(64).optional()
});

const updateWebhook = z.object({
    url: z.string().url().max(500).optional(),
    events: webhookEvents.optional(),
    enabled: z.boolean().optional()
});

// ============================================
// CARRIER CONFIG SCHEMAS
// ============================================

const colissimoConfig = z.object({
    contractNumber: z.string().min(1),
    password: z.string().min(1),
    accountId: z.string().optional()
});

const chronopostConfig = z.object({
    accountNumber: z.string().min(1),
    password: z.string().min(1),
    subAccount: z.string().optional()
});

const dhlConfig = z.object({
    siteId: z.string().min(1),
    password: z.string().min(1),
    accountNumber: z.string().min(1)
});

const carrierConfig = z.object({
    carrier: carriers,
    credentials: z.union([colissimoConfig, chronopostConfig, dhlConfig]),
    enabled: z.boolean().default(true),
    settings: z.object({
        defaultService: z.string().optional(),
        returnAddress: addressBase.optional(),
        labelFormat: z.enum(['PDF_A4', 'PDF_10x15', 'ZPL']).optional()
    }).optional()
});

// ============================================
// RATES REQUEST SCHEMA
// ============================================

const getRates = z.object({
    origin: z.object({
        postalCode: postalCode,
        countryCode: countryCode,
        city: z.string().optional()
    }).optional(),
    destination: z.object({
        postalCode: postalCode,
        countryCode: countryCode,
        city: z.string().optional()
    }),
    parcels: parcels.optional(),
    parcel: parcel.optional(),
    carriers: z.array(carriers).optional(),
    services: z.array(z.string()).optional(),
    options: z.object({
        signature: z.boolean().optional(),
        insurance: z.boolean().optional(),
        saturdayDelivery: z.boolean().optional()
    }).optional()
}).refine(data => {
    return data.parcel || (data.parcels && data.parcels.length > 0);
}, 'Either parcel or parcels is required');

// ============================================
// PICKUP POINTS SCHEMA
// ============================================

const findPickupPoints = z.object({
    carrier: carriers,
    postalCode: postalCode,
    city: z.string().min(2).max(100),
    countryCode: countryCode.default('FR'),
    address: z.string().max(255).optional(),
    weight: weight.optional(),
    limit: z.number().int().min(1).max(50).default(10),
    maxDistance: z.number().int().min(1).max(50).optional()
});

// ============================================
// TRACKING SCHEMA
// ============================================

const getTracking = z.object({
    trackingNumber: z.string().min(5).max(50),
    carrier: carriers.optional()
});

const getTrackingBatch = z.object({
    trackingNumbers: z.array(z.string().min(5).max(50)).min(1).max(100),
    carrier: carriers.optional()
});

// ============================================
// REPORT SCHEMAS
// ============================================

const generateReport = z.object({
    type: z.enum(['shipments', 'performance', 'billing', 'returns', 'orders']),
    format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
    dateFrom: z.string().datetime(),
    dateTo: z.string().datetime(),
    filters: z.object({
        carriers: z.array(carriers).optional(),
        statuses: z.array(shipmentStatus).optional()
    }).optional()
}).refine(data => {
    const from = new Date(data.dateFrom);
    const to = new Date(data.dateTo);
    const diff = (to - from) / (1000 * 60 * 60 * 24);
    return diff <= 366;
}, 'Date range cannot exceed 1 year');

// ============================================
// MIDDLEWARE FACTORY
// ============================================

function validateBody(schema) {
    return (req, res, next) => {
        try {
            req.body = schema.parse(req.body);
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    error: 'Validation failed',
                    code: 'VALIDATION_ERROR',
                    details: error.errors.map(e => ({
                        path: e.path.join('.'),
                        message: e.message,
                        code: e.code
                    }))
                });
            }
            next(error);
        }
    };
}

function validateQuery(schema) {
    return (req, res, next) => {
        try {
            req.query = schema.parse(req.query);
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    error: 'Invalid query parameters',
                    code: 'VALIDATION_ERROR',
                    details: error.errors
                });
            }
            next(error);
        }
    };
}

function validateParams(schema) {
    return (req, res, next) => {
        try {
            req.params = schema.parse(req.params);
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    error: 'Invalid path parameters',
                    code: 'VALIDATION_ERROR',
                    details: error.errors
                });
            }
            next(error);
        }
    };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Common
    uuid,
    email,
    phone,
    postalCode,
    countryCode,
    currency,
    weight,
    dimension,
    pagination,
    dateRange,
    
    // Address
    addressBase,
    senderAddress,
    recipientAddress,
    
    // Parcel & Customs
    parcel,
    parcels,
    customsItem,
    customs,
    
    // Shipment
    carriers,
    shipmentStatus,
    createShipment,
    updateShipment,
    shipmentFilters,
    
    // Order
    orderStatus,
    orderSource,
    orderItem,
    createOrder,
    updateOrder,
    orderFilters,
    importOrders,
    
    // Return
    returnReason,
    returnStatus,
    returnItem,
    createReturn,
    processReturn,
    
    // Auth
    passwordValidation,
    register,
    login,
    verifyMFA,
    refreshToken,
    resetPasswordRequest,
    resetPassword,
    changePassword,
    updateProfile,
    
    // Organization
    createOrganization,
    updateOrganization,
    inviteUser,
    
    // API & Webhooks
    createApiKey,
    webhookEvents,
    createWebhook,
    updateWebhook,
    
    // Carrier
    carrierConfig,
    colissimoConfig,
    chronopostConfig,
    dhlConfig,
    
    // Rates & Tracking
    getRates,
    findPickupPoints,
    getTracking,
    getTrackingBatch,
    
    // Reports
    generateReport,
    
    // Middleware
    validateBody,
    validateQuery,
    validateParams,
    
    // Re-export zod for custom schemas
    z
};
