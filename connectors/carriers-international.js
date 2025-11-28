/**
 * Routz v4.0 - International Carriers Connectors
 * DHL Express, UPS, FedEx, TNT, GLS, DPD
 */

const axios = require('axios');
const { BaseCarrier } = require('./carriers');

// ==========================================
// DHL EXPRESS
// ==========================================

class DHLExpressConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = this.sandbox
            ? 'https://express.api.dhl.com/mydhlapi/test'
            : 'https://express.api.dhl.com/mydhlapi';
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.accountNumber = config.accountNumber;
    }

    getAuthHeader() {
        const credentials = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
        return `Basic ${credentials}`;
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const trackingNumber = `JJD${Math.random().toString().slice(2, 12)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'dhl',
            service: options.service || 'express',
            estimatedDelivery: this.calculateEstimatedDelivery(recipient.country, options.service)
        };
    }

    async getTracking(trackingNumber) {
        return {
            trackingNumber,
            carrier: 'dhl',
            status: 'in_transit',
            statusLabel: 'Shipment in transit',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Shipment picked up',
                    location: 'DHL Service Point'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        const isInternational = origin.country !== destination.country;
        
        const rates = [
            {
                carrier: 'dhl',
                service: 'express',
                serviceName: 'DHL Express Worldwide',
                price: this.calculatePrice(weight, isInternational, 'express'),
                currency: 'EUR',
                estimatedDays: isInternational ? 3 : 1,
                features: ['Door-to-door', 'Real-time tracking', 'Insurance included']
            },
            {
                carrier: 'dhl',
                service: 'economy',
                serviceName: 'DHL Economy Select',
                price: this.calculatePrice(weight, isInternational, 'economy'),
                currency: 'EUR',
                estimatedDays: isInternational ? 6 : 3,
                features: ['Cost-effective', 'Tracking included']
            }
        ];

        return rates;
    }

    calculatePrice(weight, isInternational, service) {
        const basePrices = {
            express: { national: 12.00, international: 35.00 },
            economy: { national: 8.00, international: 18.00 }
        };
        
        const base = isInternational 
            ? basePrices[service].international 
            : basePrices[service].national;
        
        const weightSurcharge = Math.max(0, weight - 0.5) * 3.50;
        return Math.round((base + weightSurcharge) * 100) / 100;
    }

    calculateEstimatedDelivery(country, service) {
        const days = service === 'economy' ? 6 : (country === 'FR' ? 1 : 3);
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`DHL Label for ${trackingNumber}`).toString('base64');
    }

    async getServicePoints(postalCode, country) {
        return [
            { id: 'DHL001', name: 'DHL ServicePoint Paris', address: '10 Rue de Rivoli', city: 'Paris', postalCode: '75001' },
            { id: 'DHL002', name: 'DHL Express Center', address: '25 Avenue des Champs-Élysées', city: 'Paris', postalCode: '75008' }
        ];
    }
}

// ==========================================
// UPS
// ==========================================

class UPSConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = this.sandbox
            ? 'https://wwwcie.ups.com/api'
            : 'https://onlinetools.ups.com/api';
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.accountNumber = config.accountNumber;
        this.accessToken = null;
    }

    async authenticate() {
        // OAuth2 flow for UPS
        const response = await axios.post(
            `${this.baseUrl}/security/v1/oauth/token`,
            'grant_type=client_credentials',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`
                }
            }
        );
        this.accessToken = response.data.access_token;
        return this.accessToken;
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const trackingNumber = `1Z${Math.random().toString(36).substring(2, 18).toUpperCase()}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'ups',
            service: options.service || 'standard',
            estimatedDelivery: this.calculateEstimatedDelivery(recipient.country, options.service)
        };
    }

    async getTracking(trackingNumber) {
        return {
            trackingNumber,
            carrier: 'ups',
            status: 'in_transit',
            statusLabel: 'In Transit',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Package in transit to destination',
                    location: 'UPS Distribution Center'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        const isInternational = origin.country !== destination.country;
        
        return [
            {
                carrier: 'ups',
                service: 'express',
                serviceName: 'UPS Express',
                price: this.calculatePrice(weight, isInternational, 'express'),
                currency: 'EUR',
                estimatedDays: isInternational ? 2 : 1,
                features: ['Guaranteed delivery', 'Real-time tracking', 'Signature required']
            },
            {
                carrier: 'ups',
                service: 'standard',
                serviceName: 'UPS Standard',
                price: this.calculatePrice(weight, isInternational, 'standard'),
                currency: 'EUR',
                estimatedDays: isInternational ? 5 : 3,
                features: ['Cost-effective', 'Tracking included']
            },
            {
                carrier: 'ups',
                service: 'saver',
                serviceName: 'UPS Express Saver',
                price: this.calculatePrice(weight, isInternational, 'saver'),
                currency: 'EUR',
                estimatedDays: isInternational ? 3 : 2,
                features: ['End of day delivery', 'Tracking included']
            }
        ];
    }

    calculatePrice(weight, isInternational, service) {
        const basePrices = {
            express: { national: 15.00, international: 45.00 },
            standard: { national: 8.50, international: 22.00 },
            saver: { national: 11.00, international: 32.00 }
        };
        
        const base = isInternational 
            ? basePrices[service].international 
            : basePrices[service].national;
        
        const weightSurcharge = Math.max(0, weight - 0.5) * 4.00;
        return Math.round((base + weightSurcharge) * 100) / 100;
    }

    calculateEstimatedDelivery(country, service) {
        const daysMap = { express: 1, saver: 2, standard: 4 };
        const days = country === 'FR' ? daysMap[service] || 3 : (daysMap[service] || 3) + 2;
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`UPS Label for ${trackingNumber}`).toString('base64');
    }

    async getAccessPoints(postalCode, country) {
        return [
            { id: 'UPS001', name: 'UPS Access Point Relay', address: '5 Rue du Commerce', city: 'Lyon', postalCode: '69002' },
            { id: 'UPS002', name: 'UPS Store', address: '18 Place Bellecour', city: 'Lyon', postalCode: '69002' }
        ];
    }
}

// ==========================================
// FEDEX
// ==========================================

class FedExConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = this.sandbox
            ? 'https://apis-sandbox.fedex.com'
            : 'https://apis.fedex.com';
        this.apiKey = config.apiKey;
        this.secretKey = config.secretKey;
        this.accountNumber = config.accountNumber;
        this.accessToken = null;
    }

    async authenticate() {
        const response = await axios.post(
            `${this.baseUrl}/oauth/token`,
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.apiKey,
                client_secret: this.secretKey
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        this.accessToken = response.data.access_token;
        return this.accessToken;
    }

    async createShipment(shipmentData) {
        const { sender, recipient, parcels, options = {} } = shipmentData;
        
        const trackingNumber = `7${Math.random().toString().slice(2, 14)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            labelFormat: 'PDF',
            carrier: 'fedex',
            service: options.service || 'priority',
            estimatedDelivery: this.calculateEstimatedDelivery(recipient.country, options.service)
        };
    }

    async getTracking(trackingNumber) {
        return {
            trackingNumber,
            carrier: 'fedex',
            status: 'in_transit',
            statusLabel: 'In Transit',
            events: [
                {
                    timestamp: new Date().toISOString(),
                    status: 'in_transit',
                    description: 'Package at FedEx facility',
                    location: 'FedEx Hub Paris-CDG'
                }
            ]
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        const isInternational = origin.country !== destination.country;
        
        return [
            {
                carrier: 'fedex',
                service: 'priority',
                serviceName: 'FedEx International Priority',
                price: this.calculatePrice(weight, isInternational, 'priority'),
                currency: 'EUR',
                estimatedDays: isInternational ? 2 : 1,
                features: ['Time-definite delivery', 'Full tracking', 'Customs clearance']
            },
            {
                carrier: 'fedex',
                service: 'economy',
                serviceName: 'FedEx International Economy',
                price: this.calculatePrice(weight, isInternational, 'economy'),
                currency: 'EUR',
                estimatedDays: isInternational ? 5 : 3,
                features: ['Cost-effective', 'Tracking included']
            }
        ];
    }

    calculatePrice(weight, isInternational, service) {
        const basePrices = {
            priority: { national: 18.00, international: 50.00 },
            economy: { national: 10.00, international: 25.00 }
        };
        
        const base = isInternational 
            ? basePrices[service].international 
            : basePrices[service].national;
        
        const weightSurcharge = Math.max(0, weight - 0.5) * 5.00;
        return Math.round((base + weightSurcharge) * 100) / 100;
    }

    calculateEstimatedDelivery(country, service) {
        const days = service === 'economy' ? 5 : (country === 'FR' ? 1 : 2);
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`FedEx Label for ${trackingNumber}`).toString('base64');
    }
}

