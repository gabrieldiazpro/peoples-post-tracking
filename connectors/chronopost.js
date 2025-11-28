/**
 * ROUTZ - Chronopost API Connector
 * Real implementation with retry, error handling, rate limiting
 * API: Chronopost Web Services (SOAP)
 */

const soap = require('soap');
const crypto = require('crypto');
const { Redis } = require('ioredis');
const pRetry = require('p-retry');
const pLimit = require('p-limit');
const { EventEmitter } = require('events');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    api: {
        shippingWsdl: 'https://ws.chronopost.fr/shipping-cxf/ShippingServiceWS?wsdl',
        trackingWsdl: 'https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS?wsdl',
        relayWsdl: 'https://ws.chronopost.fr/recherchebt-ws-cxf/PointRelaisServiceWS?wsdl',
        slotWsdl: 'https://ws.chronopost.fr/rdv-cxf/CreneauServiceWS?wsdl',
        quickCostWsdl: 'https://ws.chronopost.fr/quickcost-cxf/QuickcostServiceWS?wsdl'
    },
    credentials: {
        accountNumber: process.env.CHRONOPOST_ACCOUNT_NUMBER,
        password: process.env.CHRONOPOST_PASSWORD,
        subAccount: process.env.CHRONOPOST_SUB_ACCOUNT || ''
    },
    retry: {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 10000,
        factor: 2
    },
    rateLimit: {
        maxConcurrent: 10,
        maxPerMinute: 100,
        maxPerHour: 2000
    },
    timeout: 30000
};

// ============================================
// REDIS & RATE LIMITING
// ============================================

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const concurrencyLimit = pLimit(config.rateLimit.maxConcurrent);

class RateLimiter {
    constructor(prefix = 'chronopost') {
        this.prefix = prefix;
    }

    async checkLimit(key, maxRequests, windowSeconds) {
        const redisKey = `ratelimit:${this.prefix}:${key}`;
        const current = await redis.incr(redisKey);
        
        if (current === 1) {
            await redis.expire(redisKey, windowSeconds);
        }

        return {
            allowed: current <= maxRequests,
            remaining: Math.max(0, maxRequests - current),
            resetIn: await redis.ttl(redisKey)
        };
    }

    async waitForSlot(key, maxRequests, windowSeconds) {
        let limit = await this.checkLimit(key, maxRequests, windowSeconds);
        
        while (!limit.allowed) {
            await new Promise(resolve => setTimeout(resolve, limit.resetIn * 1000));
            limit = await this.checkLimit(key, maxRequests, windowSeconds);
        }
        
        return limit;
    }
}

const rateLimiter = new RateLimiter();

// ============================================
// ERROR CLASSES
// ============================================

class ChronopostError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = 'ChronopostError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            details: this.details,
            timestamp: this.timestamp
        };
    }
}

class ChronopostValidationError extends ChronopostError {
    constructor(message, fields = {}) {
        super(message, 'VALIDATION_ERROR', { fields });
        this.name = 'ChronopostValidationError';
    }
}

class ChronopostAPIError extends ChronopostError {
    constructor(message, apiCode, httpStatus, rawResponse) {
        super(message, 'API_ERROR', { apiCode, httpStatus, rawResponse });
        this.name = 'ChronopostAPIError';
        this.httpStatus = httpStatus;
    }

    get isRetryable() {
        if (this.httpStatus >= 500) return true;
        const retryableCodes = ['SERVICE_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', '99', '98'];
        return retryableCodes.includes(String(this.details.apiCode));
    }
}

// ============================================
// SOAP CLIENT MANAGER
// ============================================

class SOAPClientManager {
    constructor() {
        this.clients = new Map();
        this.creating = new Map();
    }

    async getClient(wsdlUrl, options = {}) {
        const cacheKey = `${wsdlUrl}:${JSON.stringify(options)}`;
        
        if (this.clients.has(cacheKey)) {
            return this.clients.get(cacheKey);
        }

        if (this.creating.has(cacheKey)) {
            return this.creating.get(cacheKey);
        }

        const createPromise = soap.createClientAsync(wsdlUrl, {
            timeout: config.timeout,
            ...options
        });

        this.creating.set(cacheKey, createPromise);

        try {
            const client = await createPromise;
            this.clients.set(cacheKey, client);
            this.creating.delete(cacheKey);
            return client;
        } catch (error) {
            this.creating.delete(cacheKey);
            throw error;
        }
    }

    clearCache() {
        this.clients.clear();
    }
}

