/**
 * Routz v4.0 - Test Suite
 * Tests unitaires et d'intégration avec Jest
 */

const request = require('supertest');

// Mock database
const mockDb = {
    query: jest.fn(),
    connect: jest.fn()
};

// Mock services
jest.mock('../services/carrier-selection-ai', () => ({
    CarrierSelectionAI: jest.fn().mockImplementation(() => ({
        recommendCarrier: jest.fn().mockResolvedValue({
            success: true,
            recommended: { carrier: { id: 'chronopost', name: 'Chronopost' }, score: 92 }
        })
    }))
}));

// ==========================================
// SHIPMENTS TESTS
// ==========================================

describe('Shipments API', () => {
    describe('POST /api/v1/shipments', () => {
        const validShipment = {
            carrier: 'colissimo',
            service: 'standard',
            sender: {
                name: 'Ma Boutique',
                address1: '10 rue du Commerce',
                city: 'Paris',
                postalCode: '75001',
                country: 'FR',
                phone: '+33123456789'
            },
            recipient: {
                name: 'Marie Dupont',
                address1: '25 avenue des Fleurs',
                city: 'Lyon',
                postalCode: '69001',
                country: 'FR',
                phone: '+33987654321',
                email: 'marie@email.com'
            },
            parcels: [{
                weight: 2.5,
                length: 30,
                width: 20,
                height: 15
            }]
        };

        it('should create a shipment with valid data', async () => {
            const response = await request(app)
                .post('/api/v1/shipments')
                .set('Authorization', 'Bearer test-token')
                .send(validShipment);

            expect(response.status).toBe(201);
            expect(response.body).toHaveProperty('id');
            expect(response.body).toHaveProperty('trackingNumber');
            expect(response.body.carrier).toBe('colissimo');
            expect(response.body.status).toBe('pending');
        });

        it('should reject shipment without carrier', async () => {
            const invalidShipment = { ...validShipment };
            delete invalidShipment.carrier;

            const response = await request(app)
                .post('/api/v1/shipments')
                .set('Authorization', 'Bearer test-token')
                .send(invalidShipment);

            expect(response.status).toBe(422);
            expect(response.body.errors).toContainEqual(
                expect.objectContaining({ field: 'carrier' })
            );
        });

        it('should reject shipment without recipient', async () => {
            const invalidShipment = { ...validShipment };
            delete invalidShipment.recipient;

            const response = await request(app)
                .post('/api/v1/shipments')
                .set('Authorization', 'Bearer test-token')
                .send(invalidShipment);

            expect(response.status).toBe(422);
        });

        it('should reject shipment with invalid postal code', async () => {
            const invalidShipment = {
                ...validShipment,
                recipient: { ...validShipment.recipient, postalCode: 'invalid' }
            };

            const response = await request(app)
                .post('/api/v1/shipments')
                .set('Authorization', 'Bearer test-token')
                .send(invalidShipment);

            expect(response.status).toBe(422);
        });

        it('should reject unauthorized request', async () => {
            const response = await request(app)
                .post('/api/v1/shipments')
                .send(validShipment);

            expect(response.status).toBe(401);
        });
    });

    describe('GET /api/v1/shipments', () => {
        it('should return paginated shipments', async () => {
            const response = await request(app)
                .get('/api/v1/shipments')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('data');
            expect(response.body).toHaveProperty('pagination');
            expect(Array.isArray(response.body.data)).toBe(true);
        });

        it('should filter by status', async () => {
            const response = await request(app)
                .get('/api/v1/shipments?status=delivered')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            response.body.data.forEach(shipment => {
                expect(shipment.status).toBe('delivered');
            });
        });

        it('should filter by carrier', async () => {
            const response = await request(app)
                .get('/api/v1/shipments?carrier=colissimo')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            response.body.data.forEach(shipment => {
                expect(shipment.carrier).toBe('colissimo');
            });
        });

        it('should respect pagination limits', async () => {
            const response = await request(app)
                .get('/api/v1/shipments?limit=5&page=1')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body.data.length).toBeLessThanOrEqual(5);
            expect(response.body.pagination.limit).toBe(5);
        });
    });

    describe('GET /api/v1/shipments/:id', () => {
        it('should return shipment details', async () => {
            const response = await request(app)
                .get('/api/v1/shipments/SHP-123')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('id');
            expect(response.body).toHaveProperty('trackingNumber');
        });

        it('should return 404 for non-existent shipment', async () => {
            const response = await request(app)
                .get('/api/v1/shipments/non-existent')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(404);
        });
    });

    describe('DELETE /api/v1/shipments/:id', () => {
        it('should cancel pending shipment', async () => {
            const response = await request(app)
                .delete('/api/v1/shipments/SHP-PENDING')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
        });

        it('should reject cancellation of shipped shipment', async () => {
            const response = await request(app)
                .delete('/api/v1/shipments/SHP-SHIPPED')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(400);
            expect(response.body.message).toContain('cannot be cancelled');
        });
    });
});

