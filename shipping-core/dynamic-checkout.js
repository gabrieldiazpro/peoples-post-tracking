/**
 * ROUTZ - Dynamic Checkout API
 * API de checkout dynamique pour options de livraison en temps réel
 * Comparable à Sendcloud Dynamic Checkout
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Cache TTL
const RATES_CACHE_TTL = 300; // 5 minutes
const ZONES_CACHE_TTL = 86400; // 24 hours

// ============================================
// SHIPPING ZONES CONFIGURATION
// ============================================

const DEFAULT_ZONES = {
    FR: {
        domestic: {
            zones: [
                { id: 'FR_METRO', name: 'France Métropolitaine', postalPrefixes: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], excludePrefixes: ['97', '98'] },
                { id: 'FR_CORSE', name: 'Corse', postalPrefixes: ['20'] },
                { id: 'FR_DOM', name: 'DOM-TOM', postalPrefixes: ['97', '98'] }
            ]
        },
        international: {
            EU: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
            EUROPE_OTHER: ['CH', 'NO', 'GB', 'UA', 'RS', 'BA', 'MK', 'AL', 'MD'],
            WORLD_1: ['US', 'CA', 'AU', 'NZ', 'JP', 'KR', 'SG', 'HK'],
            WORLD_2: ['CN', 'IN', 'BR', 'MX', 'AR', 'ZA', 'AE', 'SA'],
            WORLD_3: [] // Rest of world
        }
    }
};

// ============================================
// CARRIER SERVICES CONFIGURATION
// ============================================

const CARRIER_SERVICES = {
    colissimo: {
        name: 'Colissimo',
        services: [
            {
                id: 'colissimo_home',
                name: 'Colissimo Domicile',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 4 },
                maxWeight: 30,
                tracking: true,
                signature: false,
                insurance: 23
            },
            {
                id: 'colissimo_signature',
                name: 'Colissimo Domicile avec signature',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 4 },
                maxWeight: 30,
                tracking: true,
                signature: true,
                insurance: 23
            },
            {
                id: 'colissimo_pickup',
                name: 'Colissimo Point Retrait',
                type: 'pickup_point',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 20,
                tracking: true,
                signature: false,
                insurance: 23
            },
            {
                id: 'colissimo_international',
                name: 'Colissimo International',
                type: 'home_delivery',
                deliveryDays: { min: 5, max: 10 },
                maxWeight: 30,
                tracking: true,
                international: true,
                insurance: 23
            }
        ]
    },
    
    chronopost: {
        name: 'Chronopost',
        services: [
            {
                id: 'chrono_13',
                name: 'Chronopost 13h',
                type: 'express',
                deliveryDays: { min: 1, max: 1 },
                cutoffTime: '18:00',
                deliveryTime: '13:00',
                maxWeight: 30,
                tracking: true,
                signature: true,
                insurance: 29
            },
            {
                id: 'chrono_18',
                name: 'Chronopost 18h',
                type: 'express',
                deliveryDays: { min: 1, max: 1 },
                cutoffTime: '18:00',
                deliveryTime: '18:00',
                maxWeight: 30,
                tracking: true,
                signature: true,
                insurance: 29
            },
            {
                id: 'chrono_relais',
                name: 'Chronopost Relais',
                type: 'pickup_point',
                deliveryDays: { min: 1, max: 2 },
                maxWeight: 20,
                tracking: true,
                insurance: 29
            },
            {
                id: 'chrono_classic',
                name: 'Chronopost Classic International',
                type: 'express',
                deliveryDays: { min: 2, max: 5 },
                maxWeight: 30,
                tracking: true,
                international: true,
                insurance: 29
            }
        ]
    },
    
    mondial_relay: {
        name: 'Mondial Relay',
        services: [
            {
                id: 'mr_standard',
                name: 'Mondial Relay Standard',
                type: 'pickup_point',
                deliveryDays: { min: 3, max: 6 },
                maxWeight: 30,
                tracking: true,
                insurance: 25,
                economical: true
            },
            {
                id: 'mr_home',
                name: 'Mondial Relay Domicile',
                type: 'home_delivery',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 30,
                tracking: true,
                insurance: 25
            },
            {
                id: 'mr_locker',
                name: 'Mondial Relay Locker',
                type: 'locker',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 10,
                maxDimensions: { l: 59, w: 38, h: 19 },
                tracking: true,
                insurance: 25
            }
        ]
    },
    
    dpd: {
        name: 'DPD',
        services: [
            {
                id: 'dpd_classic',
                name: 'DPD Classic',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 4 },
                maxWeight: 31.5,
                tracking: true,
                insurance: 520
            },
            {
                id: 'dpd_predict',
                name: 'DPD Predict',
                type: 'home_delivery',
                deliveryDays: { min: 1, max: 2 },
                maxWeight: 31.5,
                tracking: true,
                notification: true,
                timeSlot: true,
                insurance: 520
            },
            {
                id: 'dpd_relais',
                name: 'DPD Relais',
                type: 'pickup_point',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 20,
                tracking: true,
                insurance: 520
            }
        ]
    },
    
    gls: {
        name: 'GLS',
        services: [
            {
                id: 'gls_business',
                name: 'GLS Business',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 4 },
                maxWeight: 40,
                tracking: true,
                insurance: 750
            },
            {
                id: 'gls_express',
                name: 'GLS Express',
                type: 'express',
                deliveryDays: { min: 1, max: 2 },
                maxWeight: 40,
                tracking: true,
                insurance: 750
            },
            {
                id: 'gls_shop',
                name: 'GLS Shop Delivery',
                type: 'pickup_point',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 20,
                tracking: true,
                insurance: 750
            }
        ]
    },
    
    ups: {
        name: 'UPS',
        services: [
            {
                id: 'ups_standard',
                name: 'UPS Standard',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 5 },
                maxWeight: 70,
                tracking: true,
                insurance: 100
            },
            {
                id: 'ups_express',
                name: 'UPS Express',
                type: 'express',
                deliveryDays: { min: 1, max: 2 },
                maxWeight: 70,
                tracking: true,
                insurance: 100
            },
            {
                id: 'ups_access_point',
                name: 'UPS Access Point',
                type: 'pickup_point',
                deliveryDays: { min: 2, max: 4 },
                maxWeight: 20,
                tracking: true,
                insurance: 100
            }
        ]
    },
    
    fedex: {
        name: 'FedEx',
        services: [
            {
                id: 'fedex_economy',
                name: 'FedEx Economy',
                type: 'home_delivery',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 68,
                tracking: true,
                international: true
            },
            {
                id: 'fedex_priority',
                name: 'FedEx Priority',
                type: 'express',
                deliveryDays: { min: 1, max: 3 },
                maxWeight: 68,
                tracking: true,
                international: true
            }
        ]
    },
    
    dhl: {
        name: 'DHL',
        services: [
            {
                id: 'dhl_parcel',
                name: 'DHL Parcel',
                type: 'home_delivery',
                deliveryDays: { min: 2, max: 5 },
                maxWeight: 31.5,
                tracking: true
            },
            {
                id: 'dhl_express',
                name: 'DHL Express',
                type: 'express',
                deliveryDays: { min: 1, max: 2 },
                maxWeight: 70,
                tracking: true,
                international: true
            },
            {
                id: 'dhl_service_point',
                name: 'DHL Service Point',
                type: 'pickup_point',
                deliveryDays: { min: 3, max: 5 },
                maxWeight: 20,
                tracking: true
            }
        ]
    }
};

// ============================================
// DYNAMIC CHECKOUT SERVICE
// ============================================

class DynamicCheckoutService {
    constructor() {
        this.carrierRateProviders = {};
    }

    // ----------------------------------------
    // MAIN CHECKOUT API
    // ----------------------------------------

    /**
     * Get shipping options for checkout
     * Main endpoint for e-commerce integration
     */
    async getShippingOptions(params) {
        const {
            orgId,
            
            // Destination
            country,
            postalCode,
            city,
            
            // Origin (optional, uses default warehouse if not provided)
            originCountry,
            originPostalCode,
            
            // Package
            weight, // in kg
            dimensions, // { length, width, height } in cm
            
            // Cart
            cartValue,
            cartItems,
            currency = 'EUR',
            
            // Options
            includePickupPoints = true,
            includeLockers = true,
            preferredCarriers,
            excludeCarriers,
            
            // Customer
            customerId,
            customerEmail
        } = params;

        // Validate required fields
        if (!orgId || !country || !postalCode) {
            throw new Error('orgId, country, and postalCode are required');
        }

        // Get organization configuration
        const orgConfig = await this.getOrgConfig(orgId);
        
        // Determine shipping zone
        const zone = this.determineZone(country, postalCode, orgConfig.originCountry || 'FR');
        
        // Calculate volumetric weight if dimensions provided
        const volumetricWeight = dimensions 
            ? (dimensions.length * dimensions.width * dimensions.height) / 5000 
            : null;
        const chargeableWeight = Math.max(weight || 0.5, volumetricWeight || 0);

        // Get available services
        const availableServices = await this.getAvailableServices({
            orgConfig,
            zone,
            weight: chargeableWeight,
            dimensions,
            country,
            preferredCarriers,
            excludeCarriers,
            includePickupPoints,
            includeLockers
        });

        // Calculate rates for each service
        const ratesPromises = availableServices.map(service => 
            this.calculateRate({
                orgId,
                service,
                zone,
                weight: chargeableWeight,
                dimensions,
                country,
                postalCode,
                cartValue,
                currency
            })
        );

        const rates = await Promise.all(ratesPromises);
        
        // Filter out null rates (unavailable services)
        const validRates = rates.filter(r => r !== null);

        // Apply free shipping rules
        const finalRates = this.applyFreeShippingRules(validRates, {
            cartValue,
            orgConfig,
            zone
        });

        // Sort by price (cheapest first) then by delivery time
        finalRates.sort((a, b) => {
            if (a.price !== b.price) return a.price - b.price;
            return a.deliveryDays.min - b.deliveryDays.min;
        });

        // Group options by type
        const grouped = this.groupShippingOptions(finalRates, {
            includePickupPoints,
            includeLockers
        });

        // Get customer's saved pickup points
        let savedPoints = [];
        if (customerId || customerEmail) {
            savedPoints = await this.getSavedPickupPoints(orgId, customerId, customerEmail);
        }

        return {
            success: true,
            currency,
            zone: zone.id,
            chargeableWeight,
            freeShippingThreshold: orgConfig.freeShippingThreshold,
            freeShippingEligible: cartValue >= (orgConfig.freeShippingThreshold || Infinity),
            options: grouped,
            allOptions: finalRates,
            savedPickupPoints: savedPoints,
            metadata: {
                timestamp: new Date().toISOString(),
                ttl: RATES_CACHE_TTL
            }
        };
    }

    /**
     * Get detailed rate for a specific service
     */
    async getServiceRate(params) {
        const {
            orgId,
            serviceId,
            country,
            postalCode,
            weight,
            dimensions,
            cartValue,
            currency = 'EUR'
        } = params;

        const orgConfig = await this.getOrgConfig(orgId);
        const zone = this.determineZone(country, postalCode, orgConfig.originCountry || 'FR');
        
        // Find service
        const service = this.findService(serviceId);
        if (!service) {
            throw new Error(`Service ${serviceId} not found`);
        }

        const rate = await this.calculateRate({
            orgId,
            service,
            zone,
            weight,
            dimensions,
            country,
            postalCode,
            cartValue,
            currency
        });

        if (!rate) {
            throw new Error(`Service ${serviceId} not available for this destination`);
        }

        return rate;
    }

    /**
     * Validate shipping option before order creation
     */
    async validateShippingOption(params) {
        const {
            orgId,
            serviceId,
            pickupPointId,
            pickupPointCarrier,
            country,
            postalCode,
            weight,
            dimensions
        } = params;

        const errors = [];
        
        // Validate service exists and is available
        const service = this.findService(serviceId);
        if (!service) {
            errors.push({ field: 'serviceId', message: 'Service not found' });
        } else {
            // Check weight limit
            if (weight > service.maxWeight) {
                errors.push({ 
                    field: 'weight', 
                    message: `Weight exceeds maximum of ${service.maxWeight}kg` 
                });
            }

            // Check dimensions if applicable
            if (service.maxDimensions && dimensions) {
                const { l, w, h } = service.maxDimensions;
                if (dimensions.length > l || dimensions.width > w || dimensions.height > h) {
                    errors.push({ 
                        field: 'dimensions', 
                        message: `Dimensions exceed maximum of ${l}x${w}x${h}cm` 
                    });
                }
            }

            // Validate pickup point if required
            if (service.type === 'pickup_point' || service.type === 'locker') {
                if (!pickupPointId) {
                    errors.push({ 
                        field: 'pickupPointId', 
                        message: 'Pickup point is required for this service' 
                    });
                } else {
                    // Validate pickup point exists and is active
                    const { ServicePointPickerService } = require('./service-point-picker');
                    const spService = new ServicePointPickerService();
                    const validation = await spService.validateServicePoint(
                        pickupPointCarrier || service.carrier, 
                        pickupPointId
                    );
                    
                    if (!validation.valid) {
                        errors.push({ 
                            field: 'pickupPointId', 
                            message: 'Pickup point is not available' 
                        });
                    }
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // ----------------------------------------
    // RATE CALCULATION
    // ----------------------------------------

    async calculateRate(params) {
        const {
            orgId,
            service,
            zone,
            weight,
            dimensions,
            country,
            postalCode,
            cartValue,
            currency
        } = params;

        // Check cache first
        const cacheKey = `rate:${orgId}:${service.id}:${zone.id}:${weight}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }

        // Get organization's rate configuration
        const orgRates = await this.getOrgRates(orgId);
        
        // Calculate base rate
        let baseRate = null;

        // 1. Check for custom rate override
        const customRate = orgRates.customRates?.[service.id]?.[zone.id];
        if (customRate) {
            baseRate = this.calculateCustomRate(customRate, weight, dimensions);
        }
        
        // 2. Use negotiated rates if available
        if (!baseRate && orgRates.negotiatedRates?.[service.carrier]) {
            baseRate = await this.getNegotiatedRate(
                orgId, 
                service, 
                zone, 
                weight, 
                dimensions
            );
        }
        
        // 3. Fall back to standard rates
        if (!baseRate) {
            baseRate = this.getStandardRate(service, zone, weight);
        }

        if (!baseRate) {
            return null; // Service not available
        }

        // Apply markup
        const markup = orgRates.markup || 0;
        const markupAmount = baseRate * (markup / 100);
        
        // Calculate final price
        const finalPrice = Math.round((baseRate + markupAmount) * 100) / 100;

        // Build rate object
        const rate = {
            serviceId: service.id,
            serviceName: service.name,
            carrier: service.carrier,
            carrierName: CARRIER_SERVICES[service.carrier]?.name,
            type: service.type,
            
            price: finalPrice,
            originalPrice: finalPrice,
            currency,
            
            deliveryDays: this.calculateDeliveryDays(service, zone, country),
            
            features: {
                tracking: service.tracking,
                signature: service.signature,
                insurance: service.insurance,
                notification: service.notification,
                timeSlot: service.timeSlot
            },
            
            restrictions: {
                maxWeight: service.maxWeight,
                maxDimensions: service.maxDimensions
            },
            
            requiresPickupPoint: service.type === 'pickup_point' || service.type === 'locker',
            
            // Metadata for display
            badge: this.getServiceBadge(service, zone),
            icon: this.getServiceIcon(service),
            description: this.getServiceDescription(service, zone)
        };

        // Cache rate
        await redis.setex(cacheKey, RATES_CACHE_TTL, JSON.stringify(rate));

        return rate;
    }

    calculateCustomRate(rateConfig, weight, dimensions) {
        // Support different rate structures
        if (rateConfig.flatRate) {
            return rateConfig.flatRate;
        }
        
        if (rateConfig.perKg) {
            return rateConfig.baseRate + (weight * rateConfig.perKg);
        }
        
        if (rateConfig.brackets) {
            const bracket = rateConfig.brackets.find(b => weight <= b.maxWeight);
            return bracket ? bracket.price : null;
        }
        
        return rateConfig.price || null;
    }

    getStandardRate(service, zone, weight) {
        // Standard rate tables (would be loaded from database in production)
        const standardRates = {
            // France domestic
            'FR_METRO': {
                'colissimo_home': { brackets: [
                    { maxWeight: 0.5, price: 4.95 },
                    { maxWeight: 1, price: 6.25 },
                    { maxWeight: 2, price: 7.45 },
                    { maxWeight: 5, price: 8.95 },
                    { maxWeight: 10, price: 13.75 },
                    { maxWeight: 30, price: 19.50 }
                ]},
                'colissimo_pickup': { brackets: [
                    { maxWeight: 0.5, price: 3.95 },
                    { maxWeight: 1, price: 4.95 },
                    { maxWeight: 2, price: 5.95 },
                    { maxWeight: 5, price: 6.95 },
                    { maxWeight: 10, price: 9.95 },
                    { maxWeight: 20, price: 14.95 }
                ]},
                'chrono_13': { brackets: [
                    { maxWeight: 1, price: 13.90 },
                    { maxWeight: 2, price: 15.90 },
                    { maxWeight: 5, price: 18.90 },
                    { maxWeight: 10, price: 24.90 },
                    { maxWeight: 30, price: 36.90 }
                ]},
                'mr_standard': { brackets: [
                    { maxWeight: 0.5, price: 2.99 },
                    { maxWeight: 1, price: 3.99 },
                    { maxWeight: 3, price: 4.99 },
                    { maxWeight: 5, price: 5.99 },
                    { maxWeight: 10, price: 7.99 },
                    { maxWeight: 20, price: 11.99 },
                    { maxWeight: 30, price: 15.99 }
                ]}
            },
            'EU': {
                'colissimo_international': { brackets: [
                    { maxWeight: 0.5, price: 12.65 },
                    { maxWeight: 1, price: 14.30 },
                    { maxWeight: 2, price: 16.50 },
                    { maxWeight: 5, price: 22.50 },
                    { maxWeight: 10, price: 32.00 },
                    { maxWeight: 30, price: 55.00 }
                ]},
                'dhl_parcel': { brackets: [
                    { maxWeight: 2, price: 11.90 },
                    { maxWeight: 5, price: 14.90 },
                    { maxWeight: 10, price: 19.90 },
                    { maxWeight: 31.5, price: 29.90 }
                ]}
            }
        };

        const zoneRates = standardRates[zone.id] || standardRates['FR_METRO'];
        const serviceRates = zoneRates[service.id];
        
        if (!serviceRates) return null;
        
        const bracket = serviceRates.brackets.find(b => weight <= b.maxWeight);
        return bracket ? bracket.price : null;
    }

    async getNegotiatedRate(orgId, service, zone, weight, dimensions) {
        // Query negotiated rates from database
        const result = await db.query(`
            SELECT rate_config FROM negotiated_rates
            WHERE organization_id = $1 
            AND carrier = $2 
            AND service_id = $3
            AND zone_id = $4
            AND active = true
        `, [orgId, service.carrier, service.id, zone.id]);

        if (result.rows.length === 0) return null;
        
        return this.calculateCustomRate(result.rows[0].rate_config, weight, dimensions);
    }

    // ----------------------------------------
    // DELIVERY TIME CALCULATION
    // ----------------------------------------

    calculateDeliveryDays(service, zone, country) {
        let { min, max } = service.deliveryDays;
        
        // Adjust for international
        if (zone.type === 'international') {
            const zoneDelays = {
                'EU': { add: 1 },
                'EUROPE_OTHER': { add: 2 },
                'WORLD_1': { add: 3 },
                'WORLD_2': { add: 5 },
                'WORLD_3': { add: 7 }
            };
            
            const delay = zoneDelays[zone.id]?.add || 0;
            min += delay;
            max += delay;
        }
        
        // Adjust for weekend
        const now = new Date();
        const dayOfWeek = now.getDay();
        
        // If today is Friday after cutoff, Saturday, or Sunday, add days
        if (dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0) {
            const daysToMonday = dayOfWeek === 5 ? 3 : dayOfWeek === 6 ? 2 : 1;
            min += daysToMonday;
            max += daysToMonday;
        }
        
        // Calculate estimated dates
        const estimatedMin = new Date(now);
        estimatedMin.setDate(estimatedMin.getDate() + min);
        
        const estimatedMax = new Date(now);
        estimatedMax.setDate(estimatedMax.getDate() + max);
        
        return {
            min,
            max,
            estimatedMinDate: estimatedMin.toISOString().split('T')[0],
            estimatedMaxDate: estimatedMax.toISOString().split('T')[0],
            formatted: min === max 
                ? `${min} jour${min > 1 ? 's' : ''}` 
                : `${min}-${max} jours`
        };
    }

    // ----------------------------------------
    // FREE SHIPPING RULES
    // ----------------------------------------

    applyFreeShippingRules(rates, { cartValue, orgConfig, zone }) {
        const threshold = orgConfig.freeShippingThreshold;
        const freeShippingServices = orgConfig.freeShippingServices || ['pickup_point', 'home_delivery'];
        const freeShippingZones = orgConfig.freeShippingZones || ['FR_METRO'];
        
        if (!threshold || cartValue < threshold) {
            return rates;
        }
        
        return rates.map(rate => {
            const eligible = freeShippingServices.includes(rate.type) && 
                           freeShippingZones.includes(zone.id);
            
            if (eligible) {
                return {
                    ...rate,
                    originalPrice: rate.price,
                    price: 0,
                    freeShipping: true,
                    freeShippingReason: `Livraison gratuite dès ${threshold}€`
                };
            }
            
            return rate;
        });
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    determineZone(country, postalCode, originCountry) {
        // Domestic
        if (country === originCountry) {
            const zones = DEFAULT_ZONES[originCountry]?.domestic?.zones || [];
            
            for (const zone of zones) {
                const prefix = postalCode.substring(0, 2);
                
                if (zone.excludePrefixes?.includes(prefix)) continue;
                
                if (zone.postalPrefixes.some(p => postalCode.startsWith(p))) {
                    return { ...zone, type: 'domestic' };
                }
            }
            
            return { id: `${originCountry}_METRO`, name: 'Domestic', type: 'domestic' };
        }
        
        // International
        const intlZones = DEFAULT_ZONES[originCountry]?.international || {};
        
        for (const [zoneId, countries] of Object.entries(intlZones)) {
            if (countries.includes(country)) {
                return { id: zoneId, name: zoneId, type: 'international' };
            }
        }
        
        return { id: 'WORLD_3', name: 'Rest of World', type: 'international' };
    }

    async getAvailableServices({ orgConfig, zone, weight, dimensions, country, preferredCarriers, excludeCarriers, includePickupPoints, includeLockers }) {
        const enabledCarriers = orgConfig.enabledCarriers || Object.keys(CARRIER_SERVICES);
        
        let carriers = preferredCarriers 
            ? preferredCarriers.filter(c => enabledCarriers.includes(c))
            : enabledCarriers;
        
        if (excludeCarriers) {
            carriers = carriers.filter(c => !excludeCarriers.includes(c));
        }
        
        const services = [];
        
        for (const carrierId of carriers) {
            const carrier = CARRIER_SERVICES[carrierId];
            if (!carrier) continue;
            
            for (const service of carrier.services) {
                // Filter by type
                if (!includePickupPoints && service.type === 'pickup_point') continue;
                if (!includeLockers && service.type === 'locker') continue;
                
                // Filter by weight
                if (weight > service.maxWeight) continue;
                
                // Filter by dimensions
                if (service.maxDimensions && dimensions) {
                    const { l, w, h } = service.maxDimensions;
                    if (dimensions.length > l || dimensions.width > w || dimensions.height > h) continue;
                }
                
                // Filter by zone
                if (zone.type === 'international' && !service.international) continue;
                if (zone.type === 'domestic' && service.international) continue;
                
                services.push({
                    ...service,
                    carrier: carrierId
                });
            }
        }
        
        return services;
    }

    findService(serviceId) {
        for (const [carrierId, carrier] of Object.entries(CARRIER_SERVICES)) {
            const service = carrier.services.find(s => s.id === serviceId);
            if (service) {
                return { ...service, carrier: carrierId };
            }
        }
        return null;
    }

    groupShippingOptions(rates, options) {
        const groups = {
            express: {
                title: 'Livraison Express',
                icon: '⚡',
                options: []
            },
            standard: {
                title: 'Livraison Standard',
                icon: '📦',
                options: []
            },
            pickup: {
                title: 'Point Relais',
                icon: '📍',
                options: []
            },
            locker: {
                title: 'Consigne / Locker',
                icon: '🔐',
                options: []
            }
        };
        
        for (const rate of rates) {
            switch (rate.type) {
                case 'express':
                    groups.express.options.push(rate);
                    break;
                case 'pickup_point':
                    groups.pickup.options.push(rate);
                    break;
                case 'locker':
                    groups.locker.options.push(rate);
                    break;
                default:
                    groups.standard.options.push(rate);
            }
        }
        
        // Remove empty groups
        return Object.fromEntries(
            Object.entries(groups).filter(([_, g]) => g.options.length > 0)
        );
    }

    getServiceBadge(service, zone) {
        if (service.economical) return { text: 'Économique', color: 'green' };
        if (service.type === 'express') return { text: 'Express', color: 'orange' };
        if (service.signature) return { text: 'Avec signature', color: 'blue' };
        return null;
    }

    getServiceIcon(service) {
        const icons = {
            express: '⚡',
            home_delivery: '🏠',
            pickup_point: '📍',
            locker: '🔐'
        };
        return icons[service.type] || '📦';
    }

    getServiceDescription(service, zone) {
        const parts = [];
        
        if (service.tracking) parts.push('Suivi inclus');
        if (service.signature) parts.push('Signature requise');
        if (service.insurance) parts.push(`Assurance jusqu'à ${service.insurance}€`);
        if (service.notification) parts.push('Notification SMS');
        
        return parts.join(' • ');
    }

    async getOrgConfig(orgId) {
        const cacheKey = `checkout_config:${orgId}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
        
        const result = await db.query(
            'SELECT * FROM checkout_config WHERE organization_id = $1',
            [orgId]
        );
        
        const config = result.rows[0] || this.getDefaultConfig();
        await redis.setex(cacheKey, 3600, JSON.stringify(config));
        
        return config;
    }

    async getOrgRates(orgId) {
        const cacheKey = `org_rates:${orgId}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
        
        const result = await db.query(
            'SELECT * FROM shipping_rates_config WHERE organization_id = $1',
            [orgId]
        );
        
        const rates = result.rows[0] || { markup: 0 };
        await redis.setex(cacheKey, 3600, JSON.stringify(rates));
        
        return rates;
    }

    getDefaultConfig() {
        return {
            enabledCarriers: ['colissimo', 'chronopost', 'mondial_relay', 'dpd'],
            freeShippingThreshold: 50,
            freeShippingServices: ['pickup_point', 'home_delivery'],
            freeShippingZones: ['FR_METRO'],
            originCountry: 'FR',
            originPostalCode: '75001'
        };
    }

    async getSavedPickupPoints(orgId, customerId, customerEmail) {
        const result = await db.query(`
            SELECT * FROM saved_service_points
            WHERE organization_id = $1 
            AND (customer_id = $2 OR customer_email = $3)
            ORDER BY is_default DESC, last_used_at DESC NULLS LAST
            LIMIT 5
        `, [orgId, customerId, customerEmail]);
        
        return result.rows;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    DynamicCheckoutService,
    CARRIER_SERVICES,
    DEFAULT_ZONES
};
