/**
 * ROUTZ - Colissimo API Connector
 * Real implementation with retry, error handling, rate limiting
 * API: Colissimo Web Services (SOAP/REST)
 */

const soap = require('soap');
const axios = require('axios');
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
        wsdlUrl: 'https://ws.colissimo.fr/sls-ws/SlsServiceWS?wsdl',
        trackingApiUrl: 'https://www.coliposte.fr/tracking-chargeur-cxf/TrackingServiceWS',
        labelApiUrl: 'https://ws.colissimo.fr/sls-ws/SlsServiceWS',
        pointRelaisUrl: 'https://ws.colissimo.fr/pointretrait-ws-cxf/PointRetraitServiceWS/2.0',
        bordereau: 'https://ws.colissimo.fr/sls-ws/BordereauServiceWS'
    },
    credentials: {
        contractNumber: process.env.COLISSIMO_CONTRACT_NUMBER,
        password: process.env.COLISSIMO_PASSWORD,
        accountId: process.env.COLISSIMO_ACCOUNT_ID
    },
    retry: {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 10000,
        factor: 2
    },
    rateLimit: {
        maxConcurrent: 10,
        maxPerMinute: 60,
        maxPerHour: 1000
    },
    timeout: 30000
};

// ============================================
// REDIS & RATE LIMITING
// ============================================

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const concurrencyLimit = pLimit(config.rateLimit.maxConcurrent);