const soapClientManager = new SOAPClientManager();

// ============================================
// METRICS & LOGGING
// ============================================

class RequestLogger extends EventEmitter {
    constructor() {
        super();
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalLatency: 0,
            errorsByType: {}
        };
    }

    async logRequest(operation, requestFn) {
        const requestId = crypto.randomUUID();
        const startTime = Date.now();
        
        this.emit('request:start', { requestId, operation, timestamp: new Date().toISOString() });
        this.metrics.totalRequests++;

        try {
            const result = await requestFn();
            const latency = Date.now() - startTime;
            
            this.metrics.successfulRequests++;
            this.metrics.totalLatency += latency;
            
            this.emit('request:success', { requestId, operation, latency, timestamp: new Date().toISOString() });

            await redis.lpush('chronopost:requests', JSON.stringify({
                requestId, operation, status: 'success', latency, timestamp: new Date().toISOString()
            }));
            await redis.ltrim('chronopost:requests', 0, 9999);

            return result;
        } catch (error) {
            const latency = Date.now() - startTime;
            
            this.metrics.failedRequests++;
            this.metrics.errorsByType[error.code] = (this.metrics.errorsByType[error.code] || 0) + 1;
            
            this.emit('request:error', { requestId, operation, error: error.toJSON?.() || error.message, latency, timestamp: new Date().toISOString() });

            await redis.lpush('chronopost:errors', JSON.stringify({
                requestId, operation, error: error.toJSON?.() || { message: error.message }, latency, timestamp: new Date().toISOString()
            }));
            await redis.ltrim('chronopost:errors', 0, 999);

            throw error;
        }
    }

    getMetrics() {
        return {
            ...this.metrics,
            averageLatency: this.metrics.totalRequests > 0 ? this.metrics.totalLatency / this.metrics.totalRequests : 0,
            successRate: this.metrics.totalRequests > 0 ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 : 0
        };
    }
}

const requestLogger = new RequestLogger();

// ============================================
// CHRONOPOST SERVICE CODES
// ============================================

const CHRONOPOST_SERVICES = {
    // Express France
    '01': { name: 'Chrono 13', description: 'Livraison avant 13h', maxWeight: 30, domestic: true },
    '02': { name: 'Chrono 10', description: 'Livraison avant 10h', maxWeight: 30, domestic: true },
    '04': { name: 'Chrono 18', description: 'Livraison avant 18h', maxWeight: 30, domestic: true },
    '06': { name: 'Chrono Samedi', description: 'Livraison le samedi matin', maxWeight: 30, domestic: true },
    '16': { name: 'Chrono Relais', description: 'Retrait en point relais', maxWeight: 20, domestic: true },
    '17': { name: 'Chrono 13 Relais', description: 'Retrait en point relais avant 13h', maxWeight: 20, domestic: true },
    '44': { name: 'Chrono Express', description: 'Express 24h', maxWeight: 30, domestic: true },
    '56': { name: 'Chrono Classic', description: 'Livraison 24-48h', maxWeight: 30, domestic: true },
    '58': { name: 'Chrono Précise', description: 'Livraison sur créneau', maxWeight: 30, domestic: true },
    
    // International
    '86': { name: 'Chrono Express Europe', description: 'Express Europe 1-2 jours', maxWeight: 30, domestic: false },
    '87': { name: 'Chrono Classic Europe', description: 'Standard Europe 2-4 jours', maxWeight: 30, domestic: false },
    '37': { name: 'Chrono International', description: 'Express International', maxWeight: 30, domestic: false },
    '38': { name: 'Chrono DHL', description: 'Express International via DHL', maxWeight: 30, domestic: false },
    
    // Special
    '91': { name: 'Chrono Retour', description: 'Etiquette retour prépayée', maxWeight: 30, domestic: true }
};

// ============================================
// VALIDATION
// ============================================

class ChronopostValidator {
    static validateAddress(address, type = 'recipient') {
        const errors = {};

        if (!address.name && !address.companyName) {
            errors.name = 'Name or company name is required';
        }

        if (!address.address1 || address.address1.length < 3) {
            errors.address1 = 'Address line 1 is required (min 3 characters)';
        }

        if (address.address1 && address.address1.length > 38) {
            errors.address1 = 'Address line 1 must be max 38 characters';
        }

        if (!address.city || address.city.length < 2) {
            errors.city = 'City is required';
        }

        if (!address.postalCode) {
            errors.postalCode = 'Postal code is required';
        } else {
            if (address.countryCode === 'FR' && !/^\d{5}$/.test(address.postalCode)) {
                errors.postalCode = 'Invalid French postal code (must be 5 digits)';
            }
        }

        if (!address.countryCode || address.countryCode.length !== 2) {
            errors.countryCode = 'Country code is required (ISO 2-letter)';
        }

        if (address.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email)) {
            errors.email = 'Invalid email format';
        }