// ==========================================
// TRACKING TESTS
// ==========================================

describe('Tracking API', () => {
    describe('GET /api/v1/tracking/:trackingNumber', () => {
        it('should return tracking info', async () => {
            const response = await request(app)
                .get('/api/v1/tracking/6L123456789FR')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('trackingNumber');
            expect(response.body).toHaveProperty('status');
            expect(response.body).toHaveProperty('events');
            expect(Array.isArray(response.body.events)).toBe(true);
        });

        it('should return 404 for unknown tracking number', async () => {
            const response = await request(app)
                .get('/api/v1/tracking/UNKNOWN123')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(404);
        });
    });

    describe('POST /api/v1/tracking/batch', () => {
        it('should return multiple tracking infos', async () => {
            const response = await request(app)
                .post('/api/v1/tracking/batch')
                .set('Authorization', 'Bearer test-token')
                .send({
                    trackingNumbers: ['6L123456789FR', '6L987654321FR']
                });

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBe(2);
        });

        it('should reject more than 100 tracking numbers', async () => {
            const trackingNumbers = Array(101).fill('6L123456789FR');

            const response = await request(app)
                .post('/api/v1/tracking/batch')
                .set('Authorization', 'Bearer test-token')
                .send({ trackingNumbers });

            expect(response.status).toBe(422);
        });
    });
});

// ==========================================
// RETURNS TESTS
// ==========================================

describe('Returns API', () => {
    describe('POST /api/v1/returns', () => {
        const validReturn = {
            orderId: 'ORD-123',
            items: [{ sku: 'SKU-001', quantity: 1 }],
            reason: 'SIZE_TOO_LARGE',
            comments: 'La taille est trop grande'
        };

        it('should create a return request', async () => {
            const response = await request(app)
                .post('/api/v1/returns')
                .set('Authorization', 'Bearer test-token')
                .send(validReturn);

            expect(response.status).toBe(201);
            expect(response.body).toHaveProperty('id');
            expect(response.body.status).toBe('pending_approval');
        });

        it('should reject return for non-existent order', async () => {
            const response = await request(app)
                .post('/api/v1/returns')
                .set('Authorization', 'Bearer test-token')
                .send({ ...validReturn, orderId: 'NON-EXISTENT' });

            expect(response.status).toBe(404);
        });

        it('should reject invalid reason', async () => {
            const response = await request(app)
                .post('/api/v1/returns')
                .set('Authorization', 'Bearer test-token')
                .send({ ...validReturn, reason: 'INVALID_REASON' });

            expect(response.status).toBe(422);
        });
    });

    describe('POST /api/v1/returns/:id/approve', () => {
        it('should approve return and generate label', async () => {
            const response = await request(app)
                .post('/api/v1/returns/RMA-123/approve')
                .set('Authorization', 'Bearer test-token')
                .send({ generateLabel: true });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('trackingNumber');
            expect(response.body.status).toBe('approved');
        });
    });

    describe('POST /api/v1/returns/:id/refund', () => {
        it('should initiate refund', async () => {
            const response = await request(app)
                .post('/api/v1/returns/RMA-RECEIVED/refund')
                .set('Authorization', 'Bearer test-token')
                .send({
                    amount: 49.90,
                    method: 'original_payment'
                });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('refunded');
        });

        it('should reject refund for non-received return', async () => {
            const response = await request(app)
                .post('/api/v1/returns/RMA-PENDING/refund')
                .set('Authorization', 'Bearer test-token')
                .send({ amount: 49.90, method: 'original_payment' });

            expect(response.status).toBe(400);
        });
    });
});