class RateLimiter {
    constructor(prefix = 'colissimo') {
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

class ColissimoError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = 'ColissimoError';
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

class ColissimoValidationError extends ColissimoError {
    constructor(message, fields = {}) {
        super(message, 'VALIDATION_ERROR', { fields });
        this.name = 'ColissimoValidationError';
    }
}

class ColissimoAPIError extends ColissimoError {
    constructor(message, apiCode, httpStatus, rawResponse) {
        super(message, 'API_ERROR', { apiCode, httpStatus, rawResponse });
        this.name = 'ColissimoAPIError';
        this.httpStatus = httpStatus;
    }

    get isRetryable() {
        // Retry on server errors and specific API codes
        if (this.httpStatus >= 500) return true;
        const retryableCodes = ['SERVICE_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT'];
        return retryableCodes.includes(this.details.apiCode);
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
// REQUEST LOGGER & METRICS
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
            
            this.emit('request:success', { 
                requestId, 
                operation, 
                latency,
                timestamp: new Date().toISOString()
            });

            // Store in Redis for monitoring
            await redis.lpush('colissimo:requests', JSON.stringify({
                requestId,
                operation,
                status: 'success',
                latency,
                timestamp: new Date().toISOString()
            }));
            await redis.ltrim('colissimo:requests', 0, 9999);

            return result;
        } catch (error) {
            const latency = Date.now() - startTime;
            
            this.metrics.failedRequests++;
            this.metrics.errorsByType[error.code] = (this.metrics.errorsByType[error.code] || 0) + 1;
            
            this.emit('request:error', { 
                requestId, 
                operation, 
                error: error.toJSON?.() || error.message,
                latency,
                timestamp: new Date().toISOString()
            });

            await redis.lpush('colissimo:errors', JSON.stringify({
                requestId,
                operation,
                error: error.toJSON?.() || { message: error.message },
                latency,
                timestamp: new Date().toISOString()
            }));
            await redis.ltrim('colissimo:errors', 0, 999);

            throw error;
        }
    }

    getMetrics() {
        return {
            ...this.metrics,
            averageLatency: this.metrics.totalRequests > 0 
                ? this.metrics.totalLatency / this.metrics.totalRequests 
                : 0,
            successRate: this.metrics.totalRequests > 0 
                ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 
                : 0
        };
    }
}

const requestLogger = new RequestLogger();

// ============================================
// VALIDATION
// ============================================

class ColissimoValidator {
    static validateAddress(address, type = 'recipient') {
        const errors = {};

        if (!address.companyName && !address.lastName) {
            errors.name = 'Company name or last name is required';
        }

        if (!address.line1 || address.line1.length < 3) {
            errors.line1 = 'Address line 1 is required (min 3 characters)';
        }

        if (address.line1 && address.line1.length > 35) {
            errors.line1 = 'Address line 1 must be max 35 characters';
        }

        if (!address.city || address.city.length < 2) {
            errors.city = 'City is required';
        }

        if (!address.postalCode) {
            errors.postalCode = 'Postal code is required';
        } else {
            // Validate French postal code
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

        if (address.phone) {
            const cleanPhone = address.phone.replace(/[\s\-\.]/g, '');
            if (!/^\+?\d{9,15}$/.test(cleanPhone)) {
                errors.phone = 'Invalid phone number format';
            }
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
            errors.weight = 'Weight cannot exceed 30 kg for Colissimo';
        }

        if (parcel.length && parcel.length > 100) {
            errors.length = 'Length cannot exceed 100 cm';
        }

        if (parcel.width && parcel.width > 100) {
            errors.width = 'Width cannot exceed 100 cm';
        }

        if (parcel.height && parcel.height > 100) {
            errors.height = 'Height cannot exceed 100 cm';
        }

        // Check combined dimensions
        if (parcel.length && parcel.width && parcel.height) {
            const girth = 2 * (parcel.width + parcel.height) + parcel.length;
            if (girth > 300) {
                errors.dimensions = 'Combined dimensions (L + 2*(W+H)) cannot exceed 300 cm';
            }
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    static validateShipmentRequest(request) {
        const errors = {};

        // Validate sender
        const senderValidation = this.validateAddress(request.sender, 'sender');
        if (!senderValidation.valid) {
            errors.sender = senderValidation.errors;
        }

        // Validate recipient
        const recipientValidation = this.validateAddress(request.recipient, 'recipient');
        if (!recipientValidation.valid) {
            errors.recipient = recipientValidation.errors;
        }

        // Validate parcel
        const parcelValidation = this.validateParcel(request.parcel);
        if (!parcelValidation.valid) {
            errors.parcel = parcelValidation.errors;
        }

        // Validate service
        const validServices = [
            'DOM', 'DOS', 'COL', 'BPR', 'A2P', 'CMT', 'CDS', 'COLD',
            'COM', 'CORI', 'CORE', 'J+1', 'COLR'
        ];
        if (!request.service || !validServices.includes(request.service)) {
            errors.service = `Invalid service. Must be one of: ${validServices.join(', ')}`;
        }

        // Validate customs for international
        if (request.recipient?.countryCode !== 'FR' && !['BE', 'DE', 'ES', 'IT', 'LU', 'NL', 'PT', 'AT', 'IE'].includes(request.recipient?.countryCode)) {
            if (!request.customs || !request.customs.contents || request.customs.contents.length === 0) {
                errors.customs = 'Customs declaration required for non-EU destinations';
            }
        }

        if (Object.keys(errors).length > 0) {
            throw new ColissimoValidationError('Validation failed', errors);
        }

        return true;
    }
}

// ============================================
// COLISSIMO SERVICE CODES
// ============================================

const COLISSIMO_SERVICES = {
    // France métropolitaine
    'DOM': { name: 'Colissimo Domicile', description: 'Livraison à domicile sans signature', maxWeight: 30 },
    'DOS': { name: 'Colissimo Domicile Signature', description: 'Livraison à domicile avec signature', maxWeight: 30 },
    'COL': { name: 'Colissimo Expert', description: 'Livraison express J+1', maxWeight: 30 },
    'BPR': { name: 'Colissimo Point Retrait', description: 'Retrait en point relais', maxWeight: 20 },
    'A2P': { name: 'Colissimo Bureau de Poste', description: 'Retrait en bureau de poste', maxWeight: 20 },
    'CMT': { name: 'Colissimo Retour', description: 'Etiquette retour prépayée', maxWeight: 30 },

    // International
    'COM': { name: 'Colissimo International', description: 'International standard', maxWeight: 30 },
    'CORI': { name: 'Colissimo International Eco', description: 'International économique', maxWeight: 30 },
    'CORE': { name: 'Colissimo Europe', description: 'Europe standard', maxWeight: 30 },
    'CDS': { name: 'Colissimo Expert International', description: 'Express international', maxWeight: 30 },

    // Outre-mer
    'COLD': { name: 'Colissimo Outre-Mer Domicile', description: 'DOM-TOM domicile', maxWeight: 30 },
    'COLR': { name: 'Colissimo Outre-Mer Retrait', description: 'DOM-TOM point retrait', maxWeight: 30 }
};

// ============================================
// MAIN COLISSIMO CLIENT
// ============================================

class ColissimoClient {
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
        // Validate request
        ColissimoValidator.validateShipmentRequest(request);

        // Rate limiting
        await rateLimiter.waitForSlot('shipments', config.rateLimit.maxPerMinute, 60);

        return concurrencyLimit(() => this.logger.logRequest('createShipment', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.wsdlUrl);

                const soapRequest = this.buildShipmentRequest(request);

                const [result] = await client.generateLabelAsync(soapRequest);

                if (result.messages?.id && result.messages.id !== '0') {
                    throw new ColissimoAPIError(
                        result.messages.messageContent || 'Shipment creation failed',
                        result.messages.id,
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
                    if (error instanceof ColissimoAPIError && !error.isRetryable) {
                        throw error; // Don't retry non-retryable errors
                    }
                    console.log(`Colissimo API attempt ${error.attemptNumber} failed. Retrying...`);
                }
            });
        }));
    }