// ==========================================
// GLS
// ==========================================

class GLSConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.gls-group.eu/public/v1';
        this.customerId = config.customerId;
        this.contactId = config.contactId;
    }

    async createShipment(shipmentData) {
        const trackingNumber = `GLS${Math.random().toString().slice(2, 14)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            carrier: 'gls',
            estimatedDelivery: this.calculateEstimatedDelivery()
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'gls',
                service: 'standard',
                serviceName: 'GLS Business Parcel',
                price: 5.50 + Math.max(0, weight - 1) * 1.20,
                currency: 'EUR',
                estimatedDays: 3,
                features: ['European network', 'Tracking included']
            },
            {
                carrier: 'gls',
                service: 'express',
                serviceName: 'GLS Express',
                price: 9.50 + Math.max(0, weight - 1) * 2.00,
                currency: 'EUR',
                estimatedDays: 1,
                features: ['Next day delivery', 'Priority handling']
            }
        ];
    }

    calculateEstimatedDelivery() {
        const date = new Date();
        date.setDate(date.getDate() + 3);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`GLS Label for ${trackingNumber}`).toString('base64');
    }

    async getParcelShops(postalCode, country) {
        return [
            { id: 'GLS001', name: 'GLS ParcelShop', address: '8 Rue de la République', city: 'Marseille', postalCode: '13001' }
        ];
    }
}

// ==========================================
// DPD
// ==========================================

class DPDConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.dpd.com/shipping/v1';
        this.user = config.user;
        this.password = config.password;
        this.customerNumber = config.customerNumber;
    }

    async createShipment(shipmentData) {
        const trackingNumber = `DPD${Math.random().toString().slice(2, 14)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            carrier: 'dpd',
            estimatedDelivery: this.calculateEstimatedDelivery()
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'dpd',
                service: 'classic',
                serviceName: 'DPD Classic',
                price: 5.20 + Math.max(0, weight - 1) * 1.10,
                currency: 'EUR',
                estimatedDays: 3,
                features: ['European coverage', 'Predict notification']
            },
            {
                carrier: 'dpd',
                service: 'express',
                serviceName: 'DPD Express',
                price: 8.90 + Math.max(0, weight - 1) * 1.80,
                currency: 'EUR',
                estimatedDays: 1,
                features: ['Guaranteed next day', 'Time window delivery']
            }
        ];
    }

    calculateEstimatedDelivery() {
        const date = new Date();
        date.setDate(date.getDate() + 3);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`DPD Label for ${trackingNumber}`).toString('base64');
    }

    async getPickupShops(postalCode, country) {
        return [
            { id: 'DPD001', name: 'DPD Pickup Point', address: '15 Avenue Jean Médecin', city: 'Nice', postalCode: '06000' }
        ];
    }
}

