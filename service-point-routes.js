/**
 * ROUTZ - Service Point Picker API Routes
 * Routes pour le widget de sélection de points relais
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const Handlebars = require('handlebars');
const fs = require('fs').promises;

const { 
    ServicePointPickerService, 
    WidgetConfigService,
    CARRIER_CONFIGS 
} = require('./services/service-point-picker');

// Initialize services
const servicePointService = new ServicePointPickerService();
const widgetConfigService = new WidgetConfigService();

// ============================================
// PUBLIC API ROUTES
// ============================================

/**
 * POST /api/service-points/search
 * Search for service points near a location
 */
router.post('/api/service-points/search', async (req, res) => {
    try {
        const {
            postalCode,
            city,
            country = 'FR',
            latitude,
            longitude,
            carriers,
            maxResults,
            maxDistance,
            weight,
            dimensions,
            features
        } = req.body;

        const points = await servicePointService.searchServicePoints({
            postalCode,
            city,
            country,
            latitude,
            longitude,
            carriers,
            maxResults,
            maxDistance,
            weight,
            dimensions,
            features
        });

        res.json({
            success: true,
            count: points.length,
            points
        });
    } catch (error) {
        console.error('Service point search error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Search failed' 
        });
    }
});

/**
 * GET /api/service-points/:carrier/:pointId
 * Get details for a specific service point
 */
router.get('/api/service-points/:carrier/:pointId', async (req, res) => {
    try {
        const { carrier, pointId } = req.params;
        
        const details = await servicePointService.getServicePointDetails(carrier, pointId);
        
        if (!details) {
            return res.status(404).json({ error: 'Service point not found' });
        }
        
        res.json(details);
    } catch (error) {
        console.error('Service point details error:', error);
        res.status(500).json({ error: error.message || 'Failed to get details' });
    }
});

/**
 * POST /api/service-points/validate
 * Validate that a service point is still available
 */
router.post('/api/service-points/validate', async (req, res) => {
    try {
        const { carrier, pointId } = req.body;
        
        if (!carrier || !pointId) {
            return res.status(400).json({ error: 'carrier and pointId required' });
        }
        
        const result = await servicePointService.validateServicePoint(carrier, pointId);
        res.json(result);
    } catch (error) {
        console.error('Service point validation error:', error);
        res.status(500).json({ valid: false, error: error.message });
    }
});

/**
 * GET /api/service-points/carriers
 * Get list of available carriers for service points
 */
router.get('/api/service-points/carriers', async (req, res) => {
    const { country = 'FR' } = req.query;
    
    const carriers = Object.entries(CARRIER_CONFIGS)
        .filter(([_, config]) => config.countries.includes(country))
        .map(([id, config]) => ({
            id,
            name: config.name,
            logo: config.logo,
            color: config.color,
            features: config.features,
            maxDistance: config.maxDistance
        }));
    
    res.json(carriers);
});

// ============================================
// WIDGET ROUTES
// ============================================

/**
 * GET /widget/service-points/:orgId
 * Render the service point picker widget
 */
router.get('/widget/service-points/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;
        const { 
            lang = 'fr', 
            country = 'FR',
            postalCode = '',
            theme,
            carriers: carrierParam
        } = req.query;

        // Get widget configuration
        const config = await widgetConfigService.getWidgetConfig(orgId);
        
        // Override theme if provided
        if (theme) config.theme = theme;
        
        // Parse carriers param
        const enabledCarriers = carrierParam 
            ? carrierParam.split(',') 
            : config.enabled_carriers;
        
        // Filter to available carriers for country
        const availableCarriers = enabledCarriers
            .filter(c => CARRIER_CONFIGS[c]?.countries.includes(country))
            .map(c => ({
                id: c,
                name: CARRIER_CONFIGS[c].name,
                logo: CARRIER_CONFIGS[c].logo,
                color: CARRIER_CONFIGS[c].color
            }));

        // Get labels for language
        const labels = config.labels[lang] || config.labels.fr;

        // Load and compile template
        const templatePath = path.join(__dirname, 'templates', 'service-point-picker.hbs');
        const templateSource = await fs.readFile(templatePath, 'utf-8');
        
        // Register helpers
        Handlebars.registerHelper('json', (obj) => JSON.stringify(obj));
        Handlebars.registerHelper('eq', (a, b) => a === b);
        
        const template = Handlebars.compile(templateSource);
        const html = template({
            orgId,
            lang,
            country,
            config: {
                ...config,
                enabled_carriers: enabledCarriers
            },
            labels,
            carriers: availableCarriers,
            initialPostalCode: postalCode,
            apiUrl: process.env.BASE_URL || '',
            mapboxToken: process.env.MAPBOX_TOKEN || ''
        });

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('Widget render error:', error);
        res.status(500).send('Error loading widget');
    }
});