        // Phone required for Chronopost
        if (type === 'recipient' && !address.phone && !address.mobile) {
            errors.phone = 'Phone or mobile number is required for recipient';
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    static validateParcel(parcel) {
        const errors = {};

        if (!parcel.weight || parcel.weight <= 0) {
            errors.weight = 'Weight must be greater than 0';
        }

        if (parcel.weight > 30) {
            errors.weight = 'Weight cannot exceed 30 kg for Chronopost';
        }

        // Chronopost specific dimension limits
        if (parcel.length && parcel.length > 150) {
            errors.length = 'Length cannot exceed 150 cm';
        }

        if (parcel.width && parcel.width > 150) {
            errors.width = 'Width cannot exceed 150 cm';
        }

        if (parcel.height && parcel.height > 150) {
            errors.height = 'Height cannot exceed 150 cm';
        }

        // Volumetric weight check
        if (parcel.length && parcel.width && parcel.height) {
            const volumetricWeight = (parcel.length * parcel.width * parcel.height) / 5000;
            if (volumetricWeight > 30) {
                errors.dimensions = 'Volumetric weight exceeds 30 kg limit';
            }
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    static validateShipmentRequest(request) {
        const errors = {};

        const senderValidation = this.validateAddress(request.sender, 'sender');
        if (!senderValidation.valid) {
            errors.sender = senderValidation.errors;
        }

        const recipientValidation = this.validateAddress(request.recipient, 'recipient');
        if (!recipientValidation.valid) {
            errors.recipient = recipientValidation.errors;
        }

        const parcelValidation = this.validateParcel(request.parcel);
        if (!parcelValidation.valid) {
            errors.parcel = parcelValidation.errors;
        }

        if (!request.service || !CHRONOPOST_SERVICES[request.service]) {
            errors.service = `Invalid service. Must be one of: ${Object.keys(CHRONOPOST_SERVICES).join(', ')}`;
        }

        // Check domestic/international match
        const service = CHRONOPOST_SERVICES[request.service];
        if (service) {
            const isDomestic = request.recipient?.countryCode === 'FR';
            if (service.domestic && !isDomestic) {
                errors.service = 'This service is only available for domestic shipments';
            }
        }

        if (Object.keys(errors).length > 0) {
            throw new ChronopostValidationError('Validation failed', errors);
        }

        return true;
    }
}

// ============================================
// MAIN CHRONOPOST CLIENT
// ============================================

class ChronopostClient {
    constructor(credentials = {}) {
        this.credentials = {
            ...config.credentials,
            ...credentials
        };
        this.logger = requestLogger;
    }

    // ============================================
    // SHIPMENT CREATION
    // ============================================

    async createShipment(request) {
        ChronopostValidator.validateShipmentRequest(request);
        await rateLimiter.waitForSlot('shipments', config.rateLimit.maxPerMinute, 60);

        return concurrencyLimit(() => this.logger.logRequest('createShipment', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.shippingWsdl);
                const soapRequest = this.buildShipmentRequest(request);

                const [result] = await client.shippingV7Async(soapRequest);

                if (result.return.errorCode !== 0) {
                    throw new ChronopostAPIError(
                        result.return.errorMessage || 'Shipment creation failed',
                        result.return.errorCode,
                        400,
                        result
                    );
                }

                return this.parseShipmentResponse(result, request);
            }, {
                retries: config.retry.retries,
                minTimeout: config.retry.minTimeout,
                maxTimeout: config.retry.maxTimeout,
                factor: config.retry.factor,
                onFailedAttempt: (error) => {
                    if (error instanceof ChronopostAPIError && !error.isRetryable) {
                        throw error;
                    }
                    console.log(`Chronopost API attempt ${error.attemptNumber} failed. Retrying...`);
                }
            });
        }));
    }

    buildShipmentRequest(request) {
        const now = new Date();
        const depositDate = request.depositDate || now.toISOString().split('T')[0].replace(/-/g, '');

        return {
            headerValue: {
                accountNumber: this.credentials.accountNumber,
                subAccount: this.credentials.subAccount,
                idEmit: 'ROUTZ'
            },
            shipperValue: {
                shipperCivility: request.sender.civility || 'M',
                shipperName: request.sender.companyName || request.sender.name,
                shipperName2: request.sender.name2 || '',
                shipperAdress1: request.sender.address1,
                shipperAdress2: request.sender.address2 || '',
                shipperZipCode: request.sender.postalCode,
                shipperCity: request.sender.city,
                shipperCountry: request.sender.countryCode || 'FR',
                shipperContactName: request.sender.contactName || request.sender.name,
                shipperEmail: request.sender.email || '',
                shipperPhone: request.sender.phone || '',
                shipperMobilePhone: request.sender.mobile || '',
                shipperPreAlert: request.sender.preAlert || 0
            },
            customerValue: {
                customerCivility: request.recipient.civility || 'M',
                customerName: request.recipient.companyName || request.recipient.name,
                customerName2: request.recipient.name2 || '',
                customerAdress1: request.recipient.address1,
                customerAdress2: request.recipient.address2 || '',
                customerZipCode: request.recipient.postalCode,
                customerCity: request.recipient.city,
                customerCountry: request.recipient.countryCode || 'FR',
                customerContactName: request.recipient.contactName || request.recipient.name,
                customerEmail: request.recipient.email || '',
                customerPhone: request.recipient.phone || '',
                customerMobilePhone: request.recipient.mobile || request.recipient.phone || '',
                customerPreAlert: request.recipient.preAlert !== false ? 1 : 0, // SMS/email notifications
                printAsSender: request.printAsSender || ''
            },
            recipientValue: {
                recipientName: request.recipient.companyName || request.recipient.name,
                recipientName2: request.recipient.name2 || '',
                recipientAdress1: request.recipient.address1,
                recipientAdress2: request.recipient.address2 || '',
                recipientZipCode: request.recipient.postalCode,
                recipientCity: request.recipient.city,
                recipientCountry: request.recipient.countryCode || 'FR',
                recipientContactName: request.recipient.contactName || request.recipient.name,
                recipientEmail: request.recipient.email || '',
                recipientPhone: request.recipient.phone || '',
                recipientMobilePhone: request.recipient.mobile || request.recipient.phone || '',
                recipientPreAlert: 1
            },
            refValue: {
                shipperRef: request.reference || '',
                recipientRef: request.recipientReference || '',
                customerSkybillNumber: ''
            },
            skybillValue: {
                productCode: request.service,
                shipDate: depositDate,
                shipHour: request.depositHour || '12',
                weight: request.parcel.weight,
                weightUnit: 'KGM',
                height: request.parcel.height || 1,
                length: request.parcel.length || 1,
                width: request.parcel.width || 1,
                insuredValue: request.parcel.insuranceValue || 0,
                insuredCurrency: 'EUR',
                content: request.parcel.description || 'Marchandise',
                objectType: request.parcel.objectType || 'MAR', // MAR = merchandise
                service: request.additionalService || '0',
                codCurrency: 'EUR',
                codValue: request.codValue || 0,
                customsCurrency: 'EUR',
                customsValue: request.customsValue || 0,
                portCurrency: 'EUR',
                portValue: 0
            },
            skybillParamsValue: {
                mode: request.labelFormat || 'PDF',
                duplicata: 'N',
                withReservation: 0
            },
            password: this.credentials.password,
            numberOfParcel: 1
        };
    }

    parseShipmentResponse(result, request) {
        const response = result.return.resultParcelValue || result.return;

        return {
            success: true,
            trackingNumber: response.skybillNumber,
            carrier: 'chronopost',
            service: request.service,
            serviceName: CHRONOPOST_SERVICES[request.service]?.name,
            label: {
                format: request.labelFormat || 'PDF',
                data: response.pdfEtiquette || response.skybillValue, // Base64 PDF
                url: null
            },
            barcode: response.codeDepot,
            groupingPriorityLabel: response.groupingPriorityLabel || null,
            tracking: {
                url: `https://www.chronopost.fr/tracking-no-cms/suivi-page?liession=${response.skybillNumber}`,
                events: []
            },
            estimatedDelivery: response.deliveryDate || null,
            raw: result
        };
    }

    // ============================================
    // MULTI-PARCEL SHIPMENT
    // ============================================

    async createMultiParcelShipment(request) {
        const parcels = request.parcels;
        if (!parcels || parcels.length === 0) {
            throw new ChronopostValidationError('At least one parcel is required');
        }

        if (parcels.length > 99) {
            throw new ChronopostValidationError('Maximum 99 parcels per shipment');
        }

        await rateLimiter.waitForSlot('shipments', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('createMultiParcelShipment', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.shippingWsdl);

                const results = [];
                for (let i = 0; i < parcels.length; i++) {
                    const parcelRequest = {
                        ...request,
                        parcel: parcels[i],
                        reference: `${request.reference || 'MP'}-${i + 1}`
                    };
                    
                    const soapRequest = this.buildShipmentRequest(parcelRequest);
                    soapRequest.numberOfParcel = parcels.length;
                    
                    const [result] = await client.shippingV7Async(soapRequest);
                    
                    if (result.return.errorCode !== 0) {
                        throw new ChronopostAPIError(
                            result.return.errorMessage || 'Multi-parcel shipment failed',
                            result.return.errorCode,
                            400,
                            result
                        );
                    }

                    results.push(this.parseShipmentResponse(result, parcelRequest));
                }

                return {
                    success: true,
                    parcels: results,
                    totalParcels: parcels.length,
                    masterTrackingNumber: results[0]?.trackingNumber
                };
            }, config.retry);
        });
    }

    // ============================================
    // TRACKING
    // ============================================

    async getTracking(trackingNumber) {
        await rateLimiter.waitForSlot('tracking', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('getTracking', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.trackingWsdl);

                const [result] = await client.trackSkybillV2Async({
                    accountNumber: this.credentials.accountNumber,
                    password: this.credentials.password,
                    skybillNumber: trackingNumber,
                    language: 'fr_FR'
                });

                if (!result || !result.return) {
                    throw new ChronopostAPIError('No tracking data returned', 'NO_DATA', 404, result);
                }

                return this.parseTrackingResponse(result.return, trackingNumber);
            }, config.retry);
        });
    }

    parseTrackingResponse(data, trackingNumber) {
        const events = [];
        const listEvents = data.listEvents || data.listEventInfoComp || [];
        const eventArray = Array.isArray(listEvents) ? listEvents : [listEvents];

        for (const event of eventArray) {
            if (!event) continue;
            events.push({
                timestamp: `${event.eventDate}T${event.eventHour || '00:00:00'}`,
                code: event.code,
                description: event.eventLabel || event.eventLibelle || this.getEventDescription(event.code),
                location: event.officeLabel || event.office || null,
                postalCode: event.zipCode || null
            });
        }

        events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const latestEvent = events[0];

        return {
            trackingNumber,
            carrier: 'chronopost',
            status: this.mapEventToStatus(latestEvent?.code),
            statusDescription: latestEvent?.description,
            estimatedDelivery: data.deliveryDate || null,
            delivered: this.isDelivered(latestEvent?.code),
            deliveredAt: this.isDelivered(latestEvent?.code) ? latestEvent?.timestamp : null,
            signature: data.signatureNom || null,
            events,
            weight: data.actualWeight || null,
            raw: data
        };
    }

    mapEventToStatus(eventCode) {
        const statusMap = {
            'DR': 'pending',           // Dépôt reçu
            'PH': 'in_transit',        // Pris en charge
            'TA': 'in_transit',        // Tri arrivée
            'TD': 'in_transit',        // Tri départ
            'AA': 'in_transit',        // Arrivée agence
            'PC': 'in_transit',        // Pris en charge pour livraison
            'CS': 'in_transit',        // Colis en attente
            'EL': 'out_for_delivery',  // En cours de livraison
            'DI': 'available_pickup',  // Disponible en point relais
            'AL': 'available_pickup',  // Avisé en bureau de poste
            'Li': 'delivered',         // Livré
            'LD': 'delivered',         // Livré
            'LP': 'delivered',         // Livré en point relais
            'RE': 'returned',          // Retour expéditeur
            'RA': 'returned',          // Retour arrivé
            'AN': 'exception',         // Anomalie
            'NA': 'exception',         // Non livrable
            'AR': 'exception',         // Absence - avis de passage
            'NP': 'exception'          // Refusé
        };

        return statusMap[eventCode] || 'unknown';
    }

    isDelivered(eventCode) {
        return ['Li', 'LD', 'LP'].includes(eventCode);
    }

    getEventDescription(eventCode) {
        const descriptions = {
            'DR': 'Colis déposé',
            'PH': 'Colis pris en charge par Chronopost',
            'TA': 'Arrivée au centre de tri',
            'TD': 'Départ du centre de tri',
            'AA': 'Arrivée à l\'agence de livraison',
            'PC': 'Pris en charge pour livraison',
            'EL': 'En cours de livraison',
            'DI': 'Disponible en point relais',
            'AL': 'Avisé - disponible au bureau de poste',
            'Li': 'Colis livré',
            'LD': 'Colis livré à domicile',
            'LP': 'Colis livré en point relais',
            'RE': 'Colis en retour vers l\'expéditeur',
            'AN': 'Anomalie sur le colis',
            'AR': 'Absence - avis de passage déposé',
            'NP': 'Colis refusé par le destinataire'
        };

        return descriptions[eventCode] || 'Événement de suivi';
    }

    // ============================================
    // BATCH TRACKING
    // ============================================

    async getTrackingBatch(trackingNumbers) {
        const limit = pLimit(config.rateLimit.maxConcurrent);

        const tasks = trackingNumbers.map(tn =>
            limit(async () => {
                try {
                    const result = await this.getTracking(tn);
                    return { trackingNumber: tn, success: true, ...result };
                } catch (error) {
                    return {
                        trackingNumber: tn,
                        success: false,
                        error: error.toJSON?.() || { message: error.message }
                    };
                }
            })
        );

        const results = await Promise.all(tasks);

        return {
            total: trackingNumbers.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results
        };
    }

    // ============================================
    // PICKUP POINTS (POINTS RELAIS)
    // ============================================

    async findPickupPoints(params) {
        await rateLimiter.waitForSlot('pickupPoints', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('findPickupPoints', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.relayWsdl);

                const [result] = await client.recherchePointChronopostAsync({
                    accountNumber: this.credentials.accountNumber,
                    password: this.credentials.password,
                    address: params.address || '',
                    zipCode: params.postalCode,
                    city: params.city,
                    countryCode: params.countryCode || 'FR',
                    type: params.type || 'T', // T = Tous, P = Points relais, B = Bureau de poste
                    service: params.service || 'L', // L = Livraison, T = Les deux, R = Retour
                    weight: params.weight || 1,
                    shippingDate: params.shippingDate || new Date().toISOString().split('T')[0],
                    maxPointChronopost: params.limit || 10,
                    maxDistanceSearch: params.maxDistance || 20
                });

                if (result.errorCode && result.errorCode !== '0') {
                    throw new ChronopostAPIError(
                        result.errorMessage || 'Failed to find pickup points',
                        result.errorCode,
                        400,
                        result
                    );
                }

                return this.parsePickupPointsResponse(result);
            }, config.retry);
        });
    }

    parsePickupPointsResponse(result) {
        const points = result.return?.listePointRelais || result.listePointRelais || [];
        const pointArray = Array.isArray(points) ? points : [points].filter(Boolean);

        return {
            success: true,
            count: pointArray.length,
            points: pointArray.map(point => ({
                id: point.identifiant || point.identifiantChronopostPointA2PAS,
                name: point.nom,
                type: point.typeDePoint,
                address: {
                    line1: point.adresse1,
                    line2: point.adresse2 || null,
                    line3: point.adresse3 || null,
                    postalCode: point.codePostal,
                    city: point.localite,
                    countryCode: point.codePays
                },
                location: {
                    latitude: parseFloat(point.coordGeoLatitude) || null,
                    longitude: parseFloat(point.coordGeoLongitude) || null
                },
                distance: point.distanceEnMetre ? parseInt(point.distanceEnMetre) : null,
                openingHours: this.parseOpeningHours(point),
                closedPeriods: point.periodesFermeture || null,
                parking: point.parking === 'true',
                accessible: point.accessPersonneMobiliteReduite === 'true',
                weight: {
                    max: parseFloat(point.poidsMaxi) || 20
                },
                urlPhoto: point.urlPhoto || null,
                urlGoogleMaps: point.urlGoogleMaps || null
            }))
        };
    }

    parseOpeningHours(point) {
        const days = {
            'horairesOuvertureLundi': 'monday',
            'horairesOuvertureMardi': 'tuesday',
            'horairesOuvertureMercredi': 'wednesday',
            'horairesOuvertureJeudi': 'thursday',
            'horairesOuvertureVendredi': 'friday',
            'horairesOuvertureSamedi': 'saturday',
            'horairesOuvertureDimanche': 'sunday'
        };

        const hours = {};
        for (const [key, dayName] of Object.entries(days)) {
            if (point[key]) {
                hours[dayName] = point[key];
            }
        }

        return hours;
    }

    // ============================================
    // GET RATES (QUICKCOST)
    // ============================================

    async getRates(params) {
        await rateLimiter.waitForSlot('rates', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('getRates', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.quickCostWsdl);

                const [result] = await client.quickCostAsync({
                    accountNumber: this.credentials.accountNumber,
                    password: this.credentials.password,
                    depCode: params.origin?.postalCode || '75001',
                    arrCode: params.destination.postalCode,
                    weight: params.weight,
                    productCode: params.service || '01', // Default to Chrono 13
                    type: 'M' // M = merchandise
                });

                if (result.return?.errorCode && result.return.errorCode !== 0) {
                    throw new ChronopostAPIError(
                        result.return.errorMessage || 'Failed to get rates',
                        result.return.errorCode,
                        400,
                        result
                    );
                }

                return this.parseRatesResponse(result, params);
            }, config.retry);
        });
    }

    parseRatesResponse(result, params) {
        const data = result.return;
        
        // If specific service requested
        if (params.service) {
            return {
                success: true,
                origin: params.origin || { countryCode: 'FR' },
                destination: params.destination,
                weight: params.weight,
                rates: [{
                    service: params.service,
                    serviceName: CHRONOPOST_SERVICES[params.service]?.name || 'Chronopost',
                    description: CHRONOPOST_SERVICES[params.service]?.description,
                    price: parseFloat(data.amountTTC) || 0,
                    priceHT: parseFloat(data.amountHT) || 0,
                    currency: 'EUR',
                    estimatedDays: this.getEstimatedDays(params.service),
                    maxWeight: CHRONOPOST_SERVICES[params.service]?.maxWeight || 30
                }]
            };
        }

        // Return all available services
        const rates = [];
        const availableServices = Object.entries(CHRONOPOST_SERVICES).filter(([code, info]) => {
            const isDomestic = params.destination.countryCode === 'FR';
            return info.domestic === isDomestic || !info.domestic;
        });

        for (const [code, info] of availableServices) {
            if (params.weight > info.maxWeight) continue;

            rates.push({
                service: code,
                serviceName: info.name,
                description: info.description,
                price: null, // Would need individual quickCost calls
                currency: 'EUR',
                estimatedDays: this.getEstimatedDays(code),
                maxWeight: info.maxWeight
            });
        }

        return {
            success: true,
            origin: params.origin || { countryCode: 'FR' },
            destination: params.destination,
            weight: params.weight,
            rates
        };
    }

    getEstimatedDays(service) {
        const estimates = {
            '01': { min: 1, max: 1 },    // Chrono 13
            '02': { min: 1, max: 1 },    // Chrono 10
            '04': { min: 1, max: 1 },    // Chrono 18
            '06': { min: 1, max: 1 },    // Chrono Samedi
            '16': { min: 1, max: 2 },    // Chrono Relais
            '44': { min: 1, max: 1 },    // Chrono Express
            '56': { min: 1, max: 2 },    // Chrono Classic
            '86': { min: 1, max: 2 },    // Express Europe
            '87': { min: 2, max: 4 },    // Classic Europe
            '37': { min: 2, max: 5 },    // International
            '38': { min: 2, max: 5 }     // International DHL
        };

        return estimates[service] || { min: 1, max: 3 };
    }

    // ============================================
    // DELIVERY SLOTS (CRÉNEAUX)
    // ============================================

    async getDeliverySlots(params) {
        await rateLimiter.waitForSlot('slots', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('getDeliverySlots', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.slotWsdl);

                const [result] = await client.searchDeliverySlotAsync({
                    accountNumber: this.credentials.accountNumber,
                    password: this.credentials.password,
                    recipientZipCode: params.postalCode,
                    recipientCity: params.city,
                    recipientCountryCode: params.countryCode || 'FR',
                    productType: params.service || '58', // Chrono Précise
                    dateBegin: params.dateFrom || new Date().toISOString().split('T')[0],
                    dateEnd: params.dateTo || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
                });

                if (result.return?.errorCode && result.return.errorCode !== 0) {
                    throw new ChronopostAPIError(
                        result.return.errorMessage || 'Failed to get delivery slots',
                        result.return.errorCode,
                        400,
                        result
                    );
                }

                return this.parseDeliverySlotsResponse(result);
            }, config.retry);
        });
    }

    parseDeliverySlotsResponse(result) {
        const slots = result.return?.listeCreneaux || [];
        const slotArray = Array.isArray(slots) ? slots : [slots].filter(Boolean);

        return {
            success: true,
            count: slotArray.length,
            slots: slotArray.map(slot => ({
                id: slot.codeRDV,
                date: slot.dateRDV,
                timeFrom: slot.heureDebut,
                timeTo: slot.heureFin,
                available: slot.dispo === 'O',
                price: parseFloat(slot.tarif) || 0,
                currency: 'EUR'
            }))
        };
    }

    // ============================================
    // RESERVE DELIVERY SLOT
    // ============================================

    async reserveDeliverySlot(slotId, shipmentData) {
        await rateLimiter.waitForSlot('slots', 10, 60);

        return this.logger.logRequest('reserveDeliverySlot', async () => {
            const client = await soapClientManager.getClient(config.api.slotWsdl);

            const [result] = await client.confirmDeliverySlotV2Async({
                accountNumber: this.credentials.accountNumber,
                password: this.credentials.password,
                codeRDV: slotId,
                ...this.buildShipmentRequest(shipmentData)
            });

            if (result.return?.errorCode && result.return.errorCode !== 0) {
                throw new ChronopostAPIError(
                    result.return.errorMessage || 'Failed to reserve delivery slot',
                    result.return.errorCode,
                    400,
                    result
                );
            }

            return {
                success: true,
                slotId,
                trackingNumber: result.return.skybillNumber,
                confirmationCode: result.return.codeConfirmation
            };
        });
    }

    // ============================================
    // CANCEL SHIPMENT
    // ============================================

    async cancelShipment(trackingNumber) {
        await rateLimiter.waitForSlot('cancel', 10, 60);

        return this.logger.logRequest('cancelShipment', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.shippingWsdl);

                const [result] = await client.cancelSkybillAsync({
                    accountNumber: this.credentials.accountNumber,
                    password: this.credentials.password,
                    skybillNumber: trackingNumber
                });

                if (result.return?.errorCode && result.return.errorCode !== 0) {
                    throw new ChronopostAPIError(
                        result.return.errorMessage || 'Failed to cancel shipment',
                        result.return.errorCode,
                        400,
                        result
                    );
                }

                return {
                    success: true,
                    trackingNumber,
                    cancelledAt: new Date().toISOString()
                };
            }, config.retry);
        });
    }

    // ============================================
    // WEBHOOK HANDLER
    // ============================================

    async handleWebhook(payload, signature) {
        const expectedSignature = crypto
            .createHmac('sha256', this.credentials.webhookSecret || this.credentials.password)
            .update(JSON.stringify(payload))
            .digest('hex');

        if (signature !== expectedSignature) {
            throw new ChronopostError('Invalid webhook signature', 'INVALID_SIGNATURE', 401);
        }

        const event = {
            type: this.mapWebhookEventType(payload.eventCode),
            trackingNumber: payload.skybillNumber,
            timestamp: payload.eventDate,
            code: payload.eventCode,
            description: payload.eventLabel || this.getEventDescription(payload.eventCode),
            location: payload.officeLabel || null,
            raw: payload
        };

        return event;
    }

    mapWebhookEventType(eventCode) {
        const typeMap = {
            'DR': 'shipment.created',
            'PH': 'shipment.in_transit',
            'EL': 'shipment.out_for_delivery',
            'Li': 'shipment.delivered',
            'LD': 'shipment.delivered',
            'LP': 'shipment.delivered_pickup',
            'DI': 'shipment.available_pickup',
            'RE': 'shipment.returned',
            'AN': 'shipment.exception',
            'AR': 'shipment.exception'
        };

        return typeMap[eventCode] || 'shipment.update';
    }

    // ============================================
    // HEALTH CHECK
    // ============================================

    async healthCheck() {
        try {
            const client = await soapClientManager.getClient(config.api.shippingWsdl);
            const metrics = this.logger.getMetrics();

            return {
                status: 'healthy',
                carrier: 'chronopost',
                timestamp: new Date().toISOString(),
                metrics: {
                    totalRequests: metrics.totalRequests,
                    successRate: metrics.successRate.toFixed(2) + '%',
                    averageLatency: Math.round(metrics.averageLatency) + 'ms'
                }
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                carrier: 'chronopost',
                timestamp: new Date().toISOString(),
                error: error.message
            };
        }
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    ChronopostClient,
    ChronopostError,
    ChronopostValidationError,
    ChronopostAPIError,
    ChronopostValidator,
    CHRONOPOST_SERVICES,
    requestLogger,
    rateLimiter
};