// ==========================================
// CARRIERS TESTS
// ==========================================

describe('Carriers API', () => {
    describe('GET /api/v1/carriers', () => {
        it('should return list of carriers', async () => {
            const response = await request(app)
                .get('/api/v1/carriers')
                .set('Authorization', 'Bearer test-token');

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body[0]).toHaveProperty('id');
            expect(response.body[0]).toHaveProperty('name');
            expect(response.body[0]).toHaveProperty('services');
        });
    });

    describe('POST /api/v1/carriers/rates', () => {
        it('should return rates for valid request', async () => {
            const response = await request(app)
                .post('/api/v1/carriers/rates')
                .set('Authorization', 'Bearer test-token')
                .send({
                    origin: { postalCode: '75001', country: 'FR' },
                    destination: { postalCode: '69001', country: 'FR' },
                    parcels: [{ weight: 2.5 }]
                });

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            response.body.forEach(rate => {
                expect(rate).toHaveProperty('carrier');
                expect(rate).toHaveProperty('price');
                expect(rate.price).toBeGreaterThan(0);
            });
        });
    });

    describe('POST /api/v1/carriers/recommend', () => {
        it('should return AI recommendation', async () => {
            const response = await request(app)
                .post('/api/v1/carriers/recommend')
                .set('Authorization', 'Bearer test-token')
                .send({
                    origin: { postalCode: '75001', country: 'FR' },
                    destination: { postalCode: '69001', country: 'FR' },
                    parcels: [{ weight: 2.5 }],
                    priority: 'speed'
                });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('recommended');
            expect(response.body.recommended).toHaveProperty('carrier');
            expect(response.body.recommended).toHaveProperty('score');
            expect(response.body).toHaveProperty('alternatives');
        });
    });
});

// ==========================================
// QOS SERVICE TESTS
// ==========================================

describe('QoS Service', () => {
    const { QoSService } = require('../services/qos');
    let qosService;

    beforeEach(() => {
        qosService = new QoSService({ db: mockDb });
    });

    describe('analyzeCarrierPerformance', () => {
        it('should calculate carrier score correctly', () => {
            const score = qosService.calculateCarrierScore({
                deliveryRate: 95,
                onTimeRate: 90,
                exceptionRate: 2,
                avgDeliveryDays: 2.5
            });

            expect(score).toBeGreaterThan(0);
            expect(score).toBeLessThanOrEqual(100);
        });

        it('should return correct rating for score', () => {
            expect(qosService.getCarrierRating(95).rating).toBe('A+');
            expect(qosService.getCarrierRating(85).rating).toBe('A');
            expect(qosService.getCarrierRating(75).rating).toBe('B');
            expect(qosService.getCarrierRating(65).rating).toBe('C');
            expect(qosService.getCarrierRating(55).rating).toBe('D');
            expect(qosService.getCarrierRating(45).rating).toBe('F');
        });
    });

    describe('calculateDelayRisk', () => {
        it('should identify critical delays', () => {
            const risk = qosService.calculateDelayRisk({ delay_days: 6, hours_since_update: 100 });
            expect(risk).toBe('critical');
        });

        it('should identify high risk delays', () => {
            const risk = qosService.calculateDelayRisk({ delay_days: 4, hours_since_update: 75 });
            expect(risk).toBe('high');
        });

        it('should identify medium risk delays', () => {
            const risk = qosService.calculateDelayRisk({ delay_days: 2, hours_since_update: 50 });
            expect(risk).toBe('medium');
        });

        it('should identify low risk delays', () => {
            const risk = qosService.calculateDelayRisk({ delay_days: 0.5, hours_since_update: 12 });
            expect(risk).toBe('low');
        });
    });
});

// ==========================================
// CARRIER SELECTION AI TESTS
// ==========================================

