/**
 * ROUTZ - Customer Returns Portal Service
 * Portail self-service pour les retours clients
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Handlebars = require('handlebars');
const path = require('path');
const fs = require('fs').promises;
const Stripe = require('stripe');

// ============================================
// DATABASE & CACHE
// ============================================

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ============================================
// RETURN REASONS
// ============================================

const DEFAULT_RETURN_REASONS = {
    fr: [
        { code: 'WRONG_SIZE', label: 'Taille incorrecte', category: 'fit', icon: '📏', refundable: true },
        { code: 'WRONG_COLOR', label: 'Couleur non conforme', category: 'appearance', icon: '🎨', refundable: true },
        { code: 'NOT_AS_DESCRIBED', label: 'Ne correspond pas à la description', category: 'quality', icon: '📝', refundable: true },
        { code: 'DEFECTIVE', label: 'Produit défectueux', category: 'quality', icon: '⚠️', refundable: true, priority: 'high' },
        { code: 'DAMAGED', label: 'Produit endommagé à la réception', category: 'shipping', icon: '📦', refundable: true, priority: 'high' },
        { code: 'WRONG_ITEM', label: 'Article incorrect reçu', category: 'fulfillment', icon: '❌', refundable: true, priority: 'high' },
        { code: 'CHANGED_MIND', label: 'J\'ai changé d\'avis', category: 'customer', icon: '🤔', refundable: true, restockingFee: true },
        { code: 'BETTER_PRICE', label: 'Trouvé moins cher ailleurs', category: 'customer', icon: '💰', refundable: true, restockingFee: true },
        { code: 'ARRIVED_LATE', label: 'Arrivé trop tard', category: 'shipping', icon: '⏰', refundable: true },
        { code: 'MISSING_PARTS', label: 'Pièces manquantes', category: 'quality', icon: '🧩', refundable: true, priority: 'high' },
        { code: 'OTHER', label: 'Autre raison', category: 'other', icon: '💬', refundable: true }
    ],
    en: [
        { code: 'WRONG_SIZE', label: 'Wrong size', category: 'fit', icon: '📏', refundable: true },
        { code: 'WRONG_COLOR', label: 'Wrong color', category: 'appearance', icon: '🎨', refundable: true },
        { code: 'NOT_AS_DESCRIBED', label: 'Not as described', category: 'quality', icon: '📝', refundable: true },
        { code: 'DEFECTIVE', label: 'Defective product', category: 'quality', icon: '⚠️', refundable: true, priority: 'high' },
        { code: 'DAMAGED', label: 'Damaged on arrival', category: 'shipping', icon: '📦', refundable: true, priority: 'high' },
        { code: 'WRONG_ITEM', label: 'Wrong item received', category: 'fulfillment', icon: '❌', refundable: true, priority: 'high' },
        { code: 'CHANGED_MIND', label: 'Changed my mind', category: 'customer', icon: '🤔', refundable: true, restockingFee: true },
        { code: 'BETTER_PRICE', label: 'Found better price', category: 'customer', icon: '💰', refundable: true, restockingFee: true },
        { code: 'ARRIVED_LATE', label: 'Arrived too late', category: 'shipping', icon: '⏰', refundable: true },
        { code: 'MISSING_PARTS', label: 'Missing parts', category: 'quality', icon: '🧩', refundable: true, priority: 'high' },
        { code: 'OTHER', label: 'Other reason', category: 'other', icon: '💬', refundable: true }
    ],
    de: [
        { code: 'WRONG_SIZE', label: 'Falsche Größe', category: 'fit', icon: '📏', refundable: true },
        { code: 'WRONG_COLOR', label: 'Falsche Farbe', category: 'appearance', icon: '🎨', refundable: true },
        { code: 'NOT_AS_DESCRIBED', label: 'Nicht wie beschrieben', category: 'quality', icon: '📝', refundable: true },
        { code: 'DEFECTIVE', label: 'Defektes Produkt', category: 'quality', icon: '⚠️', refundable: true, priority: 'high' },
        { code: 'DAMAGED', label: 'Bei Ankunft beschädigt', category: 'shipping', icon: '📦', refundable: true, priority: 'high' },
        { code: 'WRONG_ITEM', label: 'Falscher Artikel erhalten', category: 'fulfillment', icon: '❌', refundable: true, priority: 'high' },
        { code: 'CHANGED_MIND', label: 'Meinung geändert', category: 'customer', icon: '🤔', refundable: true, restockingFee: true },
        { code: 'BETTER_PRICE', label: 'Günstigeren Preis gefunden', category: 'customer', icon: '💰', refundable: true, restockingFee: true },
        { code: 'ARRIVED_LATE', label: 'Zu spät angekommen', category: 'shipping', icon: '⏰', refundable: true },
        { code: 'MISSING_PARTS', label: 'Fehlende Teile', category: 'quality', icon: '🧩', refundable: true, priority: 'high' },
        { code: 'OTHER', label: 'Anderer Grund', category: 'other', icon: '💬', refundable: true }
    ]
};

// ============================================
// PORTAL TRANSLATIONS
// ============================================

const portalTranslations = {
    fr: {
        portal_title: 'Portail de retours',
        find_order: 'Retrouver ma commande',
        order_number_label: 'Numéro de commande',
        email_label: 'Email de commande',
        postal_code_label: 'Code postal de livraison',
        search_button: 'Rechercher',
        order_not_found: 'Commande introuvable',
        order_not_found_desc: 'Vérifiez les informations saisies et réessayez.',
        select_items: 'Sélectionnez les articles à retourner',
        select_reason: 'Motif du retour',
        add_photos: 'Ajouter des photos (optionnel)',
        photo_hint: 'Photos du produit ou du défaut',
        comments: 'Commentaires additionnels',
        comments_placeholder: 'Décrivez le problème en détail...',
        return_method: 'Mode de retour',
        return_method_dropoff: 'Déposer en point relais',
        return_method_pickup: 'Enlèvement à domicile',
        return_method_store: 'Retour en magasin',
        return_cost: 'Frais de retour',
        free: 'Gratuit',
        paid: 'Payant',
        refund_estimate: 'Remboursement estimé',
        restocking_fee: 'Frais de restockage',
        return_shipping: 'Frais d\'envoi retour',
        total_refund: 'Remboursement total',
        submit_return: 'Soumettre ma demande de retour',
        return_policy: 'Politique de retour',
        return_deadline: 'Vous avez {days} jours pour retourner vos articles',
        return_success: 'Demande de retour créée !',
        return_success_desc: 'Votre numéro de retour est',
        download_label: 'Télécharger l\'étiquette',
        qr_code: 'QR Code (sans impression)',
        return_instructions: 'Instructions de retour',
        step_1: 'Imprimez l\'étiquette ou gardez le QR code',
        step_2: 'Emballez soigneusement les articles',
        step_3: 'Déposez le colis en point relais',
        track_return: 'Suivre mon retour',
        need_help: 'Besoin d\'aide ?',
        contact_support: 'Contacter le support',
        return_status: 'Statut du retour',
        status_pending: 'En attente de validation',
        status_approved: 'Approuvé',
        status_label_created: 'Étiquette créée',
        status_in_transit: 'En transit',
        status_received: 'Reçu',
        status_processing: 'En cours de traitement',
        status_refunded: 'Remboursé',
        status_rejected: 'Refusé',
        items_to_return: 'Articles à retourner',
        quantity: 'Quantité',
        continue: 'Continuer',
        back: 'Retour',
        order_date: 'Date de commande',
        delivery_date: 'Date de livraison',
        original_order: 'Commande d\'origine',
        eligible_for_return: 'Éligible au retour',
        not_eligible: 'Non éligible',
        return_window_expired: 'Délai de retour expiré',
        already_returned: 'Déjà retourné',
        processing_payment: 'Traitement du paiement...',
        payment_required: 'Paiement requis',
        pay_return_fee: 'Payer les frais de retour',
        secure_payment: 'Paiement sécurisé'
    },
    en: {
        portal_title: 'Returns Portal',
        find_order: 'Find my order',
        order_number_label: 'Order number',
        email_label: 'Order email',
        postal_code_label: 'Delivery postal code',
        search_button: 'Search',
        order_not_found: 'Order not found',
        order_not_found_desc: 'Please verify the information and try again.',
        select_items: 'Select items to return',
        select_reason: 'Return reason',
        add_photos: 'Add photos (optional)',
        photo_hint: 'Photos of product or defect',
        comments: 'Additional comments',
        comments_placeholder: 'Describe the issue in detail...',
        return_method: 'Return method',
        return_method_dropoff: 'Drop off at service point',
        return_method_pickup: 'Home pickup',
        return_method_store: 'Return in store',
        return_cost: 'Return cost',
        free: 'Free',
        paid: 'Paid',
        refund_estimate: 'Estimated refund',
        restocking_fee: 'Restocking fee',
        return_shipping: 'Return shipping',
        total_refund: 'Total refund',
        submit_return: 'Submit return request',
        return_policy: 'Return policy',
        return_deadline: 'You have {days} days to return your items',
        return_success: 'Return request created!',
        return_success_desc: 'Your return number is',
        download_label: 'Download label',
        qr_code: 'QR Code (paperless)',
        return_instructions: 'Return instructions',
        step_1: 'Print the label or keep the QR code',
        step_2: 'Pack items carefully',
        step_3: 'Drop off at service point',
        track_return: 'Track my return',
        need_help: 'Need help?',
        contact_support: 'Contact support',
        return_status: 'Return status',
        status_pending: 'Pending approval',
        status_approved: 'Approved',
        status_label_created: 'Label created',
        status_in_transit: 'In transit',
        status_received: 'Received',
        status_processing: 'Processing',
        status_refunded: 'Refunded',
        status_rejected: 'Rejected',
        items_to_return: 'Items to return',
        quantity: 'Quantity',
        continue: 'Continue',
        back: 'Back',
        order_date: 'Order date',
        delivery_date: 'Delivery date',
        original_order: 'Original order',
        eligible_for_return: 'Eligible for return',
        not_eligible: 'Not eligible',
        return_window_expired: 'Return window expired',
        already_returned: 'Already returned',
        processing_payment: 'Processing payment...',
        payment_required: 'Payment required',
        pay_return_fee: 'Pay return fee',
        secure_payment: 'Secure payment'
    }
};

// ============================================
// RETURNS PORTAL SERVICE
// ============================================

class ReturnsPortalService {
    constructor() {
        this.templateCache = new Map();
    }

    // ----------------------------------------
    // PORTAL CONFIGURATION
    // ----------------------------------------

    async getPortalConfig(orgId) {
        const cached = await redis.get(`returns_portal:${orgId}`);
        if (cached) return JSON.parse(cached);

        const result = await db.query(
            `SELECT rp.*, bs.* FROM returns_portal_settings rp
             LEFT JOIN brand_settings bs ON rp.organization_id = bs.organization_id
             WHERE rp.organization_id = $1`,
            [orgId]
        );

        const config = result.rows[0] || this.getDefaultPortalConfig();
        await redis.setex(`returns_portal:${orgId}`, 300, JSON.stringify(config));
        
        return config;
    }

    getDefaultPortalConfig() {
        return {
            enabled: true,
            return_window_days: 30,
            auto_approve: false,
            require_photos: false,
            allow_partial_returns: true,
            
            // Return methods
            methods: {
                dropoff: { enabled: true, price: 0, label: 'Point relais' },
                pickup: { enabled: false, price: 4.99, label: 'Enlèvement à domicile' },
                store: { enabled: false, price: 0, label: 'Retour en magasin' }
            },
            
            // Fees
            restocking_fee_percent: 0,
            free_return_threshold: 0, // Order value above which return is free
            
            // Carriers for returns
            return_carriers: ['colissimo', 'mondial_relay'],
            default_carrier: 'colissimo',
            
            // Custom reasons (uses default if empty)
            custom_reasons: null,
            
            // Refund options
            refund_methods: ['original_payment', 'store_credit'],
            default_refund_method: 'original_payment',
            
            // QR code / paperless options
            enable_qr_code: true,
            enable_label_in_box: false,
            
            // Styling
            custom_css: '',
            
            // Legal
            terms_url: '',
            privacy_url: ''
        };
    }

    async savePortalConfig(orgId, config) {
        await db.query(`
            INSERT INTO returns_portal_settings (
                organization_id, enabled, return_window_days, auto_approve, require_photos,
                allow_partial_returns, methods, restocking_fee_percent, free_return_threshold,
                return_carriers, default_carrier, custom_reasons, refund_methods, default_refund_method,
                enable_qr_code, enable_label_in_box, custom_css, terms_url, privacy_url
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (organization_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                return_window_days = EXCLUDED.return_window_days,
                auto_approve = EXCLUDED.auto_approve,
                require_photos = EXCLUDED.require_photos,
                allow_partial_returns = EXCLUDED.allow_partial_returns,
                methods = EXCLUDED.methods,
                restocking_fee_percent = EXCLUDED.restocking_fee_percent,
                free_return_threshold = EXCLUDED.free_return_threshold,
                return_carriers = EXCLUDED.return_carriers,
                default_carrier = EXCLUDED.default_carrier,
                custom_reasons = EXCLUDED.custom_reasons,
                refund_methods = EXCLUDED.refund_methods,
                default_refund_method = EXCLUDED.default_refund_method,
                enable_qr_code = EXCLUDED.enable_qr_code,
                enable_label_in_box = EXCLUDED.enable_label_in_box,
                custom_css = EXCLUDED.custom_css,
                terms_url = EXCLUDED.terms_url,
                privacy_url = EXCLUDED.privacy_url,
                updated_at = NOW()
        `, [
            orgId, config.enabled, config.return_window_days, config.auto_approve,
            config.require_photos, config.allow_partial_returns, JSON.stringify(config.methods),
            config.restocking_fee_percent, config.free_return_threshold,
            config.return_carriers, config.default_carrier, JSON.stringify(config.custom_reasons),
            config.refund_methods, config.default_refund_method, config.enable_qr_code,
            config.enable_label_in_box, config.custom_css, config.terms_url, config.privacy_url
        ]);

        await redis.del(`returns_portal:${orgId}`);
        return config;
    }

    // ----------------------------------------
    // ORDER LOOKUP
    // ----------------------------------------

    async findOrder(orgId, searchParams) {
        const { orderNumber, email, postalCode } = searchParams;

        // Build query with multiple verification methods
        let query = `
            SELECT o.*, s.tracking_number, s.carrier, s.status as shipment_status,
                   s.delivered_at, s.shipped_at
            FROM orders o
            LEFT JOIN shipments s ON o.id = s.order_id
            WHERE o.organization_id = $1
        `;
        const params = [orgId];
        let paramIndex = 2;

        // Order number is required
        if (orderNumber) {
            query += ` AND o.order_number = $${paramIndex}`;
            params.push(orderNumber);
            paramIndex++;
        } else {
            return null;
        }

        // Additional verification (email OR postal code)
        if (email) {
            query += ` AND LOWER(o.customer_email) = LOWER($${paramIndex})`;
            params.push(email);
            paramIndex++;
        } else if (postalCode) {
            query += ` AND (o.shipping_address->>'postalCode' = $${paramIndex} OR o.shipping_address->>'postal_code' = $${paramIndex})`;
            params.push(postalCode);
            paramIndex++;
        }

        const result = await db.query(query, params);
        const order = result.rows[0];

        if (!order) return null;

        // Get portal config for eligibility check
        const portalConfig = await this.getPortalConfig(orgId);

        // Enrich order with return eligibility
        const enrichedOrder = {
            ...order,
            items: this.enrichItemsWithEligibility(order.items, order, portalConfig)
        };

        return enrichedOrder;
    }

    enrichItemsWithEligibility(items, order, portalConfig) {
        if (!Array.isArray(items)) {
            try {
                items = JSON.parse(items);
            } catch {
                return [];
            }
        }

        const deliveryDate = order.delivered_at ? new Date(order.delivered_at) : 
                            order.shipped_at ? new Date(order.shipped_at) : 
                            new Date(order.created_at);
        
        const returnDeadline = new Date(deliveryDate);
        returnDeadline.setDate(returnDeadline.getDate() + portalConfig.return_window_days);
        
        const now = new Date();
        const isWithinReturnWindow = now <= returnDeadline;

        return items.map(item => {
            // Check if already returned
            const alreadyReturned = item.returned_quantity >= item.quantity;
            const returnableQuantity = item.quantity - (item.returned_quantity || 0);

            return {
                ...item,
                eligible: isWithinReturnWindow && !alreadyReturned && returnableQuantity > 0,
                eligibilityReason: !isWithinReturnWindow ? 'return_window_expired' :
                                   alreadyReturned ? 'already_returned' : null,
                returnableQuantity,
                returnDeadline: returnDeadline.toISOString()
            };
        });
    }

    // ----------------------------------------
    // RETURN REQUEST CREATION
    // ----------------------------------------

    async createReturnRequest(orgId, requestData) {
        const {
            orderId,
            orderNumber,
            customerEmail,
            items,
            returnMethod,
            refundMethod,
            comments,
            photos
        } = requestData;

        const portalConfig = await this.getPortalConfig(orgId);
        
        // Validate items
        const order = await this.getOrderById(orderId);
        if (!order) throw new Error('Order not found');

        // Calculate refund
        const refundCalculation = this.calculateRefund(items, order, portalConfig, returnMethod);

        // Generate RMA ID
        const rmaId = this.generateRMAId();

        // Create return record
        const returnRecord = {
            id: uuidv4(),
            rma_id: rmaId,
            organization_id: orgId,
            order_id: orderId,
            order_number: orderNumber,
            customer_email: customerEmail,
            items: items.map(item => ({
                ...item,
                status: 'pending'
            })),
            return_method: returnMethod,
            refund_method: refundMethod || portalConfig.default_refund_method,
            comments,
            photos: photos || [],
            
            // Financial
            original_amount: refundCalculation.originalAmount,
            restocking_fee: refundCalculation.restockingFee,
            shipping_fee: refundCalculation.shippingFee,
            estimated_refund: refundCalculation.totalRefund,
            
            // Status
            status: portalConfig.auto_approve ? 'approved' : 'pending_approval',
            
            // Dates
            created_at: new Date().toISOString(),
            approved_at: portalConfig.auto_approve ? new Date().toISOString() : null
        };

        await db.query(`
            INSERT INTO returns (
                id, rma_id, organization_id, order_id, order_number, customer_email,
                items, return_method, refund_method, comments, photos,
                original_amount, restocking_fee, shipping_fee, estimated_refund,
                status, created_at, approved_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `, [
            returnRecord.id, returnRecord.rma_id, returnRecord.organization_id,
            returnRecord.order_id, returnRecord.order_number, returnRecord.customer_email,
            JSON.stringify(returnRecord.items), returnRecord.return_method, returnRecord.refund_method,
            returnRecord.comments, JSON.stringify(returnRecord.photos),
            returnRecord.original_amount, returnRecord.restocking_fee, returnRecord.shipping_fee,
            returnRecord.estimated_refund, returnRecord.status, returnRecord.created_at,
            returnRecord.approved_at
        ]);

        // If auto-approved and no payment needed, generate label
        if (portalConfig.auto_approve && refundCalculation.shippingFee === 0) {
            await this.generateReturnLabel(returnRecord.id);
        }

        // Mark items as pending return in order
        await this.markItemsAsReturning(orderId, items);

        return {
            ...returnRecord,
            refundCalculation
        };
    }

    calculateRefund(items, order, portalConfig, returnMethod) {
        // Calculate original amount
        let originalAmount = 0;
        items.forEach(item => {
            const orderItem = order.items.find(oi => oi.id === item.orderItemId || oi.sku === item.sku);
            if (orderItem) {
                originalAmount += (orderItem.price || 0) * item.quantity;
            }
        });

        // Calculate restocking fee
        let restockingFee = 0;
        if (portalConfig.restocking_fee_percent > 0) {
            // Check if reason warrants restocking fee
            const hasCustomerReason = items.some(item => 
                ['CHANGED_MIND', 'BETTER_PRICE'].includes(item.reasonCode)
            );
            if (hasCustomerReason) {
                restockingFee = originalAmount * (portalConfig.restocking_fee_percent / 100);
            }
        }

        // Calculate shipping fee
        let shippingFee = 0;
        const method = portalConfig.methods[returnMethod];
        if (method) {
            // Check if order qualifies for free return
            if (portalConfig.free_return_threshold > 0 && order.total >= portalConfig.free_return_threshold) {
                shippingFee = 0;
            } else if (this.isQualityIssue(items)) {
                // Free return for quality issues
                shippingFee = 0;
            } else {
                shippingFee = method.price || 0;
            }
        }

        const totalRefund = Math.max(0, originalAmount - restockingFee - shippingFee);

        return {
            originalAmount: Math.round(originalAmount * 100) / 100,
            restockingFee: Math.round(restockingFee * 100) / 100,
            shippingFee: Math.round(shippingFee * 100) / 100,
            totalRefund: Math.round(totalRefund * 100) / 100
        };
    }

    isQualityIssue(items) {
        const qualityReasons = ['DEFECTIVE', 'DAMAGED', 'WRONG_ITEM', 'MISSING_PARTS', 'NOT_AS_DESCRIBED'];
        return items.some(item => qualityReasons.includes(item.reasonCode));
    }

    // ----------------------------------------
    // RETURN LABEL GENERATION
    // ----------------------------------------

    async generateReturnLabel(returnId) {
        const returnRecord = await this.getReturnById(returnId);
        if (!returnRecord) throw new Error('Return not found');

        const portalConfig = await this.getPortalConfig(returnRecord.organization_id);
        const order = await this.getOrderById(returnRecord.order_id);

        // Get return address from organization settings
        const returnAddress = await this.getReturnAddress(returnRecord.organization_id);

        // Generate label with carrier
        const carrier = portalConfig.default_carrier;
        const labelData = await this.createCarrierLabel(carrier, {
            sender: {
                name: order.customer_name || order.shipping_address?.name,
                address1: order.shipping_address?.address1,
                city: order.shipping_address?.city,
                postalCode: order.shipping_address?.postalCode || order.shipping_address?.postal_code,
                country: order.shipping_address?.country || 'FR',
                email: order.customer_email
            },
            recipient: returnAddress,
            reference: returnRecord.rma_id,
            weight: this.estimateReturnWeight(returnRecord.items)
        });

        // Generate QR code if enabled
        let qrCodeUrl = null;
        if (portalConfig.enable_qr_code) {
            qrCodeUrl = await this.generateQRCode(labelData.trackingNumber, carrier);
        }

        // Update return record
        await db.query(`
            UPDATE returns SET
                carrier = $1,
                tracking_number = $2,
                label_url = $3,
                qr_code_url = $4,
                status = 'label_created',
                label_created_at = NOW(),
                updated_at = NOW()
            WHERE id = $5
        `, [carrier, labelData.trackingNumber, labelData.labelUrl, qrCodeUrl, returnId]);

        return {
            trackingNumber: labelData.trackingNumber,
            labelUrl: labelData.labelUrl,
            qrCodeUrl,
            carrier
        };
    }

    async createCarrierLabel(carrier, data) {
        // This would integrate with actual carrier APIs
        // For now, generate mock data
        const trackingNumber = `RET${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        
        return {
            trackingNumber,
            labelUrl: `https://labels.routz.io/returns/${trackingNumber}.pdf`,
            carrier
        };
    }

    async generateQRCode(trackingNumber, carrier) {
        // Generate QR code for paperless returns
        // This would use a QR code generation library
        return `https://qr.routz.io/return/${trackingNumber}`;
    }

    // ----------------------------------------
    // PAYMENT PROCESSING
    // ----------------------------------------

    async createPaymentIntent(returnId) {
        if (!stripe) throw new Error('Stripe not configured');

        const returnRecord = await this.getReturnById(returnId);
        if (!returnRecord) throw new Error('Return not found');

        if (returnRecord.shipping_fee <= 0) {
            throw new Error('No payment required');
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(returnRecord.shipping_fee * 100), // cents
            currency: 'eur',
            metadata: {
                returnId: returnRecord.id,
                rmaId: returnRecord.rma_id,
                orderId: returnRecord.order_id
            }
        });

        // Store payment intent ID
        await db.query(`
            UPDATE returns SET
                payment_intent_id = $1,
                updated_at = NOW()
            WHERE id = $2
        `, [paymentIntent.id, returnId]);

        return {
            clientSecret: paymentIntent.client_secret,
            amount: returnRecord.shipping_fee
        };
    }

    async confirmPayment(returnId, paymentIntentId) {
        const returnRecord = await this.getReturnById(returnId);
        if (!returnRecord) throw new Error('Return not found');

        // Verify payment with Stripe
        if (stripe) {
            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
            if (paymentIntent.status !== 'succeeded') {
                throw new Error('Payment not successful');
            }
        }

        // Mark as paid and generate label
        await db.query(`
            UPDATE returns SET
                payment_status = 'paid',
                paid_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
        `, [returnId]);

        // Generate return label
        return await this.generateReturnLabel(returnId);
    }

    // ----------------------------------------
    // RETURN STATUS & TRACKING
    // ----------------------------------------

    async getReturnStatus(rmaId) {
        const result = await db.query(`
            SELECT r.*, o.order_number, o.customer_name
            FROM returns r
            LEFT JOIN orders o ON r.order_id = o.id
            WHERE r.rma_id = $1
        `, [rmaId]);

        return result.rows[0];
    }

    async trackReturn(rmaId) {
        const returnRecord = await this.getReturnStatus(rmaId);
        if (!returnRecord) return null;

        // Get tracking events from carrier
        let trackingEvents = [];
        if (returnRecord.tracking_number) {
            trackingEvents = await this.getCarrierTracking(
                returnRecord.carrier, 
                returnRecord.tracking_number
            );
        }

        return {
            ...returnRecord,
            trackingEvents
        };
    }

    async getCarrierTracking(carrier, trackingNumber) {
        // This would integrate with actual carrier tracking APIs
        return [];
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    async getOrderById(orderId) {
        const result = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        return result.rows[0];
    }

    async getReturnById(returnId) {
        const result = await db.query('SELECT * FROM returns WHERE id = $1', [returnId]);
        return result.rows[0];
    }

    async getReturnAddress(orgId) {
        const result = await db.query(
            `SELECT return_address FROM organization_settings WHERE organization_id = $1`,
            [orgId]
        );
        
        if (result.rows[0]?.return_address) {
            return result.rows[0].return_address;
        }

        // Fallback to warehouse
        const warehouse = await db.query(
            `SELECT * FROM warehouses WHERE organization_id = $1 AND type = 'return' OR is_default = true LIMIT 1`,
            [orgId]
        );

        if (warehouse.rows[0]) {
            return {
                name: warehouse.rows[0].name,
                address1: warehouse.rows[0].address_line1,
                city: warehouse.rows[0].city,
                postalCode: warehouse.rows[0].postal_code,
                country: warehouse.rows[0].country || 'FR'
            };
        }

        throw new Error('No return address configured');
    }

    async markItemsAsReturning(orderId, items) {
        const order = await this.getOrderById(orderId);
        if (!order) return;

        const orderItems = Array.isArray(order.items) ? order.items : JSON.parse(order.items);
        
        items.forEach(returnItem => {
            const orderItem = orderItems.find(oi => 
                oi.id === returnItem.orderItemId || oi.sku === returnItem.sku
            );
            if (orderItem) {
                orderItem.returning_quantity = (orderItem.returning_quantity || 0) + returnItem.quantity;
            }
        });

        await db.query(
            'UPDATE orders SET items = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(orderItems), orderId]
        );
    }

    estimateReturnWeight(items) {
        // Estimate weight based on items
        const totalWeight = items.reduce((sum, item) => {
            return sum + (item.weight || 0.5) * item.quantity;
        }, 0);
        return Math.max(0.5, totalWeight);
    }

    generateRMAId() {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substr(2, 4).toUpperCase();
        return `RMA-${timestamp}-${random}`;
    }

    getReturnReasons(lang = 'fr') {
        return DEFAULT_RETURN_REASONS[lang] || DEFAULT_RETURN_REASONS.en;
    }

    getTranslations(lang = 'fr') {
        return portalTranslations[lang] || portalTranslations.en;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    ReturnsPortalService,
    DEFAULT_RETURN_REASONS,
    portalTranslations
};