    buildShipmentRequest(request) {
        const serviceInfo = COLISSIMO_SERVICES[request.service];
        
        const soapRequest = {
            generateLabelRequest: {
                contractNumber: this.credentials.contractNumber,
                password: this.credentials.password,
                outputFormat: {
                    x: 0,
                    y: 0,
                    outputPrintingType: request.labelFormat || 'PDF_A4_300dpi'
                },
                letter: {
                    service: {
                        productCode: request.service,
                        depositDate: request.depositDate || new Date().toISOString().split('T')[0],
                        orderNumber: request.orderNumber || '',
                        commercialName: request.commercialName || ''
                    },
                    parcel: {
                        weight: request.parcel.weight,
                        insuranceValue: request.parcel.insuranceValue || 0,
                        recommendationLevel: request.parcel.recommendation || '',
                        instructions: request.parcel.instructions || ''
                    },
                    sender: {
                        senderParcelRef: request.reference || '',
                        address: {
                            companyName: request.sender.companyName || '',
                            lastName: request.sender.lastName || '',
                            firstName: request.sender.firstName || '',
                            line0: request.sender.line0 || '',
                            line1: request.sender.line1 || '',
                            line2: request.sender.line2 || '',
                            line3: request.sender.line3 || '',
                            countryCode: request.sender.countryCode || 'FR',
                            city: request.sender.city,
                            zipCode: request.sender.postalCode,
                            phoneNumber: request.sender.phone || '',
                            mobileNumber: request.sender.mobile || '',
                            email: request.sender.email || ''
                        }
                    },
                    addressee: {
                        addresseeParcelRef: request.recipientReference || '',
                        address: {
                            companyName: request.recipient.companyName || '',
                            lastName: request.recipient.lastName || '',
                            firstName: request.recipient.firstName || '',
                            line0: request.recipient.line0 || '',
                            line1: request.recipient.line1 || '',
                            line2: request.recipient.line2 || '',
                            line3: request.recipient.line3 || '',
                            countryCode: request.recipient.countryCode || 'FR',
                            city: request.recipient.city,
                            zipCode: request.recipient.postalCode,
                            phoneNumber: request.recipient.phone || '',
                            mobileNumber: request.recipient.mobile || '',
                            email: request.recipient.email || '',
                            doorCode1: request.recipient.doorCode1 || '',
                            doorCode2: request.recipient.doorCode2 || '',
                            intercom: request.recipient.intercom || ''
                        }
                    }
                }
            }
        };

        // Add pickup point for BPR/A2P services
        if (['BPR', 'A2P'].includes(request.service) && request.pickupPointId) {
            soapRequest.generateLabelRequest.letter.service.pickupPointId = request.pickupPointId;
        }

        // Add customs declaration for international
        if (request.customs) {
            soapRequest.generateLabelRequest.letter.customsDeclarations = {
                contents: {
                    category: request.customs.category || 1, // 1 = Gift, 2 = Sample, 3 = Commercial
                    article: request.customs.contents.map(item => ({
                        description: item.description,
                        quantity: item.quantity,
                        weight: item.weight,
                        value: item.value,
                        hsCode: item.hsCode || '',
                        originCountry: item.originCountry || 'FR',
                        currency: item.currency || 'EUR'
                    }))
                }
            };
        }

        // Add return label if requested
        if (request.includeReturnLabel) {
            soapRequest.generateLabelRequest.fields = {
                ...soapRequest.generateLabelRequest.fields,
                returnTypeChoice: 3 // Include return label
            };
        }

        return soapRequest;
    }