/**
 * GET /widget/service-points.js
 * Embeddable JavaScript for the widget
 */
router.get('/widget/service-points.js', (req, res) => {
    const script = `
(function() {
    const ROUTZ_API = '${process.env.BASE_URL || ''}';
    
    /**
     * Routz Service Point Picker
     * Easy integration for e-commerce checkouts
     */
    window.RoutzServicePoints = {
        _modal: null,
        _iframe: null,
        _callback: null,
        _options: {},
        
        /**
         * Initialize the picker
         * @param {Object} options - Configuration options
         * @param {string} options.orgId - Your Routz organization ID
         * @param {string} options.lang - Language (default: 'fr')
         * @param {string} options.country - Country code (default: 'FR')
         * @param {string[]} options.carriers - List of carrier IDs to show
         * @param {string} options.theme - 'light', 'dark', or 'auto'
         */
        init: function(options) {
            this._options = options || {};
            this._setupMessageListener();
            return this;
        },
        
        /**
         * Open the service point picker
         * @param {Object} params - Parameters
         * @param {string} params.postalCode - Initial postal code
         * @param {Function} callback - Called when point is selected
         */
        open: function(params, callback) {
            this._callback = callback;
            
            const url = new URL(ROUTZ_API + '/widget/service-points/' + this._options.orgId);
            url.searchParams.set('lang', params.lang || this._options.lang || 'fr');
            url.searchParams.set('country', params.country || this._options.country || 'FR');
            if (params.postalCode) url.searchParams.set('postalCode', params.postalCode);
            if (this._options.theme) url.searchParams.set('theme', this._options.theme);
            if (this._options.carriers) url.searchParams.set('carriers', this._options.carriers.join(','));
            
            this._createModal(url.toString());
        },
        
        /**
         * Close the picker
         */
        close: function() {
            if (this._modal) {
                this._modal.remove();
                this._modal = null;
                this._iframe = null;
                document.body.style.overflow = '';
            }
        },
        
        /**
         * Embed picker inline
         * @param {string|Element} container - Container element or selector
         * @param {Object} params - Parameters
         */
        embed: function(container, params) {
            const el = typeof container === 'string' ? document.querySelector(container) : container;
            if (!el) return;
            
            const url = new URL(ROUTZ_API + '/widget/service-points/' + this._options.orgId);
            url.searchParams.set('lang', params.lang || this._options.lang || 'fr');
            url.searchParams.set('country', params.country || this._options.country || 'FR');
            if (params.postalCode) url.searchParams.set('postalCode', params.postalCode);
            if (this._options.theme) url.searchParams.set('theme', this._options.theme);
            if (this._options.carriers) url.searchParams.set('carriers', this._options.carriers.join(','));
            
            const iframe = document.createElement('iframe');
            iframe.src = url.toString();
            iframe.style.width = '100%';
            iframe.style.height = params.height || '600px';
            iframe.style.border = 'none';
            iframe.style.borderRadius = '12px';
            
            el.innerHTML = '';
            el.appendChild(iframe);
        },
        
        _createModal: function(url) {
            // Create modal overlay
            this._modal = document.createElement('div');
            this._modal.id = 'routz-spp-modal';
            this._modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;';
            
            // Create modal content
            const content = document.createElement('div');
            content.style.cssText = 'background:white;border-radius:16px;overflow:hidden;width:100%;max-width:900px;max-height:90vh;position:relative;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);';
            
            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '&times;';
            closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(0,0,0,0.1);font-size:24px;cursor:pointer;z-index:10;color:#374151;';
            closeBtn.onclick = () => this.close();
            
            // Iframe
            this._iframe = document.createElement('iframe');
            this._iframe.src = url;
            this._iframe.style.cssText = 'width:100%;height:650px;border:none;';
            
            content.appendChild(closeBtn);
            content.appendChild(this._iframe);
            this._modal.appendChild(content);
            
            // Close on overlay click
            this._modal.addEventListener('click', (e) => {
                if (e.target === this._modal) this.close();
            });
            
            // Close on Escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.close();
            });
            
            document.body.appendChild(this._modal);
            document.body.style.overflow = 'hidden';
        },
        
        _setupMessageListener: function() {
            window.addEventListener('message', (event) => {
                if (!event.data || !event.data.type) return;
                
                switch (event.data.type) {
                    case 'routz:servicepoint:selected':
                        // Point selected but not confirmed yet
                        if (this._options.onSelect) {
                            this._options.onSelect(event.data.point);
                        }
                        break;
                        
                    case 'routz:servicepoint:confirmed':
                        // Point confirmed
                        if (this._callback) {
                            this._callback(null, event.data.point);
                        }
                        this.close();
                        break;
                        
                    case 'routz:servicepoint:close':
                        this.close();
                        break;
                }
            });
        }
    };
    
    // Auto-init if data attributes present
    document.addEventListener('DOMContentLoaded', function() {
        const triggers = document.querySelectorAll('[data-routz-servicepoint]');
        triggers.forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                
                const orgId = el.dataset.orgId || el.dataset.routzServicepoint;
                const postalCode = el.dataset.postalCode || document.querySelector(el.dataset.postalCodeField)?.value;
                const callback = window[el.dataset.callback];
                
                if (!window.RoutzServicePoints._options.orgId) {
                    window.RoutzServicePoints.init({ orgId: orgId });
                }
                
                window.RoutzServicePoints.open({ postalCode: postalCode }, callback);
            });
        });
    });
})();
`;
    
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(script);
});

