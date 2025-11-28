/**
 * ROUTZ - Tracking & Returns API Routes
 * Routes pour les pages de tracking brandées et le portail de retours
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { BrandedTrackingService, TrackingWebhookHandler } = require('./services/branded-tracking');
const { ReturnsPortalService } = require('./services/returns-portal');

// Initialize services
const trackingService = new BrandedTrackingService();
const returnsService = new ReturnsPortalService();
const webhookHandler = new TrackingWebhookHandler(trackingService);

// Multer config for photo uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images allowed'), false);
        }
    }
});

// ============================================
// TRACKING PAGE ROUTES
// ============================================

/**
 * GET /t/:trackingNumber
 * Public tracking page
 */
router.get('/t/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const lang = req.query.lang || req.acceptsLanguages(['fr', 'en', 'de', 'es', 'it', 'nl']) || 'fr';
        
        const html = await trackingService.generateTrackingPage(trackingNumber, { lang });
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'public, max-age=60'); // Cache for 1 minute
        res.send(html);
    } catch (error) {
        console.error('Error generating tracking page:', error);
        res.status(500).send('Error loading tracking page');
    }
});

/**
 * GET /api/tracking/:trackingNumber
 * Get tracking data as JSON
 */
router.get('/api/tracking/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const shipment = await trackingService.getShipmentByTracking(trackingNumber);
        
        if (!shipment) {
            return res.status(404).json({ error: 'Tracking not found' });
        }
        
        const brand = await trackingService.getBrandConfig(shipment.organization_id);
        
        res.json({
            shipment: {
                trackingNumber: shipment.tracking_number,
                status: shipment.status,
                carrier: shipment.carrier,
                estimatedDelivery: shipment.estimated_delivery,
                events: shipment.tracking_events || []
            },
            brand: {
                name: brand.name,
                logo_url: brand.logo_url,
                primary_color: brand.primary_color
            }
        });
    } catch (error) {
        console.error('Error fetching tracking:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tracking/widget/:trackingNumber
 * Get embeddable tracking widget HTML
 */
router.get('/api/tracking/widget/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const compact = req.query.compact === 'true';
        const lang = req.query.lang || 'fr';
        
        const widget = await trackingService.generateTrackingWidget(trackingNumber, { compact, lang });
        
        if (!widget) {
            return res.status(404).json({ error: 'Tracking not found' });
        }
        
        res.setHeader('Content-Type', 'text/html');
        res.send(widget);
    } catch (error) {
        console.error('Error generating widget:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// BRAND CONFIGURATION ROUTES (Admin)
// ============================================

/**
 * GET /api/admin/brand
 * Get brand configuration (requires auth)
 */
router.get('/api/admin/brand', requireAuth, async (req, res) => {
    try {
        const brand = await trackingService.getBrandConfig(req.orgId);
        res.json(brand);
    } catch (error) {
        console.error('Error fetching brand config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PUT /api/admin/brand
 * Update brand configuration (requires auth)
 */
router.put('/api/admin/brand', requireAuth, async (req, res) => {
    try {
        const brand = await trackingService.saveBrandConfig(req.orgId, req.body);
        res.json(brand);
    } catch (error) {
        console.error('Error saving brand config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/admin/brand/preview
 * Preview tracking email
 */
router.post('/api/admin/brand/preview', requireAuth, async (req, res) => {
    try {
        const { type = 'in_transit' } = req.body;
        
        // Generate preview with mock data
        const mockShipment = {
            id: 'preview-123',
            tracking_number: 'PREVIEW123456FR',
            status: type,
            carrier: 'colissimo',
            recipient_name: 'Jean Dupont',
            recipient_address1: '123 Rue de Paris',
            recipient_city: 'Paris',
            recipient_postal_code: '75001',
            recipient_country: 'FR',
            recipient_email: 'preview@example.com',
            estimated_delivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            organization_id: req.orgId
        };
        
        const html = await trackingService.generateTrackingPage(mockShipment.tracking_number, {
            preview: true,
            mockShipment
        });
        
        res.json({ html });
    } catch (error) {
        console.error('Error generating preview:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// RETURNS PORTAL ROUTES
// ============================================

/**
 * GET /returns/:orgId
 * Public returns portal page
 */
router.get('/returns/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;
        const lang = req.query.lang || req.acceptsLanguages(['fr', 'en', 'de', 'es']) || 'fr';
        const orderNumber = req.query.order || '';
        
        const portalConfig = await returnsService.getPortalConfig(orgId);
        
        if (!portalConfig.enabled) {
            return res.status(404).send('Returns portal not available');
        }
        
        const brand = await trackingService.getBrandConfig(orgId);
        const reasons = returnsService.getReturnReasons(lang);
        const t = returnsService.getTranslations(lang);
        
        // Render portal template
        const Handlebars = require('handlebars');
        const fs = require('fs').promises;
        const templatePath = path.join(__dirname, 'templates', 'returns-portal.hbs');
        const templateSource = await fs.readFile(templatePath, 'utf-8');
        
        // Register JSON helper
        Handlebars.registerHelper('json', (obj) => JSON.stringify(obj));
        
        const template = Handlebars.compile(templateSource);
        const html = template({
            orgId,
            lang,
            brand,
            portalConfig,
            reasons,
            t,
            apiUrl: process.env.BASE_URL || '',
            prefillOrder: orderNumber
        });
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('Error rendering returns portal:', error);
        res.status(500).send('Error loading returns portal');
    }
});

/**
 * POST /api/returns/find-order
 * Find order for return
 */
router.post('/api/returns/find-order', async (req, res) => {
    try {
        const { orgId, orderNumber, email, postalCode } = req.body;
        
        if (!orgId || !orderNumber || (!email && !postalCode)) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const order = await returnsService.findOrder(orgId, { orderNumber, email, postalCode });
        
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json(order);
    } catch (error) {
        console.error('Error finding order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/returns/create
 * Create return request
 */
router.post('/api/returns/create', async (req, res) => {
    try {
        const returnRequest = await returnsService.createReturnRequest(req.body.orgId, req.body);
        res.status(201).json(returnRequest);
    } catch (error) {
        console.error('Error creating return:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

/**
 * GET /api/returns/track/:rmaId
 * Track return status
 */
router.get('/api/returns/track/:rmaId', async (req, res) => {
    try {
        const { rmaId } = req.params;
        const returnData = await returnsService.trackReturn(rmaId);
        
        if (!returnData) {
            return res.status(404).json({ error: 'Return not found' });
        }
        
        res.json(returnData);
    } catch (error) {
        console.error('Error tracking return:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/returns/upload-photos
 * Upload return photos
 */
router.post('/api/returns/upload-photos', upload.array('photos', 5), async (req, res) => {
    try {
        const photos = req.files.map(file => {
            // In production, upload to S3/CloudFlare and return URLs
            const base64 = file.buffer.toString('base64');
            return `data:${file.mimetype};base64,${base64}`;
        });
        
        res.json({ photos });
    } catch (error) {
        console.error('Error uploading photos:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

/**
 * POST /api/returns/create-payment
 * Create payment intent for paid returns
 */
router.post('/api/returns/create-payment', async (req, res) => {
    try {
        const { returnId } = req.body;
        const paymentIntent = await returnsService.createPaymentIntent(returnId);
        res.json(paymentIntent);
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ error: error.message || 'Payment failed' });
    }
});

/**
 * POST /api/returns/confirm-payment
 * Confirm payment and generate label
 */
router.post('/api/returns/confirm-payment', async (req, res) => {
    try {
        const { returnId, paymentIntentId } = req.body;
        const result = await returnsService.confirmPayment(returnId, paymentIntentId);
        res.json(result);
    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({ error: error.message || 'Confirmation failed' });
    }
});

// ============================================
// RETURNS ADMIN ROUTES
// ============================================

/**
 * GET /api/admin/returns/config
 * Get returns portal configuration
 */
router.get('/api/admin/returns/config', requireAuth, async (req, res) => {
    try {
        const config = await returnsService.getPortalConfig(req.orgId);
        res.json(config);
    } catch (error) {
        console.error('Error fetching returns config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PUT /api/admin/returns/config
 * Update returns portal configuration
 */
router.put('/api/admin/returns/config', requireAuth, async (req, res) => {
    try {
        const config = await returnsService.savePortalConfig(req.orgId, req.body);
        res.json(config);
    } catch (error) {
        console.error('Error saving returns config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// WEBHOOKS
// ============================================

/**
 * POST /webhooks/carrier/:carrier
 * Receive carrier tracking updates
 */
router.post('/webhooks/carrier/:carrier', async (req, res) => {
    try {
        const { carrier } = req.params;
        const { tracking_number, status, event } = req.body;
        
        // Find shipment by tracking number
        const shipment = await trackingService.getShipmentByTracking(tracking_number);
        if (!shipment) {
            return res.status(404).json({ error: 'Shipment not found' });
        }
        
        // Map carrier status to internal status
        const mappedStatus = mapCarrierStatus(carrier, status);
        
        // Handle status update
        await webhookHandler.handleStatusUpdate(shipment.id, mappedStatus, {
            description: event?.description,
            location: event?.location
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ============================================
// HELPERS
// ============================================

function requireAuth(req, res, next) {
    // This would be replaced with actual auth middleware
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Extract org ID from token (simplified)
    req.orgId = req.headers['x-org-id'] || 'default-org';
    next();
}

function mapCarrierStatus(carrier, status) {
    // Map carrier-specific statuses to internal statuses
    const statusMaps = {
        colissimo: {
            'PRIS_EN_CHARGE': 'picked_up',
            'EN_COURS_ACHEMINEMENT': 'in_transit',
            'EN_COURS_LIVRAISON': 'out_for_delivery',
            'LIVRE': 'delivered',
            'ANOMALIE': 'exception'
        },
        chronopost: {
            'P': 'picked_up',
            'T': 'in_transit',
            'D': 'out_for_delivery',
            'L': 'delivered',
            'A': 'exception'
        }
        // Add more carrier mappings...
    };
    
    return statusMaps[carrier]?.[status] || status;
}

// ============================================
// EMBED SCRIPT (for external sites)
// ============================================

/**
 * GET /embed/tracking.js
 * Embeddable tracking widget script
 */
router.get('/embed/tracking.js', (req, res) => {
    const script = `
(function() {
    const ROUTZ_API = '${process.env.BASE_URL || ''}';
    
    window.RoutzTracking = {
        init: function(options) {
            this.options = options || {};
        },
        
        render: function(container, trackingNumber, options) {
            const el = typeof container === 'string' ? document.querySelector(container) : container;
            if (!el) return;
            
            const iframe = document.createElement('iframe');
            iframe.src = ROUTZ_API + '/t/' + trackingNumber + '?embed=true&lang=' + (options?.lang || 'fr');
            iframe.style.width = '100%';
            iframe.style.height = options?.height || '500px';
            iframe.style.border = 'none';
            iframe.style.borderRadius = '12px';
            
            el.innerHTML = '';
            el.appendChild(iframe);
        },
        
        widget: async function(container, trackingNumber, options) {
            const el = typeof container === 'string' ? document.querySelector(container) : container;
            if (!el) return;
            
            const response = await fetch(ROUTZ_API + '/api/tracking/widget/' + trackingNumber + '?compact=' + (options?.compact || false));
            el.innerHTML = await response.text();
        }
    };
})();
`;
    
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(script);
});

module.exports = router;