    parseShipmentResponse(result, request) {
        const labelResponse = result.labelV2Response || result.labelResponse || result;

        return {
            success: true,
            trackingNumber: labelResponse.parcelNumber,
            carrier: 'colissimo',
            service: request.service,
            serviceName: COLISSIMO_SERVICES[request.service]?.name,
            label: {
                format: request.labelFormat || 'PDF_A4_300dpi',
                data: labelResponse.label, // Base64 encoded PDF
                url: labelResponse.pdfUrl || null
            },
            parcelNumberPartner: labelResponse.parcelNumberPartner || null,
            tracking: {
                url: `https://www.laposte.fr/outils/suivre-vos-envois?code=${labelResponse.parcelNumber}`,
                events: []
            },
            customs: labelResponse.cn23 ? {
                document: labelResponse.cn23,
                format: 'PDF'
            } : null,
            returnLabel: labelResponse.returnLabel ? {
                trackingNumber: labelResponse.returnLabelParcelNumber,
                label: labelResponse.returnLabel
            } : null,
            raw: result
        };
    }

    // ============================================
    // BATCH SHIPMENT CREATION
    // ============================================

    async createShipmentsBatch(requests, options = {}) {
        const { parallel = 5, stopOnError = false } = options;
        const limit = pLimit(parallel);

        const results = [];
        const errors = [];

        const tasks = requests.map((request, index) => 
            limit(async () => {
                try {
                    const result = await this.createShipment(request);
                    results.push({ index, success: true, ...result });
                    return result;
                } catch (error) {
                    const errorResult = { 
                        index, 
                        success: false, 
                        error: error.toJSON?.() || { message: error.message } 
                    };
                    errors.push(errorResult);
                    
                    if (stopOnError) {
                        throw error;
                    }
                    return errorResult;
                }
            })
        );

        await Promise.all(tasks);

        return {
            total: requests.length,
            successful: results.length,
            failed: errors.length,
            results,
            errors
        };
    }

    // ============================================
    // TRACKING
    // ============================================