// ============================================
// ADMIN ROUTES
// ============================================

/**
 * GET /api/admin/service-points/config
 * Get widget configuration
 */
router.get('/api/admin/service-points/config', requireAuth, async (req, res) => {
    try {
        const config = await widgetConfigService.getWidgetConfig(req.orgId);
        res.json(config);
    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PUT /api/admin/service-points/config
 * Update widget configuration
 */
router.put('/api/admin/service-points/config', requireAuth, async (req, res) => {
    try {
        const config = await widgetConfigService.saveWidgetConfig(req.orgId, req.body);
        res.json(config);
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/admin/service-points/analytics
 * Get widget usage analytics
 */
router.get('/api/admin/service-points/analytics', requireAuth, async (req, res) => {
    try {
        const { from, to } = req.query;
        
        // This would query analytics from the database
        const analytics = {
            totalSearches: 0,
            totalSelections: 0,
            conversionRate: 0,
            topCarriers: [],
            topLocations: []
        };
        
        res.json(analytics);
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// CHECKOUT INTEGRATION ROUTES
// ============================================

/**
 * POST /api/checkout/shipping-options
 * Get shipping options including service points for checkout
 * This is the Dynamic Checkout API endpoint
 */
router.post('/api/checkout/shipping-options', async (req, res) => {
    try {
        const {
            orgId,
            postalCode,
            city,
            country = 'FR',
            weight,
            dimensions,
            cartValue
        } = req.body;

        // Get widget config for enabled carriers
        const config = await widgetConfigService.getWidgetConfig(orgId);
        
        // Search service points
        const servicePoints = await servicePointService.searchServicePoints({
            postalCode,
            city,
            country,
            carriers: config.enabled_carriers,
            maxResults: 5, // Top 5 for checkout
            weight,
            dimensions
        });

        // Group by carrier
        const groupedPoints = {};
        servicePoints.forEach(point => {
            if (!groupedPoints[point.carrier]) {
                groupedPoints[point.carrier] = {
                    carrier: point.carrier,
                    carrierName: point.carrierName,
                    carrierLogo: point.carrierLogo,
                    type: 'pickup',
                    points: []
                };
            }
            groupedPoints[point.carrier].points.push(point);
        });

        // Build shipping options
        const shippingOptions = [
            // Home delivery options (would come from carrier pricing API)
            {
                id: 'home_standard',
                type: 'delivery',
                name: 'Livraison standard',
                description: 'Livraison à domicile en 3-5 jours',
                price: 5.99,
                estimatedDays: { min: 3, max: 5 },
                carrier: 'colissimo'
            },
            {
                id: 'home_express',
                type: 'delivery',
                name: 'Livraison express',
                description: 'Livraison à domicile demain',
                price: 9.99,
                estimatedDays: { min: 1, max: 1 },
                carrier: 'chronopost'
            },
            
            // Service point options
            ...Object.values(groupedPoints).map(group => ({
                id: `pickup_${group.carrier}`,
                type: 'pickup',
                name: `Point relais ${group.carrierName}`,
                description: `${group.points.length} points disponibles`,
                price: group.carrier === 'mondial_relay' ? 3.99 : 4.99,
                estimatedDays: { min: 3, max: 5 },
                carrier: group.carrier,
                carrierLogo: group.carrierLogo,
                requiresPointSelection: true,
                points: group.points.slice(0, 3) // Top 3 nearest
            }))
        ];

        // Apply free shipping threshold
        if (cartValue >= 50) {
            shippingOptions.forEach(opt => {
                if (opt.type === 'pickup' || opt.id === 'home_standard') {
                    opt.originalPrice = opt.price;
                    opt.price = 0;
                    opt.freeShipping = true;
                }
            });
        }

        res.json({
            success: true,
            shippingOptions,
            freeShippingThreshold: 50,
            currency: 'EUR'
        });
    } catch (error) {
        console.error('Checkout shipping options error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Failed to get shipping options' 
        });
    }
});

// ============================================
// HELPERS
// ============================================

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    req.orgId = req.headers['x-org-id'] || 'default-org';
    next();
}

module.exports = router;
