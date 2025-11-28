/**
 * Routz v4.0 - Carriers Connectors
 * Colissimo, Chronopost, Mondial Relay
 */

const axios = require('axios');
const crypto = require('crypto');

// ==========================================
// BASE CARRIER CLASS
// ==========================================

class BaseCarrier {
    constructor(config) {
        this.config = config;
        this.sandbox = config.sandbox !== false;
    }

    async request(method, url, data = null, headers = {}) {
        try {
            const response = await axios({
                method,
                url,
                data,
                headers: { 'Content-Type': 'application/json', ...headers },
                timeout: 30000
            });
            return response.data;
        } catch (error) {
            throw new Error(`Carrier API error: ${error.response?.data?.message || error.message}`);
        }
    }

    formatAddress(address) {
        return {
            name: address.name || '',
            company: address.company || '',
            line1: address.address1 || address.line1 || '',
            line2: address.address2 || address.line2 || '',
            city: address.city || '',
            postalCode: address.postalCode || address.postal_code || '',
            country: address.country || 'FR',
            phone: address.phone || '',
            email: address.email || ''
        };
    }
}

// ==========================================
// COLISSIMO
// ==========================================

class ColissimoConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = this.sandbox
            ? 'https://ws.colissimo.fr/sls-ws/SlsServiceWS/2.0'
            : 'https://ws.colissimo.fr/sls-ws/SlsServiceWS/2.0';
        this.trackingUrl = 'https://www.laposte.fr/outils/suivre-vos-envois';
    }

    getCredentials() {
        return {
            contractNumber: this.config.contractNumber,
            password: this.config.password
        };
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const productCode = this.getProductCode(options.service, recipient.country);
        
        const request = {
            contractNumber: this.config.contractNumber,
            password: this.config.password,
            outputFormat: {
                x: 0,
                y: 0,
                outputPrintingType: options.labelFormat || 'PDF_A4_300dpi'
            },
            letter: {
                service: {
                    productCode,
                    depositDate: new Date().toISOString().split('T')[0],
                    orderNumber: shipmentData.reference || '',
                    commercialName: sender.company || sender.name
                },
                parcel: {
                    weight: parcels[0].weight,
                    insuranceValue: options.insurance || 0
                },
                sender: {
                    address: {
                        companyName: sender.company || sender.name,
                        line2: sender.address1,
                        line3: sender.address2 || '',
                        city: sender.city,
                        zipCode: sender.postalCode,
                        countryCode: sender.country || 'FR',
                        phoneNumber: sender.phone,
                        email: sender.email
                    }
                },
                addressee: {
                    address: {
                        companyName: recipient.company || '',
                        lastName: recipient.name,
                        line2: recipient.address1,
                        line3: recipient.address2 || '',
                        city: recipient.city,
                        zipCode: recipient.postalCode,
                        countryCode: recipient.country || 'FR',
                        phoneNumber: recipient.phone,
                        email: recipient.email,
                        mobileNumber: recipient.phone
                    }
                }
            }
        };

        if (options.signature) {
            request.letter.service.productCode = 'DOS'; // Colissimo Expert avec signature
        }

        // Mock response for demo
        const trackingNumber = `6L${Math.random().toString().slice(2, 13)}FR`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'colissimo',
            service: productCode,
            estimatedDelivery: this.calculateEstimatedDelivery(recipient.country)
        };
    }

    getProductCode(service, country) {
        const codes = {
            standard: country === 'FR' ? 'DOM' : 'COM',
            expert: 'DOS',
            international: 'COLI',
            europe: 'COL'
        };
        return codes[service] || codes.standard;
    }

    async getTracking(trackingNumber) {
        // In production, call Colissimo tracking API
        return {
            trackingNumber,
            carrier: 'colissimo',
            status: 'in_transit',
            statusLabel: 'En cours de livraison',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Colis en cours d\'acheminement',
                    location: 'Centre de tri Paris'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        const isInternational = destination.country !== 'FR';
        
        const rates = [];
        
        // Colissimo Standard
        rates.push({
            carrier: 'colissimo',
            service: 'standard',
            serviceName: 'Colissimo Domicile',
            price: this.calculatePrice(weight, isInternational, 'standard'),
            currency: 'EUR',
            estimatedDays: isInternational ? 5 : 2,
            features: ['Suivi en ligne', 'Livraison à domicile']
        });

        // Colissimo Expert (signature)
        rates.push({
            carrier: 'colissimo',
            service: 'expert',
            serviceName: 'Colissimo Expert',
            price: this.calculatePrice(weight, isInternational, 'expert'),
            currency: 'EUR',
            estimatedDays: isInternational ? 5 : 2,
            features: ['Suivi en ligne', 'Signature obligatoire', 'Assurance incluse']
        });

        return rates;
    }

    calculatePrice(weight, isInternational, service) {
        const basePrices = {
            standard: { national: 4.95, international: 12.50 },
            expert: { national: 7.50, international: 15.00 }
        };
        
        const base = isInternational 
            ? basePrices[service].international 
            : basePrices[service].national;
        
        const weightSurcharge = Math.max(0, weight - 1) * 1.50;
        return Math.round((base + weightSurcharge) * 100) / 100;
    }

    calculateEstimatedDelivery(country) {
        const days = country === 'FR' ? 2 : 5;
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`PDF Label for ${trackingNumber}`).toString('base64');
    }

    async getPickupPoints(postalCode, country = 'FR') {
        // Return mock pickup points
        return [
            { id: 'BP001', name: 'Bureau de Poste Centre', address: '1 Place de la République', city: 'Paris', postalCode: '75001' },
            { id: 'BP002', name: 'Relais Colis Tabac', address: '15 Rue du Commerce', city: 'Paris', postalCode: '75001' }
        ];
    }
}

