/**
 * ROUTZ - Negotiated Rates Service
 * Gestion des contrats et tarifs négociés avec les transporteurs
 * Support des grilles tarifaires personnalisées par client
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// ============================================
// CARRIER CONTRACT TYPES
// ============================================

const CONTRACT_TYPES = {
    STANDARD: {
        id: 'standard',
        name: 'Tarifs publics',
        description: 'Grille tarifaire standard du transporteur',
        discount: 0
    },
    VOLUME: {
        id: 'volume',
        name: 'Contrat volume',
        description: 'Remises basées sur le volume mensuel',
        requiresCommitment: true
    },
    NEGOTIATED: {
        id: 'negotiated',
        name: 'Tarifs négociés',
        description: 'Grille personnalisée négociée avec le transporteur',
        requiresContract: true
    },
    ROUTZ_POOLED: {
        id: 'routz_pooled',
        name: 'Tarifs mutualisés Routz',
        description: 'Tarifs négociés par Routz pour tous les clients',
        discount: 15 // 15% de réduction moyenne
    },
    ENTERPRISE: {
        id: 'enterprise',
        name: 'Enterprise',
        description: 'Contrat entreprise sur mesure',
        requiresContract: true,
        requiresApproval: true
    }
};

// ============================================
// CARRIER RATE STRUCTURES
// ============================================

const CARRIER_RATE_STRUCTURES = {
    colissimo: {
        name: 'Colissimo',
        rateType: 'weight_bracket',
        zones: ['FR_METRO', 'FR_CORSE', 'FR_DOM', 'EU', 'WORLD'],
        services: ['home', 'signature', 'pickup', 'international'],
        surcharges: ['fuel', 'residential', 'remote_area', 'oversize'],
        volumeThresholds: [100, 500, 1000, 5000, 10000],
        standardRates: {
            FR_METRO: {
                home: [
                    { maxWeight: 0.25, price: 4.95 },
                    { maxWeight: 0.5, price: 6.20 },
                    { maxWeight: 0.75, price: 7.05 },
                    { maxWeight: 1, price: 7.70 },
                    { maxWeight: 2, price: 8.70 },
                    { maxWeight: 5, price: 10.15 },
                    { maxWeight: 10, price: 14.35 },
                    { maxWeight: 15, price: 17.10 },
                    { maxWeight: 30, price: 21.35 }
                ],
                pickup: [
                    { maxWeight: 0.25, price: 3.99 },
                    { maxWeight: 0.5, price: 4.99 },
                    { maxWeight: 1, price: 5.70 },
                    { maxWeight: 2, price: 6.50 },
                    { maxWeight: 5, price: 7.70 },
                    { maxWeight: 10, price: 10.20 },
                    { maxWeight: 20, price: 15.35 }
                ]
            },
            EU: {
                international: [
                    { maxWeight: 0.5, price: 12.65 },
                    { maxWeight: 1, price: 14.30 },
                    { maxWeight: 2, price: 16.50 },
                    { maxWeight: 5, price: 22.50 },
                    { maxWeight: 10, price: 32.00 },
                    { maxWeight: 20, price: 45.00 },
                    { maxWeight: 30, price: 55.00 }
                ]
            }
        }
    },
    
    chronopost: {
        name: 'Chronopost',
        rateType: 'weight_bracket',
        zones: ['FR_METRO', 'EU', 'WORLD'],
        services: ['13h', '18h', 'relais', 'classic_intl', 'express_intl'],
        surcharges: ['fuel', 'peak_season', 'saturday', 'before_9h'],
        volumeThresholds: [50, 200, 500, 2000, 5000],
        standardRates: {
            FR_METRO: {
                '13h': [
                    { maxWeight: 0.5, price: 13.90 },
                    { maxWeight: 1, price: 15.50 },
                    { maxWeight: 2, price: 17.50 },
                    { maxWeight: 5, price: 21.50 },
                    { maxWeight: 10, price: 28.50 },
                    { maxWeight: 20, price: 38.50 },
                    { maxWeight: 30, price: 48.50 }
                ],
                '18h': [
                    { maxWeight: 0.5, price: 11.90 },
                    { maxWeight: 1, price: 13.50 },
                    { maxWeight: 2, price: 15.50 },
                    { maxWeight: 5, price: 18.90 },
                    { maxWeight: 10, price: 24.90 },
                    { maxWeight: 20, price: 34.50 },
                    { maxWeight: 30, price: 42.50 }
                ],
                relais: [
                    { maxWeight: 0.5, price: 5.90 },
                    { maxWeight: 1, price: 6.90 },
                    { maxWeight: 2, price: 7.90 },
                    { maxWeight: 5, price: 9.90 },
                    { maxWeight: 10, price: 13.90 },
                    { maxWeight: 20, price: 18.90 }
                ]
            }
        }
    },
    
    mondial_relay: {
        name: 'Mondial Relay',
        rateType: 'weight_bracket',
        zones: ['FR', 'BE_LU', 'ES_PT', 'DE_AT', 'NL', 'IT'],
        services: ['standard', 'home', 'locker'],
        surcharges: ['fuel', 'island'],
        volumeThresholds: [200, 1000, 5000, 20000, 50000],
        standardRates: {
            FR: {
                standard: [
                    { maxWeight: 0.5, price: 3.40 },
                    { maxWeight: 1, price: 4.30 },
                    { maxWeight: 2, price: 4.90 },
                    { maxWeight: 3, price: 5.50 },
                    { maxWeight: 5, price: 6.40 },
                    { maxWeight: 7, price: 7.30 },
                    { maxWeight: 10, price: 8.40 },
                    { maxWeight: 15, price: 10.90 },
                    { maxWeight: 20, price: 12.90 },
                    { maxWeight: 30, price: 15.90 }
                ],
                home: [
                    { maxWeight: 0.5, price: 5.90 },
                    { maxWeight: 1, price: 6.90 },
                    { maxWeight: 2, price: 7.90 },
                    { maxWeight: 5, price: 9.90 },
                    { maxWeight: 10, price: 12.90 },
                    { maxWeight: 20, price: 17.90 },
                    { maxWeight: 30, price: 22.90 }
                ]
            },
            BE_LU: {
                standard: [
                    { maxWeight: 0.5, price: 4.90 },
                    { maxWeight: 1, price: 5.90 },
                    { maxWeight: 2, price: 6.90 },
                    { maxWeight: 5, price: 8.90 },
                    { maxWeight: 10, price: 11.90 },
                    { maxWeight: 20, price: 16.90 },
                    { maxWeight: 30, price: 21.90 }
                ]
            }
        }
    },
    
    dpd: {
        name: 'DPD',
        rateType: 'weight_bracket',
        zones: ['FR', 'EU_1', 'EU_2', 'WORLD'],
        services: ['classic', 'predict', 'relais', 'express'],
        surcharges: ['fuel', 'residential', 'cod'],
        volumeThresholds: [100, 500, 2000, 10000],
        standardRates: {
            FR: {
                classic: [
                    { maxWeight: 1, price: 6.50 },
                    { maxWeight: 3, price: 7.50 },
                    { maxWeight: 5, price: 8.50 },
                    { maxWeight: 10, price: 10.50 },
                    { maxWeight: 20, price: 14.50 },
                    { maxWeight: 31.5, price: 18.50 }
                ],
                predict: [
                    { maxWeight: 1, price: 7.50 },
                    { maxWeight: 3, price: 8.50 },
                    { maxWeight: 5, price: 9.50 },
                    { maxWeight: 10, price: 11.50 },
                    { maxWeight: 20, price: 15.50 },
                    { maxWeight: 31.5, price: 19.50 }
                ],
                relais: [
                    { maxWeight: 1, price: 4.90 },
                    { maxWeight: 3, price: 5.90 },
                    { maxWeight: 5, price: 6.90 },
                    { maxWeight: 10, price: 8.90 },
                    { maxWeight: 20, price: 12.90 }
                ]
            }
        }
    },
    
    gls: {
        name: 'GLS',
        rateType: 'weight_bracket',
        zones: ['FR', 'EU', 'WORLD'],
        services: ['business', 'express', 'shop'],
        surcharges: ['fuel', 'flex_delivery', 'guaranteed'],
        volumeThresholds: [100, 500, 2000, 5000],
        standardRates: {
            FR: {
                business: [
                    { maxWeight: 1, price: 5.90 },
                    { maxWeight: 2, price: 6.50 },
                    { maxWeight: 5, price: 7.90 },
                    { maxWeight: 10, price: 10.90 },
                    { maxWeight: 20, price: 14.90 },
                    { maxWeight: 31.5, price: 19.90 },
                    { maxWeight: 40, price: 24.90 }
                ],
                shop: [
                    { maxWeight: 1, price: 4.50 },
                    { maxWeight: 3, price: 5.50 },
                    { maxWeight: 5, price: 6.50 },
                    { maxWeight: 10, price: 8.50 },
                    { maxWeight: 20, price: 12.50 }
                ]
            }
        }
    },
    
    ups: {
        name: 'UPS',
        rateType: 'weight_zone',
        zones: ['FR', 'EU_1', 'EU_2', 'US_CA', 'WORLD'],
        services: ['standard', 'express', 'express_plus', 'access_point'],
        surcharges: ['fuel', 'residential', 'delivery_area', 'large_package', 'additional_handling'],
        volumeThresholds: [50, 200, 1000, 5000],
        fuelSurchargePercent: 24.75
    },
    
    fedex: {
        name: 'FedEx',
        rateType: 'weight_zone',
        zones: ['FR', 'EU', 'US', 'WORLD'],
        services: ['economy', 'priority', 'first', 'ground'],
        surcharges: ['fuel', 'residential', 'delivery_area', 'signature'],
        volumeThresholds: [50, 200, 1000, 5000],
        fuelSurchargePercent: 23.50
    },
    
    dhl: {
        name: 'DHL',
        rateType: 'weight_zone',
        zones: ['FR', 'EU', 'WORLD_1', 'WORLD_2', 'WORLD_3'],
        services: ['parcel', 'express', 'express_worldwide', 'economy_select'],
        surcharges: ['fuel', 'remote_area', 'overweight', 'non_stackable'],
        volumeThresholds: [100, 500, 2000, 10000],
        fuelSurchargePercent: 26.00
    }
};

// ============================================
// NEGOTIATED RATES SERVICE
// ============================================

class NegotiatedRatesService {
    constructor() {
        this.rateCache = new Map();
    }

    // ----------------------------------------
    // CONTRACT MANAGEMENT
    // ----------------------------------------

    /**
     * Create or update carrier contract
     */
    async createContract(params) {
        const {
            orgId,
            carrier,
            contractType,
            accountNumber,
            credentials,
            rates,
            discounts,
            surchargeOverrides,
            volumeCommitment,
            validFrom,
            validUntil,
            autoRenew
        } = params;

        // Validate carrier
        if (!CARRIER_RATE_STRUCTURES[carrier]) {
            throw new Error(`Unknown carrier: ${carrier}`);
        }

        // Encrypt credentials
        const encryptedCredentials = credentials 
            ? this.encryptCredentials(credentials) 
            : null;

        const contract = {
            id: uuidv4(),
            organization_id: orgId,
            carrier,
            contract_type: contractType,
            account_number: accountNumber,
            credentials_encrypted: encryptedCredentials?.encrypted,
            credentials_iv: encryptedCredentials?.iv,
            
            // Rate configuration
            custom_rates: rates ? JSON.stringify(rates) : null,
            discounts: discounts ? JSON.stringify(discounts) : null,
            surcharge_overrides: surchargeOverrides ? JSON.stringify(surchargeOverrides) : null,
            
            // Commitment
            volume_commitment: volumeCommitment,
            
            // Validity
            valid_from: validFrom || new Date(),
            valid_until: validUntil,
            auto_renew: autoRenew || false,
            
            // Status
            status: 'pending_validation',
            created_at: new Date()
        };

        await db.query(`
            INSERT INTO carrier_contracts (
                id, organization_id, carrier, contract_type, account_number,
                credentials_encrypted, credentials_iv, custom_rates, discounts,
                surcharge_overrides, volume_commitment, valid_from, valid_until,
                auto_renew, status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            ON CONFLICT (organization_id, carrier) DO UPDATE SET
                contract_type = EXCLUDED.contract_type,
                account_number = EXCLUDED.account_number,
                credentials_encrypted = EXCLUDED.credentials_encrypted,
                credentials_iv = EXCLUDED.credentials_iv,
                custom_rates = EXCLUDED.custom_rates,
                discounts = EXCLUDED.discounts,
                surcharge_overrides = EXCLUDED.surcharge_overrides,
                volume_commitment = EXCLUDED.volume_commitment,
                valid_from = EXCLUDED.valid_from,
                valid_until = EXCLUDED.valid_until,
                auto_renew = EXCLUDED.auto_renew,
                status = EXCLUDED.status,
                updated_at = NOW()
        `, [
            contract.id, contract.organization_id, contract.carrier,
            contract.contract_type, contract.account_number,
            contract.credentials_encrypted, contract.credentials_iv,
            contract.custom_rates, contract.discounts, contract.surcharge_overrides,
            contract.volume_commitment, contract.valid_from, contract.valid_until,
            contract.auto_renew, contract.status, contract.created_at
        ]);

        // Clear cache
        await this.clearRateCache(orgId, carrier);

        // Validate credentials if provided
        if (credentials) {
            await this.validateCarrierCredentials(contract.id, carrier, credentials);
        }

        return contract;
    }

    /**
     * Get organization's carrier contracts
     */
    async getContracts(orgId) {
        const result = await db.query(`
            SELECT 
                c.*,
                (SELECT COUNT(*) FROM shipments s 
                 WHERE s.organization_id = c.organization_id 
                 AND s.carrier = c.carrier 
                 AND DATE_TRUNC('month', s.created_at) = DATE_TRUNC('month', NOW())
                ) as current_month_volume
            FROM carrier_contracts c
            WHERE c.organization_id = $1
            ORDER BY c.carrier
        `, [orgId]);

        return result.rows.map(row => ({
            ...row,
            custom_rates: row.custom_rates ? JSON.parse(row.custom_rates) : null,
            discounts: row.discounts ? JSON.parse(row.discounts) : null,
            surcharge_overrides: row.surcharge_overrides ? JSON.parse(row.surcharge_overrides) : null,
            credentials_encrypted: undefined, // Don't expose
            credentials_iv: undefined
        }));
    }

    /**
     * Validate carrier credentials by making test API call
     */
    async validateCarrierCredentials(contractId, carrier, credentials) {
        try {
            // Carrier-specific validation
            let valid = false;
            let error = null;

            switch (carrier) {
                case 'colissimo':
                    valid = await this.validateColissimoCredentials(credentials);
                    break;
                case 'chronopost':
                    valid = await this.validateChronopostCredentials(credentials);
                    break;
                case 'mondial_relay':
                    valid = await this.validateMondialRelayCredentials(credentials);
                    break;
                case 'dpd':
                    valid = await this.validateDPDCredentials(credentials);
                    break;
                default:
                    // Generic validation - assume valid
                    valid = true;
            }

            // Update contract status
            await db.query(`
                UPDATE carrier_contracts 
                SET status = $1, validated_at = NOW(), validation_error = $2
                WHERE id = $3
            `, [valid ? 'active' : 'invalid_credentials', error, contractId]);

            return { valid, error };
        } catch (err) {
            await db.query(`
                UPDATE carrier_contracts 
                SET status = 'validation_failed', validation_error = $1
                WHERE id = $2
            `, [err.message, contractId]);

            return { valid: false, error: err.message };
        }
    }

    // ----------------------------------------
    // RATE CALCULATION
    // ----------------------------------------

    /**
     * Get rate for a shipment
     */
    async getRate(params) {
        const {
            orgId,
            carrier,
            service,
            zone,
            weight,
            dimensions,
            options = {}
        } = params;

        // Check cache
        const cacheKey = `rate:${orgId}:${carrier}:${service}:${zone}:${weight}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }

        // Get contract
        const contract = await this.getContract(orgId, carrier);
        
        // Calculate volumetric weight
        const volumetricWeight = dimensions 
            ? (dimensions.length * dimensions.width * dimensions.height) / 5000 
            : weight;
        const chargeableWeight = Math.max(weight, volumetricWeight);

        // Get base rate
        let baseRate;
        
        if (contract?.custom_rates) {
            // Use custom rates
            baseRate = this.lookupCustomRate(contract.custom_rates, service, zone, chargeableWeight);
        } else if (contract?.contract_type === 'routz_pooled') {
            // Use Routz pooled rates
            baseRate = await this.getRoutzPooledRate(carrier, service, zone, chargeableWeight);
        } else {
            // Use standard rates
            baseRate = this.lookupStandardRate(carrier, service, zone, chargeableWeight);
        }

        if (!baseRate) {
            return null; // Service not available
        }

        // Apply discounts
        let finalRate = baseRate;
        
        if (contract?.discounts) {
            finalRate = this.applyDiscounts(finalRate, contract.discounts, {
                weight: chargeableWeight,
                service,
                zone
            });
        }

        // Add surcharges
        const surcharges = this.calculateSurcharges(carrier, {
            weight: chargeableWeight,
            dimensions,
            zone,
            options,
            overrides: contract?.surcharge_overrides
        });

        const totalSurcharges = Object.values(surcharges).reduce((s, v) => s + v, 0);
        
        const rate = {
            carrier,
            service,
            zone,
            weight: chargeableWeight,
            baseRate: Math.round(baseRate * 100) / 100,
            discounts: contract?.discounts ? Math.round((baseRate - finalRate) * 100) / 100 : 0,
            surcharges,
            totalSurcharges: Math.round(totalSurcharges * 100) / 100,
            finalRate: Math.round((finalRate + totalSurcharges) * 100) / 100,
            contractType: contract?.contract_type || 'standard',
            currency: 'EUR'
        };

        // Cache
        await redis.setex(cacheKey, 300, JSON.stringify(rate));

        return rate;
    }

    /**
     * Get rates comparison across all carriers
     */
    async compareRates(params) {
        const {
            orgId,
            fromCountry,
            fromPostalCode,
            toCountry,
            toPostalCode,
            weight,
            dimensions,
            serviceType // 'express', 'standard', 'pickup'
        } = params;

        // Determine zone for each carrier
        const zone = this.determineZone(fromCountry, toCountry, toPostalCode);

        // Get all active contracts
        const contracts = await this.getContracts(orgId);
        const activeCarriers = contracts.filter(c => c.status === 'active').map(c => c.carrier);

        // Also include carriers without contracts (standard rates)
        const allCarriers = [...new Set([...activeCarriers, ...Object.keys(CARRIER_RATE_STRUCTURES)])];

        // Get rates for each carrier
        const ratesPromises = allCarriers.map(async carrier => {
            const carrierConfig = CARRIER_RATE_STRUCTURES[carrier];
            if (!carrierConfig) return null;

            // Get applicable services
            const services = this.getServicesByType(carrier, serviceType);
            
            const serviceRates = await Promise.all(
                services.map(service => this.getRate({
                    orgId,
                    carrier,
                    service,
                    zone: this.mapZone(carrier, zone),
                    weight,
                    dimensions
                }))
            );

            return {
                carrier,
                carrierName: carrierConfig.name,
                services: serviceRates.filter(r => r !== null)
            };
        });

        const results = await Promise.all(ratesPromises);
        
        // Filter and sort
        const validResults = results
            .filter(r => r && r.services.length > 0)
            .map(r => ({
                ...r,
                cheapest: r.services.reduce((min, s) => s.finalRate < min.finalRate ? s : min, r.services[0])
            }))
            .sort((a, b) => a.cheapest.finalRate - b.cheapest.finalRate);

        return {
            zone,
            weight,
            volumetricWeight: dimensions ? (dimensions.length * dimensions.width * dimensions.height) / 5000 : null,
            chargeableWeight: dimensions ? Math.max(weight, (dimensions.length * dimensions.width * dimensions.height) / 5000) : weight,
            carriers: validResults,
            recommendation: validResults[0] ? {
                carrier: validResults[0].carrier,
                service: validResults[0].cheapest.service,
                rate: validResults[0].cheapest.finalRate,
                savings: validResults.length > 1 
                    ? Math.round((validResults[1].cheapest.finalRate - validResults[0].cheapest.finalRate) * 100) / 100
                    : 0
            } : null
        };
    }

    /**
     * Get Routz pooled rates (negotiated for all platform users)
     */
    async getRoutzPooledRate(carrier, service, zone, weight) {
        // Routz negotiated rates - approximately 15-25% off standard
        const standardRate = this.lookupStandardRate(carrier, service, zone, weight);
        if (!standardRate) return null;

        const discountPercent = {
            colissimo: 18,
            chronopost: 15,
            mondial_relay: 20,
            dpd: 17,
            gls: 16,
            ups: 12,
            fedex: 12,
            dhl: 14
        }[carrier] || 15;

        return standardRate * (1 - discountPercent / 100);
    }

    // ----------------------------------------
    // RATE LOOKUPS
    // ----------------------------------------

    lookupStandardRate(carrier, service, zone, weight) {
        const carrierRates = CARRIER_RATE_STRUCTURES[carrier]?.standardRates;
        if (!carrierRates) return null;

        const zoneRates = carrierRates[zone];
        if (!zoneRates) return null;

        const serviceRates = zoneRates[service];
        if (!serviceRates) return null;

        const bracket = serviceRates.find(b => weight <= b.maxWeight);
        return bracket?.price || null;
    }

    lookupCustomRate(customRates, service, zone, weight) {
        const serviceRates = customRates[service];
        if (!serviceRates) return null;

        const zoneRates = serviceRates[zone] || serviceRates['default'];
        if (!zoneRates) return null;

        // Handle different rate structures
        if (Array.isArray(zoneRates)) {
            const bracket = zoneRates.find(b => weight <= b.maxWeight);
            return bracket?.price || null;
        }

        if (zoneRates.flatRate) {
            return zoneRates.flatRate;
        }

        if (zoneRates.perKg) {
            return (zoneRates.baseRate || 0) + (weight * zoneRates.perKg);
        }

        return null;
    }

    applyDiscounts(baseRate, discounts, context) {
        let rate = baseRate;

        // Percentage discount
        if (discounts.percentage) {
            rate *= (1 - discounts.percentage / 100);
        }

        // Fixed discount
        if (discounts.fixed) {
            rate = Math.max(0, rate - discounts.fixed);
        }

        // Volume-based discounts
        if (discounts.volumeTiers && context.monthlyVolume) {
            const tier = discounts.volumeTiers
                .sort((a, b) => b.minVolume - a.minVolume)
                .find(t => context.monthlyVolume >= t.minVolume);
            
            if (tier) {
                rate *= (1 - tier.discountPercent / 100);
            }
        }

        // Service-specific discounts
        if (discounts.services?.[context.service]) {
            rate *= (1 - discounts.services[context.service] / 100);
        }

        // Zone-specific discounts
        if (discounts.zones?.[context.zone]) {
            rate *= (1 - discounts.zones[context.zone] / 100);
        }

        return rate;
    }

    calculateSurcharges(carrier, params) {
        const { weight, dimensions, zone, options, overrides } = params;
        const surcharges = {};

        const carrierConfig = CARRIER_RATE_STRUCTURES[carrier];
        if (!carrierConfig) return surcharges;

        // Fuel surcharge
        if (carrierConfig.fuelSurchargePercent && !overrides?.fuel_exempt) {
            const fuelPercent = overrides?.fuel_percent || carrierConfig.fuelSurchargePercent;
            // Apply to estimated base rate
            surcharges.fuel = 0; // Would be calculated on final rate
        }

        // Residential surcharge
        if (options.residential && carrierConfig.surcharges?.includes('residential')) {
            surcharges.residential = overrides?.residential || 3.50;
        }

        // Remote area surcharge
        if (options.remoteArea && carrierConfig.surcharges?.includes('remote_area')) {
            surcharges.remote_area = overrides?.remote_area || 8.00;
        }

        // Oversize surcharge
        if (dimensions) {
            const maxDim = Math.max(dimensions.length, dimensions.width, dimensions.height);
            const girth = 2 * (dimensions.width + dimensions.height) + dimensions.length;
            
            if (maxDim > 120 || girth > 300) {
                surcharges.oversize = overrides?.oversize || 15.00;
            }
        }

        // Overweight surcharge
        if (weight > 30) {
            surcharges.overweight = overrides?.overweight || ((weight - 30) * 1.50);
        }

        // Saturday delivery
        if (options.saturday) {
            surcharges.saturday = overrides?.saturday || 12.00;
        }

        // COD (Cash on Delivery)
        if (options.cod) {
            surcharges.cod = overrides?.cod || 4.50;
        }

        // Insurance
        if (options.insuranceValue) {
            const insuredValue = options.insuranceValue;
            surcharges.insurance = Math.max(2.00, insuredValue * 0.015); // 1.5% of value, min €2
        }

        return surcharges;
    }

    // ----------------------------------------
    // VOLUME TRACKING
    // ----------------------------------------

    /**
     * Get volume statistics for a carrier
     */
    async getVolumeStats(orgId, carrier, period = 'month') {
        let dateFilter;
        switch (period) {
            case 'week':
                dateFilter = "created_at >= NOW() - INTERVAL '7 days'";
                break;
            case 'month':
                dateFilter = "DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())";
                break;
            case 'quarter':
                dateFilter = "DATE_TRUNC('quarter', created_at) = DATE_TRUNC('quarter', NOW())";
                break;
            case 'year':
                dateFilter = "DATE_TRUNC('year', created_at) = DATE_TRUNC('year', NOW())";
                break;
            default:
                dateFilter = "DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())";
        }

        const result = await db.query(`
            SELECT 
                COUNT(*) as shipment_count,
                SUM(weight) as total_weight,
                SUM(shipping_cost) as total_cost,
                AVG(shipping_cost) as avg_cost,
                COUNT(DISTINCT DATE(created_at)) as active_days
            FROM shipments
            WHERE organization_id = $1 
            AND carrier = $2
            AND ${dateFilter}
        `, [orgId, carrier]);

        const contract = await this.getContract(orgId, carrier);

        return {
            period,
            carrier,
            stats: result.rows[0],
            commitment: contract?.volume_commitment,
            progress: contract?.volume_commitment 
                ? (parseInt(result.rows[0].shipment_count) / contract.volume_commitment * 100).toFixed(1)
                : null,
            nextTier: this.getNextVolumeTier(carrier, parseInt(result.rows[0].shipment_count))
        };
    }

    getNextVolumeTier(carrier, currentVolume) {
        const thresholds = CARRIER_RATE_STRUCTURES[carrier]?.volumeThresholds || [];
        const nextThreshold = thresholds.find(t => t > currentVolume);
        
        if (!nextThreshold) return null;

        return {
            threshold: nextThreshold,
            remaining: nextThreshold - currentVolume,
            estimatedDiscount: this.estimateVolumeDiscount(carrier, nextThreshold)
        };
    }

    estimateVolumeDiscount(carrier, volume) {
        // Estimated discounts by volume tier
        const discountTiers = {
            100: 5,
            500: 10,
            1000: 15,
            5000: 20,
            10000: 25,
            50000: 30
        };

        const applicableTiers = Object.entries(discountTiers)
            .filter(([threshold]) => volume >= parseInt(threshold))
            .sort((a, b) => parseInt(b[0]) - parseInt(a[0]));

        return applicableTiers[0]?.[1] || 0;
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    async getContract(orgId, carrier) {
        const cacheKey = `contract:${orgId}:${carrier}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const result = await db.query(`
            SELECT * FROM carrier_contracts
            WHERE organization_id = $1 AND carrier = $2 AND status = 'active'
        `, [orgId, carrier]);

        const contract = result.rows[0];
        if (contract) {
            contract.custom_rates = contract.custom_rates ? JSON.parse(contract.custom_rates) : null;
            contract.discounts = contract.discounts ? JSON.parse(contract.discounts) : null;
            contract.surcharge_overrides = contract.surcharge_overrides ? JSON.parse(contract.surcharge_overrides) : null;
            
            await redis.setex(cacheKey, 3600, JSON.stringify(contract));
        }

        return contract;
    }

    async clearRateCache(orgId, carrier) {
        const pattern = `rate:${orgId}:${carrier}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
            await redis.del(...keys);
        }
        await redis.del(`contract:${orgId}:${carrier}`);
    }

    encryptCredentials(credentials) {
        const algorithm = 'aes-256-cbc';
        const key = Buffer.from(process.env.ENCRYPTION_KEY || crypto.randomBytes(32));
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return {
            encrypted: Buffer.from(encrypted, 'hex'),
            iv
        };
    }

    decryptCredentials(encrypted, iv) {
        const algorithm = 'aes-256-cbc';
        const key = Buffer.from(process.env.ENCRYPTION_KEY);
        
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return JSON.parse(decrypted);
    }

    determineZone(fromCountry, toCountry, toPostalCode) {
        if (fromCountry === toCountry) {
            if (fromCountry === 'FR') {
                const prefix = toPostalCode?.substring(0, 2);
                if (prefix === '20') return 'FR_CORSE';
                if (['97', '98'].includes(prefix)) return 'FR_DOM';
                return 'FR_METRO';
            }
            return fromCountry;
        }

        // International
        const eu = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
        
        if (eu.includes(toCountry)) return 'EU';
        if (['US', 'CA'].includes(toCountry)) return 'US_CA';
        if (['GB', 'CH', 'NO'].includes(toCountry)) return 'EUROPE_OTHER';
        
        return 'WORLD';
    }

    mapZone(carrier, genericZone) {
        // Map generic zones to carrier-specific zones
        const zoneMaps = {
            mondial_relay: {
                'FR_METRO': 'FR',
                'EU': 'BE_LU',
                'FR': 'FR'
            },
            dpd: {
                'FR_METRO': 'FR',
                'EU': 'EU_1'
            }
        };

        return zoneMaps[carrier]?.[genericZone] || genericZone;
    }

    getServicesByType(carrier, serviceType) {
        const carrierConfig = CARRIER_RATE_STRUCTURES[carrier];
        if (!carrierConfig) return [];

        const serviceMapping = {
            express: {
                chronopost: ['13h', '18h'],
                dpd: ['express'],
                gls: ['express'],
                ups: ['express', 'express_plus'],
                fedex: ['priority', 'first'],
                dhl: ['express', 'express_worldwide']
            },
            standard: {
                colissimo: ['home', 'signature'],
                chronopost: [],
                mondial_relay: ['home'],
                dpd: ['classic', 'predict'],
                gls: ['business'],
                ups: ['standard'],
                fedex: ['economy', 'ground'],
                dhl: ['parcel', 'economy_select']
            },
            pickup: {
                colissimo: ['pickup'],
                chronopost: ['relais'],
                mondial_relay: ['standard', 'locker'],
                dpd: ['relais'],
                gls: ['shop'],
                ups: ['access_point'],
                dhl: []
            }
        };

        return serviceMapping[serviceType]?.[carrier] || carrierConfig.services || [];
    }

    // Carrier credential validators
    async validateColissimoCredentials(credentials) {
        // Would make actual API call to Colissimo
        return credentials.accountNumber && credentials.password;
    }

    async validateChronopostCredentials(credentials) {
        return credentials.accountNumber && credentials.password;
    }

    async validateMondialRelayCredentials(credentials) {
        return credentials.enseigne && credentials.privateKey;
    }

    async validateDPDCredentials(credentials) {
        return credentials.customerId && credentials.apiKey;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    NegotiatedRatesService,
    CONTRACT_TYPES,
    CARRIER_RATE_STRUCTURES
};