// ==========================================
// TNT (now FedEx TNT)
// ==========================================

class TNTConnector extends BaseCarrier {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://express.tnt.com/expressconnect/2.0';
        this.username = config.username;
        this.password = config.password;
        this.accountNumber = config.accountNumber;
    }

    async createShipment(shipmentData) {
        const trackingNumber = `TNT${Math.random().toString().slice(2, 12)}`;
        
        return {
            success: true,
            trackingNumber,
            labelUrl: `data:application/pdf;base64,${this.generateMockLabel(trackingNumber)}`,
            carrier: 'tnt',
            estimatedDelivery: this.calculateEstimatedDelivery()
        };
    }

    async getRates(origin, destination, parcels) {
        const weight = parcels.reduce((sum, p) => sum + (p.weight || 0), 0);
        
        return [
            {
                carrier: 'tnt',
                service: 'express',
                serviceName: 'TNT Express',
                price: 14.00 + Math.max(0, weight - 0.5) * 3.50,
                currency: 'EUR',
                estimatedDays: 2,
                features: ['Express delivery', 'Full tracking']
            },
            {
                carrier: 'tnt',
                service: 'economy',
                serviceName: 'TNT Economy Express',
                price: 9.00 + Math.max(0, weight - 0.5) * 2.20,
                currency: 'EUR',
                estimatedDays: 4,
                features: ['Cost-effective', 'European coverage']
            }
        ];
    }

    calculateEstimatedDelivery() {
        const date = new Date();
        date.setDate(date.getDate() + 2);
        return date.toISOString().split('T')[0];
    }

    generateMockLabel(trackingNumber) {
        return Buffer.from(`TNT Label for ${trackingNumber}`).toString('base64');
    }
}

module.exports = {
    DHLExpressConnector,
    UPSConnector,
    FedExConnector,
    GLSConnector,
    DPDConnector,
    TNTConnector
};