// ==========================================
// CHRONOPOST
// ==========================================

class ChronopostConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = this.sandbox
            ? 'https://ws.chronopost.fr/shipping-cxf/ShippingServiceWS'
            : 'https://ws.chronopost.fr/shipping-cxf/ShippingServiceWS';
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const productCode = this.getProductCode(options.service);
        const trackingNumber = `XY${Math.random().toString().slice(2, 13)}FR`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'chronopost',
            service: productCode,
            estimatedDelivery: this.calculateEstimatedDelivery(options.service)
        };
    }

    getProductCode(service) {
        const codes = {
            'chrono13': '01',
            'chrono18': '02',
            'chronoClassic': '44',
            'chronoExpress': '17',
            'chronoRelais': '86'
        };
        return codes[service] || '01';
    }

    async getTracking(trackingNumber) {
        return {
            trackingNumber,
            carrier: 'chronopost',
            status: 'in_transit',
            statusLabel: 'En cours de livraison',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Colis pris en charge',
                    location: 'Hub Chronopost'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'chronopost',
                service: 'chrono13',
                serviceName: 'Chrono 13',
                price: 9.90 + Math.max(0, weight - 1) * 2,
                currency: 'EUR',
                estimatedDays: 1,
                features: ['Livraison avant 13h', 'Suivi temps réel']
            },
            {
                carrier: 'chronopost',
                service: 'chrono18',
                serviceName: 'Chrono 18',
                price: 7.90 + Math.max(0, weight - 1) * 1.5,
                currency: 'EUR',
                estimatedDays: 1,
                features: ['Livraison avant 18h', 'Suivi temps réel']
            },
            {
                carrier: 'chronopost',
                service: 'chronoRelais',
                serviceName: 'Chrono Relais',
                price: 5.90 + Math.max(0, weight - 1) * 1,
                currency: 'EUR',
                estimatedDays: 2,
                features: ['Livraison en point relais', 'Économique']
            }
        ];
    }

    calculateEstimatedDelivery(service) {
        const days = service === 'chronoRelais' ? 2 : 1;
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`PDF Label for ${trackingNumber}`).toString('base64');
    }

    async getPickupPoints(postalCode, country = 'FR') {
        return [
            { id: 'CHR001', name: 'Chronopost Relais Centre', address: '10 Rue de la Gare', city: 'Lyon', postalCode: '69001' },
            { id: 'CHR002', name: 'Chronopost Pickup Store', address: '25 Avenue Jean Jaurès', city: 'Lyon', postalCode: '69001' }
        ];
    }
}

// ==========================================
// MONDIAL RELAY
// ==========================================

class MondialRelayConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.mondialrelay.com/Web_Services.asmx';
        this.brandId = config.brandId;
        this.privateKey = config.privateKey;
    }

    generateSignature(params) {
        const concat = Object.values(params).join('') + this.privateKey;
        return crypto.createHash('md5').update(concat).digest('hex').toUpperCase();
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const trackingNumber = `MR${Math.random().toString().slice(2, 13)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'mondial_relay',
            service: options.service || 'standard',
            pickupPointId: options.pickupPointId,
            estimatedDelivery: this.calculateEstimatedDelivery()
        };
    }

    async getTracking(trackingNumber) {
        return {
            trackingNumber,
            carrier: 'mondial_relay',
            status: 'in_transit',
            statusLabel: 'En cours de livraison',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Colis en transit vers le point relais',
                    location: 'Hub Mondial Relay'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'mondial_relay',
                service: 'standard',
                serviceName: 'Point Relais',
                price: 3.50 + Math.max(0, weight - 1) * 0.80,
                currency: 'EUR',
                estimatedDays: 4,
                features: ['Économique', 'Livraison en point relais', '14 jours pour récupérer']
            },
            {
                carrier: 'mondial_relay',
                service: 'xl',
                serviceName: 'Point Relais XL',
                price: 5.50 + Math.max(0, weight - 3) * 1.00,
                currency: 'EUR',
                estimatedDays: 4,
                features: ['Colis volumineux', 'Jusqu\'à 30kg']
            }
        ];
    }

    async getPickupPoints(postalCode, country = 'FR', maxResults = 10) {
        // In production, call Mondial Relay API
        const mockPoints = [
            { id: 'MR001', name: 'Tabac Presse Le Central', address: '5 Place du Marché', city: 'Bordeaux', postalCode: '33000', hours: '9h-19h', distance: '0.2 km' },
            { id: 'MR002', name: 'Carrefour City', address: '12 Cours de l\'Intendance', city: 'Bordeaux', postalCode: '33000', hours: '8h-21h', distance: '0.4 km' },
            { id: 'MR003', name: 'Pressing Sainte-Catherine', address: '45 Rue Sainte-Catherine', city: 'Bordeaux', postalCode: '33000', hours: '9h-18h', distance: '0.6 km' },
            { id: 'MR004', name: 'Pharmacie des Quais', address: '8 Quai des Chartrons', city: 'Bordeaux', postalCode: '33000', hours: '9h-20h', distance: '0.8 km' },
            { id: 'MR005', name: 'Relais Colis Express', address: '22 Rue du Palais Gallien', city: 'Bordeaux', postalCode: '33000', hours: '10h-19h', distance: '1.0 km' }
        ];
        
        return mockPoints.slice(0, maxResults);
    }

    calculateEstimatedDelivery() {
        const date = new Date();
        date.setDate(date.getDate() + 4);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`PDF Label for ${trackingNumber}`).toString('base64');
    }
}

// ==========================================
// COLIS PRIVÉ
// ==========================================

class ColisPriveConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.colisprive.com/v1';
    }

    async createShipment(shipmentData) {
        const trackingNumber = `CP${Math.random().toString().slice(2, 13)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${Buffer.from('Label').toString('base64')}`,
            carrier: 'colis_prive',
            estimatedDelivery: this.calculateEstimatedDelivery()
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'colis_prive',
                service: 'standard',
                serviceName: 'Colis Privé Standard',
                price: 4.20 + Math.max(0, weight - 1) * 0.90,
                currency: 'EUR',
                estimatedDays: 3,
                features: ['Livraison à domicile', 'Suivi en ligne']
            }
        ];
    }

    calculateEstimatedDelivery() {
        const date = new Date();
        date.setDate(date.getDate() + 3);
        return date.toISOString().split('T')[0];
    }
}

// ==========================================
// CARRIER SERVICE
// ==========================================

class CarrierService {
    constructor(config = {}) {
        this.connectors = {};
        this.config = config;
    }

    registerCarrier(carrierId, connector) {
        this.connectors[carrierId] = connector;
    }

    getCarrier(carrierId) {
        return this.connectors[carrierId];
    }

    async createShipment(carrierId, shipmentData) {
        const carrier = this.getCarrier(carrierId);
        if (!carrier) throw new Error(`Carrier ${carrierId} not configured`);
        return carrier.createShipment(shipmentData);
    }

    async getTracking(carrierId, trackingNumber) {
        const carrier = this.getCarrier(carrierId);
        if (!carrier) throw new Error(`Carrier ${carrierId} not configured`);
        return carrier.getTracking(trackingNumber);
    }

    async getAllRates(origin, destination, parcels) {
        const allRates = [];
        
        for (const [carrierId, connector] of Object.entries(this.connectors)) {
            try {
                const rates = await connector.getRates(origin, destination, parcels);
                allRates.push(...rates);
            } catch (error) {
                console.error(`Error getting rates from ${carrierId}:`, error.message);
            }
        }
        
        return allRates.sort((a, b) => a.price - b.price);
    }

    async getPickupPoints(carrierId, postalCode, country = 'FR') {
        const carrier = this.getCarrier(carrierId);
        if (!carrier || !carrier.getPickupPoints) {
            throw new Error(`Carrier ${carrierId} does not support pickup points`);
        }
        return carrier.getPickupPoints(postalCode, country);
    }
}

module.exports = {
    BaseCarrier,
    ColissimoConnector,
    ChronopostConnector,
    MondialRelayConnector,
    ColisPriveConnector,
    CarrierService
};