describe('Carrier Selection AI', () => {
    const { CarrierSelectionAI } = require('../services/carrier-selection-ai');
    let aiService;

    beforeEach(() => {
        aiService = new CarrierSelectionAI({ db: mockDb });
    });

    describe('scorePricing', () => {
        it('should give high score for low price', () => {
            const score = aiService.scorePricing({ totalPrice: 5 }, 50);
            expect(score).toBeGreaterThan(80);
        });

        it('should give low score for high price', () => {
            const score = aiService.scorePricing({ totalPrice: 45 }, 50);
            expect(score).toBeLessThan(30);
        });

        it('should return 0 for price over budget', () => {
            const score = aiService.scorePricing({ totalPrice: 60 }, 50);
            expect(score).toBe(0);
        });
    });

    describe('scoreSpeed', () => {
        it('should give high score for fast delivery', () => {
            const score = aiService.scoreSpeed({}, 'express', { avgDeliveryDays: 1 });
            expect(score).toBe(100);
        });

        it('should give lower score for slow delivery', () => {
            const score = aiService.scoreSpeed({}, 'express', { avgDeliveryDays: 3 });
            expect(score).toBeLessThan(50);
        });
    });

    describe('scoreReliability', () => {
        it('should give high score for reliable carrier', () => {
            const score = aiService.scoreReliability({
                deliveryRate: 98,
                onTimeRate: 95,
                exceptionRate: 1
            });
            expect(score).toBeGreaterThan(90);
        });

        it('should give lower score for unreliable carrier', () => {
            const score = aiService.scoreReliability({
                deliveryRate: 80,
                onTimeRate: 70,
                exceptionRate: 10
            });
            expect(score).toBeLessThan(70);
        });
    });

    describe('adjustWeights', () => {
        it('should adjust weights for price priority', () => {
            const weights = aiService.adjustWeights('price');
            expect(weights.price).toBe(0.50);
            expect(weights.speed).toBe(0.15);
        });

        it('should adjust weights for speed priority', () => {
            const weights = aiService.adjustWeights('speed');
            expect(weights.speed).toBe(0.50);
            expect(weights.price).toBe(0.15);
        });

        it('should adjust weights for reliability priority', () => {
            const weights = aiService.adjustWeights('reliability');
            expect(weights.reliability).toBe(0.50);
        });
    });
});

// ==========================================
// INTERNATIONAL SERVICE TESTS
// ==========================================

describe('International Service', () => {
    const { InternationalService } = require('../services/international');
    let intlService;

    beforeEach(() => {
        intlService = new InternationalService({ db: mockDb });
    });

    describe('suggestHSCode', () => {
        it('should suggest correct HS code for t-shirt', async () => {
            const hsCode = await intlService.suggestHSCode('T-shirt en coton blanc');
            expect(hsCode).toBe('6109.10');
        });

        it('should suggest correct HS code for smartphone', async () => {
            const hsCode = await intlService.suggestHSCode('iPhone 15 Pro');
            expect(hsCode).toBe('8517.12');
        });

        it('should return default for unknown product', async () => {
            const hsCode = await intlService.suggestHSCode('Random unknown product');
            expect(hsCode).toBe('9999.99');
        });
    });

    describe('determineDeclarationType', () => {
        it('should identify intra-EU shipment', () => {
            const type = intlService.determineDeclarationType({
                sender: { country: 'FR' },
                recipient: { country: 'DE' }
            });
            expect(type).toBe('intra_eu');
        });

        it('should identify export shipment', () => {
            const type = intlService.determineDeclarationType({
                sender: { country: 'FR' },
                recipient: { country: 'US' }
            });
            expect(type).toBe('export');
        });

        it('should identify import shipment', () => {
            const type = intlService.determineDeclarationType({
                sender: { country: 'CN' },
                recipient: { country: 'FR' }
            });
            expect(type).toBe('import');
        });
    });

    describe('estimateDutiesAndTaxes', () => {
        it('should apply de minimis for low value shipments to US', async () => {
            const result = await intlService.estimateDutiesAndTaxes({
                destinationCountry: 'US',
                totalValue: 500,
                items: []
            });

            expect(result.deMinimisApplied).toBe(true);
            expect(result.duties).toBe(0);
            expect(result.taxes).toBe(0);
        });

        it('should calculate duties for high value shipments', async () => {
            const result = await intlService.estimateDutiesAndTaxes({
                destinationCountry: 'GB',
                totalValue: 500,
                items: [{ hsCode: '6109.10', totalValue: 500 }]
            });

            expect(result.deMinimisApplied).toBe(false);
            expect(result.duties).toBeGreaterThan(0);
            expect(result.taxes).toBeGreaterThan(0);
        });
    });
});