    async getTracking(trackingNumber) {
        await rateLimiter.waitForSlot('tracking', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('getTracking', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.trackingApiUrl);

                const [result] = await client.trackAsync({
                    accountNumber: this.credentials.accountId,
                    password: this.credentials.password,
                    skybillNumber: trackingNumber
                });

                if (!result || !result.return) {
                    throw new ColissimoAPIError('No tracking data returned', 'NO_DATA', 404, result);
                }

                return this.parseTrackingResponse(result.return, trackingNumber);
            }, config.retry);
        });
    }

    parseTrackingResponse(data, trackingNumber) {
        const events = [];
        
        if (data.eventInfo) {
            const eventList = Array.isArray(data.eventInfo) ? data.eventInfo : [data.eventInfo];
            
            for (const event of eventList) {
                events.push({
                    timestamp: event.eventDate,
                    code: event.eventCode,
                    description: event.eventLibelle || this.getEventDescription(event.eventCode),
                    location: event.eventSite || null,
                    postalCode: event.recipientZipCode || null
                });
            }
        }

        // Sort events by timestamp (most recent first)
        events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const latestEvent = events[0];
        
        return {
            trackingNumber,
            carrier: 'colissimo',
            status: this.mapEventToStatus(latestEvent?.code),
            statusDescription: latestEvent?.description,
            estimatedDelivery: data.deliveryDate || null,
            delivered: this.isDelivered(latestEvent?.code),
            deliveredAt: this.isDelivered(latestEvent?.code) ? latestEvent?.timestamp : null,
            events,
            raw: data
        };
    }

    mapEventToStatus(eventCode) {
        const statusMap = {
            'PC1': 'pending',          // Pris en charge
            'PC2': 'in_transit',       // Pris en charge
            'ET1': 'in_transit',       // En cours de traitement
            'ET2': 'in_transit',       // En cours d'acheminement
            'ET3': 'in_transit',       // En cours d'acheminement
            'ET4': 'in_transit',       // Arrivée dans le pays de destination
            'DR1': 'out_for_delivery', // En cours de livraison
            'MD2': 'delivered',        // Distribué
            'AG1': 'available_pickup', // Disponible en point de retrait
            'RE1': 'returned',         // Retour à l'expéditeur
            'CO1': 'exception',        // Colis endommagé
            'DI1': 'exception',        // Destinataire absent
            'DI2': 'exception',        // Boîte aux lettres non accessible
            'ND1': 'exception'         // Non distribuable
        };

        return statusMap[eventCode] || 'unknown';
    }

    isDelivered(eventCode) {
        return ['MD2', 'AG1'].includes(eventCode);
    }

    getEventDescription(eventCode) {
        const descriptions = {
            'PC1': 'Pris en charge par La Poste',
            'PC2': 'Pris en charge',
            'ET1': 'En cours de traitement dans un centre de tri',
            'ET2': 'En cours d\'acheminement',
            'ET3': 'En cours d\'acheminement vers le site de livraison',
            'ET4': 'Arrivée dans le pays de destination',
            'DR1': 'En cours de livraison',
            'MD2': 'Colis livré',
            'AG1': 'Colis disponible en point de retrait',
            'RE1': 'Colis en retour vers l\'expéditeur',
            'CO1': 'Colis endommagé',
            'DI1': 'Destinataire absent - avis de passage déposé',
            'DI2': 'Boîte aux lettres non accessible',
            'ND1': 'Colis non distribuable'
        };

        return descriptions[eventCode] || 'Événement inconnu';
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
    // PICKUP POINTS
    // ============================================

    async findPickupPoints(params) {
        await rateLimiter.waitForSlot('pickupPoints', config.rateLimit.maxPerMinute, 60);

        return this.logger.logRequest('findPickupPoints', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.pointRelaisUrl);

                const [result] = await client.findRDVPointRetraitAcheminementAsync({
                    accountNumber: this.credentials.accountId,
                    password: this.credentials.password,
                    address: params.address,
                    zipCode: params.postalCode,
                    city: params.city,
                    countryCode: params.countryCode || 'FR',
                    weight: params.weight || 1,
                    shippingDate: params.shippingDate || new Date().toISOString().split('T')[0],
                    filterRelay: params.filterRelay || '1', // 1 = All, 2 = Pickup only, 3 = Post office only
                    requestId: crypto.randomUUID()
                });

                if (result.errorCode && result.errorCode !== '0') {
                    throw new ColissimoAPIError(
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
        const points = result.listePointRetraitAcheminement || [];
        
        return {
            success: true,
            count: points.length,
            points: points.map(point => ({
                id: point.identifiant,
                name: point.nom,
                type: point.typeDePoint, // BPR, A2P, PCS
                address: {
                    line1: point.adresse1,
                    line2: point.adresse2 || null,
                    postalCode: point.codePostal,
                    city: point.localite,
                    countryCode: point.codePays
                },
                location: {
                    latitude: parseFloat(point.coordGeolocalisationLatitude) || null,
                    longitude: parseFloat(point.coordGeolocalisationLongitude) || null
                },
                distance: point.distanceEnMetre ? parseInt(point.distanceEnMetre) : null,
                openingHours: this.parseOpeningHours(point),
                parking: point.parking === '1',
                accessible: point.accesPersonneMobiliteReduite === '1',
                weight: {
                    max: parseFloat(point.poidsMaxi) || 20
                }
            }))
        };
    }

    parseOpeningHours(point) {
        const days = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
        const hours = {};

        for (const day of days) {
            const horaires = point[`horairesOuverture${day.charAt(0).toUpperCase() + day.slice(1)}`];
            if (horaires) {
                hours[day] = horaires;
            }
        }

        return hours;
    }

    // ============================================
    // CANCEL SHIPMENT
    // ============================================

    async cancelShipment(trackingNumber) {
        await rateLimiter.waitForSlot('cancel', 10, 60);

        return this.logger.logRequest('cancelShipment', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.wsdlUrl);

                const [result] = await client.cancelLetterAsync({
                    contractNumber: this.credentials.contractNumber,
                    password: this.credentials.password,
                    parcelNumber: trackingNumber
                });

                if (result.errorCode && result.errorCode !== '0') {
                    throw new ColissimoAPIError(
                        result.errorMessage || 'Failed to cancel shipment',
                        result.errorCode,
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
    // GET RATES
    // ============================================

    async getRates(params) {
        const { weight, destination, services } = params;
        
        // Colissimo doesn't have a real-time rates API
        // We use predefined pricing grids cached in Redis
        const cacheKey = `colissimo:rates:${destination.countryCode}`;
        let ratesGrid = await redis.get(cacheKey);

        if (!ratesGrid) {
            ratesGrid = this.getDefaultRatesGrid(destination.countryCode);
            await redis.setex(cacheKey, 86400, JSON.stringify(ratesGrid)); // Cache 24h
        } else {
            ratesGrid = JSON.parse(ratesGrid);
        }

        const availableServices = services || Object.keys(COLISSIMO_SERVICES);
        const rates = [];

        for (const service of availableServices) {
            if (!COLISSIMO_SERVICES[service]) continue;
            
            const serviceInfo = COLISSIMO_SERVICES[service];
            if (weight > serviceInfo.maxWeight) continue;

            const rate = this.calculateRate(service, weight, destination, ratesGrid);
            if (rate) {
                rates.push({
                    service,
                    serviceName: serviceInfo.name,
                    description: serviceInfo.description,
                    price: rate.price,
                    currency: 'EUR',
                    estimatedDays: rate.estimatedDays,
                    maxWeight: serviceInfo.maxWeight
                });
            }
        }

        // Sort by price
        rates.sort((a, b) => a.price - b.price);

        return {
            success: true,
            origin: params.origin || { countryCode: 'FR' },
            destination,
            weight,
            rates
        };
    }

    getDefaultRatesGrid(countryCode) {
        // France métropolitaine
        if (countryCode === 'FR') {
            return {
                DOM: { 
                    prices: { 0.5: 4.95, 1: 6.55, 2: 7.45, 5: 8.95, 10: 13.75, 30: 19.50 },
                    estimatedDays: { min: 2, max: 3 }
                },
                DOS: {
                    prices: { 0.5: 6.25, 1: 7.85, 2: 8.75, 5: 10.25, 10: 15.05, 30: 20.80 },
                    estimatedDays: { min: 2, max: 3 }
                },
                COL: {
                    prices: { 0.5: 9.95, 1: 11.55, 2: 13.45, 5: 17.95, 10: 24.75, 30: 34.50 },
                    estimatedDays: { min: 1, max: 1 }
                },
                BPR: {
                    prices: { 0.5: 3.99, 1: 4.99, 2: 5.99, 5: 6.99, 10: 9.99, 20: 14.99 },
                    estimatedDays: { min: 3, max: 5 }
                }
            };
        }

        // Europe
        if (['BE', 'DE', 'ES', 'IT', 'NL', 'PT', 'AT', 'LU'].includes(countryCode)) {
            return {
                CORE: {
                    prices: { 0.5: 12.65, 1: 14.25, 2: 16.45, 5: 22.95, 10: 35.75, 30: 55.50 },
                    estimatedDays: { min: 3, max: 6 }
                },
                CDS: {
                    prices: { 0.5: 19.95, 1: 24.55, 2: 29.45, 5: 39.95, 10: 59.75, 30: 89.50 },
                    estimatedDays: { min: 2, max: 4 }
                }
            };
        }

        // International
        return {
            COM: {
                prices: { 0.5: 16.65, 1: 21.25, 2: 28.45, 5: 45.95, 10: 75.75, 30: 125.50 },
                estimatedDays: { min: 5, max: 10 }
            },
            CORI: {
                prices: { 0.5: 12.95, 1: 16.55, 2: 22.45, 5: 35.95, 10: 55.75, 30: 95.50 },
                estimatedDays: { min: 7, max: 15 }
            }
        };
    }

    calculateRate(service, weight, destination, ratesGrid) {
        const serviceRates = ratesGrid[service];
        if (!serviceRates) return null;

        const weightBrackets = Object.keys(serviceRates.prices).map(Number).sort((a, b) => a - b);
        let price = null;

        for (const bracket of weightBrackets) {
            if (weight <= bracket) {
                price = serviceRates.prices[bracket];
                break;
            }
        }

        if (price === null) {
            const maxBracket = weightBrackets[weightBrackets.length - 1];
            price = serviceRates.prices[maxBracket];
        }

        return {
            price,
            estimatedDays: serviceRates.estimatedDays
        };
    }

    // ============================================
    // GENERATE BORDEREAU (MANIFEST)
    // ============================================

    async generateBordereau(trackingNumbers, options = {}) {
        await rateLimiter.waitForSlot('bordereau', 10, 60);

        return this.logger.logRequest('generateBordereau', async () => {
            return pRetry(async () => {
                const client = await soapClientManager.getClient(config.api.bordereau);

                const [result] = await client.generateBordereauByParcelsNumbersAsync({
                    contractNumber: this.credentials.contractNumber,
                    password: this.credentials.password,
                    parcelsNumbers: trackingNumbers,
                    bordereauHeader: options.header || '',
                    generateDate: new Date().toISOString().split('T')[0]
                });

                if (result.errorCode && result.errorCode !== '0') {
                    throw new ColissimoAPIError(
                        result.errorMessage || 'Failed to generate bordereau',
                        result.errorCode,
                        400,
                        result
                    );
                }

                return {
                    success: true,
                    bordereauNumber: result.bordereauNumber,
                    document: result.bordereauFile, // Base64 PDF
                    trackingNumbers,
                    generatedAt: new Date().toISOString()
                };
            }, config.retry);
        });
    }

    // ============================================
    // WEBHOOK HANDLER
    // ============================================

    async handleWebhook(payload, signature) {
        // Verify webhook signature
        const expectedSignature = crypto
            .createHmac('sha256', this.credentials.webhookSecret || this.credentials.password)
            .update(JSON.stringify(payload))
            .digest('hex');

        if (signature !== expectedSignature) {
            throw new ColissimoError('Invalid webhook signature', 'INVALID_SIGNATURE', 401);
        }

        // Parse and normalize event
        const event = {
            type: this.mapWebhookEventType(payload.eventCode),
            trackingNumber: payload.parcelNumber,
            timestamp: payload.eventDate,
            code: payload.eventCode,
            description: payload.eventLabel || this.getEventDescription(payload.eventCode),
            location: payload.eventSite || null,
            raw: payload
        };

        return event;
    }

    mapWebhookEventType(eventCode) {
        const typeMap = {
            'PC1': 'shipment.created',
            'PC2': 'shipment.created',
            'ET1': 'shipment.in_transit',
            'ET2': 'shipment.in_transit',
            'DR1': 'shipment.out_for_delivery',
            'MD2': 'shipment.delivered',
            'AG1': 'shipment.available_pickup',
            'RE1': 'shipment.returned',
            'DI1': 'shipment.exception',
            'DI2': 'shipment.exception'
        };

        return typeMap[eventCode] || 'shipment.update';
    }

    // ============================================
    // HEALTH CHECK
    // ============================================

    async healthCheck() {
        try {
            const client = await soapClientManager.getClient(config.api.wsdlUrl);
            
            // Simple ping to verify connectivity
            const [result] = await client.checkGenerateLabelAsync({
                contractNumber: this.credentials.contractNumber,
                password: this.credentials.password
            });

            const metrics = this.logger.getMetrics();

            return {
                status: 'healthy',
                carrier: 'colissimo',
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
                carrier: 'colissimo',
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
    ColissimoClient,
    ColissimoError,
    ColissimoValidationError,
    ColissimoAPIError,
    ColissimoValidator,
    COLISSIMO_SERVICES,
    requestLogger,
    rateLimiter
};