// ==========================================
// WEBHOOKS TESTS
// ==========================================

describe('Webhooks', () => {
    describe('Signature verification', () => {
        const crypto = require('crypto');

        it('should verify valid webhook signature', () => {
            const payload = JSON.stringify({ event: 'shipment.delivered' });
            const secret = 'webhook-secret';
            const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

            const isValid = verifyWebhookSignature(payload, signature, secret);
            expect(isValid).toBe(true);
        });

        it('should reject invalid webhook signature', () => {
            const payload = JSON.stringify({ event: 'shipment.delivered' });
            const isValid = verifyWebhookSignature(payload, 'invalid-signature', 'secret');
            expect(isValid).toBe(false);
        });
    });
});

// Helper function for webhook signature verification
function verifyWebhookSignature(payload, signature, secret) {
    const crypto = require('crypto');
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return signature === expectedSignature;
}

// ==========================================
// INTEGRATION TESTS
// ==========================================

describe('Integration Tests', () => {
    describe('Full shipment flow', () => {
        it('should complete order -> shipment -> tracking flow', async () => {
            // 1. Create order
            const orderResponse = await request(app)
                .post('/api/v1/orders')
                .set('Authorization', 'Bearer test-token')
                .send({
                    orderNumber: 'TEST-ORDER-001',
                    customer: { name: 'Test Customer', email: 'test@email.com' },
                    items: [{ sku: 'SKU-001', name: 'Test Product', quantity: 1, price: 29.90 }],
                    shippingAddress: {
                        name: 'Test Customer',
                        address1: '123 Test Street',
                        city: 'Paris',
                        postalCode: '75001',
                        country: 'FR'
                    }
                });

            expect(orderResponse.status).toBe(201);
            const orderId = orderResponse.body.id;

            // 2. Ship order
            const shipResponse = await request(app)
                .post(`/api/v1/orders/${orderId}/ship`)
                .set('Authorization', 'Bearer test-token')
                .send({ carrier: 'colissimo', service: 'standard' });

            expect(shipResponse.status).toBe(200);
            expect(shipResponse.body).toHaveProperty('trackingNumber');
            const trackingNumber = shipResponse.body.trackingNumber;

            // 3. Get tracking
            const trackingResponse = await request(app)
                .get(`/api/v1/tracking/${trackingNumber}`)
                .set('Authorization', 'Bearer test-token');

            expect(trackingResponse.status).toBe(200);
            expect(trackingResponse.body.trackingNumber).toBe(trackingNumber);
        });
    });

    describe('Full return flow', () => {
        it('should complete return -> approve -> refund flow', async () => {
            // 1. Create return
            const returnResponse = await request(app)
                .post('/api/v1/returns')
                .set('Authorization', 'Bearer test-token')
                .send({
                    orderId: 'ORD-DELIVERED',
                    items: [{ sku: 'SKU-001', quantity: 1 }],
                    reason: 'SIZE_TOO_LARGE'
                });

            expect(returnResponse.status).toBe(201);
            const returnId = returnResponse.body.id;

            // 2. Approve return
            const approveResponse = await request(app)
                .post(`/api/v1/returns/${returnId}/approve`)
                .set('Authorization', 'Bearer test-token')
                .send({ generateLabel: true });

            expect(approveResponse.status).toBe(200);
            expect(approveResponse.body.status).toBe('approved');

            // 3. Mark as received and refund (simulated)
            const refundResponse = await request(app)
                .post(`/api/v1/returns/${returnId}/refund`)
                .set('Authorization', 'Bearer test-token')
                .send({ amount: 29.90, method: 'original_payment' });

            expect(refundResponse.status).toBe(200);
            expect(refundResponse.body.status).toBe('refunded');
        });
    });
});

// Export for test runner
module.exports = { verifyWebhookSignature };
