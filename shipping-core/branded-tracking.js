/**
 * ROUTZ - Branded Tracking Service
 * Service complet pour pages de tracking personnalisées,
 * emails multi-langues et notifications
 */

const nodemailer = require('nodemailer');
const Handlebars = require('handlebars');
const { Pool } = require('pg');
const Redis = require('ioredis');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs').promises;

// ============================================
// CONFIGURATION
// ============================================

const config = {
    email: {
        host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    },
    sms: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        fromNumber: process.env.TWILIO_FROM_NUMBER
    },
    baseUrl: process.env.BASE_URL || 'https://track.routz.io',
    defaultLanguage: 'fr'
};

// ============================================
// DATABASE & CACHE
// ============================================

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// ============================================
// SUPPORTED LANGUAGES
// ============================================

const SUPPORTED_LANGUAGES = ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt', 'pl'];

// ============================================
// STATUS MAPPINGS
// ============================================

const STATUS_ICONS = {
    pending: '📦',
    label_created: '🏷️',
    picked_up: '🚚',
    in_transit: '🚛',
    out_for_delivery: '🛵',
    delivered: '✅',
    exception: '⚠️',
    returned: '↩️',
    cancelled: '❌'
};

const STATUS_COLORS = {
    pending: '#6B7280',
    label_created: '#3B82F6',
    picked_up: '#8B5CF6',
    in_transit: '#F59E0B',
    out_for_delivery: '#10B981',
    delivered: '#059669',
    exception: '#EF4444',
    returned: '#6366F1',
    cancelled: '#374151'
};

// ============================================
// TRANSLATIONS
// ============================================

const translations = {
    fr: {
        tracking_title: 'Suivi de votre commande',
        tracking_number: 'N° de suivi',
        order_number: 'N° de commande',
        carrier: 'Transporteur',
        estimated_delivery: 'Livraison estimée',
        delivery_address: 'Adresse de livraison',
        status: {
            pending: 'En attente de prise en charge',
            label_created: 'Étiquette créée',
            picked_up: 'Pris en charge par le transporteur',
            in_transit: 'En cours d\'acheminement',
            out_for_delivery: 'En cours de livraison',
            delivered: 'Livré',
            exception: 'Incident de livraison',
            returned: 'Retourné à l\'expéditeur',
            cancelled: 'Annulé'
        },
        email_subject: {
            label_created: '📦 Votre commande {orderNumber} a été expédiée',
            in_transit: '🚛 Votre colis est en route',
            out_for_delivery: '🛵 Votre colis arrive aujourd\'hui !',
            delivered: '✅ Votre colis a été livré',
            exception: '⚠️ Un problème avec votre livraison'
        },
        cta_track: 'Suivre mon colis',
        cta_help: 'Besoin d\'aide ?',
        footer_text: 'Merci pour votre confiance',
        timeline_title: 'Historique du suivi',
        products_ordered: 'Articles commandés',
        need_help: 'Une question ?',
        contact_us: 'Contactez-nous',
        follow_us: 'Suivez-nous',
        promo_title: 'Offre spéciale',
        return_package: 'Retourner un article'
    },
    en: {
        tracking_title: 'Track your order',
        tracking_number: 'Tracking number',
        order_number: 'Order number',
        carrier: 'Carrier',
        estimated_delivery: 'Estimated delivery',
        delivery_address: 'Delivery address',
        status: {
            pending: 'Awaiting pickup',
            label_created: 'Label created',
            picked_up: 'Picked up by carrier',
            in_transit: 'In transit',
            out_for_delivery: 'Out for delivery',
            delivered: 'Delivered',
            exception: 'Delivery exception',
            returned: 'Returned to sender',
            cancelled: 'Cancelled'
        },
        email_subject: {
            label_created: '📦 Your order {orderNumber} has been shipped',
            in_transit: '🚛 Your package is on its way',
            out_for_delivery: '🛵 Your package arrives today!',
            delivered: '✅ Your package has been delivered',
            exception: '⚠️ Issue with your delivery'
        },
        cta_track: 'Track my package',
        cta_help: 'Need help?',
        footer_text: 'Thank you for your trust',
        timeline_title: 'Tracking history',
        products_ordered: 'Items ordered',
        need_help: 'Any questions?',
        contact_us: 'Contact us',
        follow_us: 'Follow us',
        promo_title: 'Special offer',
        return_package: 'Return an item'
    },
    de: {
        tracking_title: 'Sendungsverfolgung',
        tracking_number: 'Sendungsnummer',
        order_number: 'Bestellnummer',
        carrier: 'Versanddienstleister',
        estimated_delivery: 'Voraussichtliche Lieferung',
        delivery_address: 'Lieferadresse',
        status: {
            pending: 'Warten auf Abholung',
            label_created: 'Versandlabel erstellt',
            picked_up: 'Vom Versanddienstleister abgeholt',
            in_transit: 'Unterwegs',
            out_for_delivery: 'Zustellung heute',
            delivered: 'Zugestellt',
            exception: 'Lieferausnahme',
            returned: 'Zurück an Absender',
            cancelled: 'Storniert'
        },
        email_subject: {
            label_created: '📦 Ihre Bestellung {orderNumber} wurde versendet',
            in_transit: '🚛 Ihr Paket ist unterwegs',
            out_for_delivery: '🛵 Ihr Paket kommt heute!',
            delivered: '✅ Ihr Paket wurde zugestellt',
            exception: '⚠️ Problem mit Ihrer Lieferung'
        },
        cta_track: 'Paket verfolgen',
        cta_help: 'Brauchen Sie Hilfe?',
        footer_text: 'Vielen Dank für Ihr Vertrauen',
        timeline_title: 'Sendungsverlauf',
        products_ordered: 'Bestellte Artikel',
        need_help: 'Fragen?',
        contact_us: 'Kontaktieren Sie uns',
        follow_us: 'Folgen Sie uns',
        promo_title: 'Sonderangebot',
        return_package: 'Artikel zurückgeben'
    },
    es: {
        tracking_title: 'Seguimiento de tu pedido',
        tracking_number: 'Número de seguimiento',
        order_number: 'Número de pedido',
        carrier: 'Transportista',
        estimated_delivery: 'Entrega estimada',
        delivery_address: 'Dirección de entrega',
        status: {
            pending: 'Esperando recogida',
            label_created: 'Etiqueta creada',
            picked_up: 'Recogido por el transportista',
            in_transit: 'En tránsito',
            out_for_delivery: 'En reparto',
            delivered: 'Entregado',
            exception: 'Incidencia de entrega',
            returned: 'Devuelto al remitente',
            cancelled: 'Cancelado'
        },
        email_subject: {
            label_created: '📦 Tu pedido {orderNumber} ha sido enviado',
            in_transit: '🚛 Tu paquete está en camino',
            out_for_delivery: '🛵 ¡Tu paquete llega hoy!',
            delivered: '✅ Tu paquete ha sido entregado',
            exception: '⚠️ Problema con tu entrega'
        },
        cta_track: 'Seguir mi paquete',
        cta_help: '¿Necesitas ayuda?',
        footer_text: 'Gracias por tu confianza',
        timeline_title: 'Historial de seguimiento',
        products_ordered: 'Artículos pedidos',
        need_help: '¿Alguna pregunta?',
        contact_us: 'Contáctanos',
        follow_us: 'Síguenos',
        promo_title: 'Oferta especial',
        return_package: 'Devolver un artículo'
    },
    it: {
        tracking_title: 'Traccia il tuo ordine',
        tracking_number: 'Numero di tracciamento',
        order_number: 'Numero ordine',
        carrier: 'Corriere',
        estimated_delivery: 'Consegna stimata',
        delivery_address: 'Indirizzo di consegna',
        status: {
            pending: 'In attesa di ritiro',
            label_created: 'Etichetta creata',
            picked_up: 'Ritirato dal corriere',
            in_transit: 'In transito',
            out_for_delivery: 'In consegna',
            delivered: 'Consegnato',
            exception: 'Eccezione di consegna',
            returned: 'Restituito al mittente',
            cancelled: 'Annullato'
        },
        email_subject: {
            label_created: '📦 Il tuo ordine {orderNumber} è stato spedito',
            in_transit: '🚛 Il tuo pacco è in arrivo',
            out_for_delivery: '🛵 Il tuo pacco arriva oggi!',
            delivered: '✅ Il tuo pacco è stato consegnato',
            exception: '⚠️ Problema con la tua consegna'
        },
        cta_track: 'Traccia il mio pacco',
        cta_help: 'Hai bisogno di aiuto?',
        footer_text: 'Grazie per la tua fiducia',
        timeline_title: 'Cronologia tracciamento',
        products_ordered: 'Articoli ordinati',
        need_help: 'Domande?',
        contact_us: 'Contattaci',
        follow_us: 'Seguici',
        promo_title: 'Offerta speciale',
        return_package: 'Restituisci un articolo'
    },
    nl: {
        tracking_title: 'Volg je bestelling',
        tracking_number: 'Trackingnummer',
        order_number: 'Bestelnummer',
        carrier: 'Vervoerder',
        estimated_delivery: 'Verwachte levering',
        delivery_address: 'Bezorgadres',
        status: {
            pending: 'Wachten op ophaling',
            label_created: 'Verzendlabel aangemaakt',
            picked_up: 'Opgehaald door vervoerder',
            in_transit: 'Onderweg',
            out_for_delivery: 'Wordt vandaag bezorgd',
            delivered: 'Bezorgd',
            exception: 'Leveringsuitzondering',
            returned: 'Teruggestuurd naar afzender',
            cancelled: 'Geannuleerd'
        },
        email_subject: {
            label_created: '📦 Je bestelling {orderNumber} is verzonden',
            in_transit: '🚛 Je pakket is onderweg',
            out_for_delivery: '🛵 Je pakket komt vandaag!',
            delivered: '✅ Je pakket is bezorgd',
            exception: '⚠️ Probleem met je levering'
        },
        cta_track: 'Volg mijn pakket',
        cta_help: 'Hulp nodig?',
        footer_text: 'Bedankt voor je vertrouwen',
        timeline_title: 'Trackinggeschiedenis',
        products_ordered: 'Bestelde artikelen',
        need_help: 'Vragen?',
        contact_us: 'Neem contact op',
        follow_us: 'Volg ons',
        promo_title: 'Speciale aanbieding',
        return_package: 'Artikel retourneren'
    }
};

// ============================================
// BRANDED TRACKING SERVICE
// ============================================

class BrandedTrackingService {
    constructor() {
        this.mailer = nodemailer.createTransport(config.email);
        this.smsClient = config.sms.accountSid ? 
            twilio(config.sms.accountSid, config.sms.authToken) : null;
        this.templateCache = new Map();
        this.registerHandlebarsHelpers();
    }

    // ----------------------------------------
    // HANDLEBARS HELPERS
    // ----------------------------------------

    registerHandlebarsHelpers() {
        Handlebars.registerHelper('formatDate', (date, format, lang) => {
            if (!date) return '';
            const d = new Date(date);
            const options = { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            };
            return d.toLocaleDateString(lang || 'fr-FR', options);
        });

        Handlebars.registerHelper('formatTime', (date, lang) => {
            if (!date) return '';
            const d = new Date(date);
            return d.toLocaleTimeString(lang || 'fr-FR', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
        });

        Handlebars.registerHelper('formatDateTime', (date, lang) => {
            if (!date) return '';
            const d = new Date(date);
            return d.toLocaleString(lang || 'fr-FR', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
            });
        });

        Handlebars.registerHelper('statusIcon', (status) => STATUS_ICONS[status] || '📦');
        Handlebars.registerHelper('statusColor', (status) => STATUS_COLORS[status] || '#6B7280');
        
        Handlebars.registerHelper('t', (key, lang) => {
            const langData = translations[lang] || translations.fr;
            const keys = key.split('.');
            let value = langData;
            for (const k of keys) {
                value = value?.[k];
            }
            return value || key;
        });

        Handlebars.registerHelper('eq', (a, b) => a === b);
        Handlebars.registerHelper('gt', (a, b) => a > b);
        Handlebars.registerHelper('includes', (arr, val) => arr?.includes(val));
        
        Handlebars.registerHelper('progressPercent', (status) => {
            const progress = {
                pending: 10,
                label_created: 20,
                picked_up: 35,
                in_transit: 60,
                out_for_delivery: 85,
                delivered: 100,
                exception: 70,
                returned: 100,
                cancelled: 0
            };
            return progress[status] || 0;
        });

        Handlebars.registerHelper('json', (obj) => JSON.stringify(obj));
    }

    // ----------------------------------------
    // BRAND CONFIGURATION
    // ----------------------------------------

    async getBrandConfig(orgId) {
        // Check cache first
        const cached = await redis.get(`brand:${orgId}`);
        if (cached) return JSON.parse(cached);

        const result = await db.query(
            `SELECT * FROM brand_settings WHERE organization_id = $1`,
            [orgId]
        );

        const brand = result.rows[0] || this.getDefaultBrandConfig();
        
        // Cache for 5 minutes
        await redis.setex(`brand:${orgId}`, 300, JSON.stringify(brand));
        
        return brand;
    }

    getDefaultBrandConfig() {
        return {
            name: 'Ma Boutique',
            logo_url: null,
            favicon_url: null,
            primary_color: '#2563EB',
            secondary_color: '#1E40AF',
            accent_color: '#F59E0B',
            background_color: '#F8FAFC',
            text_color: '#1E293B',
            font_family: 'Inter, system-ui, sans-serif',
            border_radius: '12px',
            
            // Tracking page settings
            show_carrier_logo: true,
            show_estimated_delivery: true,
            show_map: false,
            show_products: true,
            show_promo_banner: false,
            promo_banner_text: '',
            promo_banner_url: '',
            promo_banner_image: '',
            
            // Social links
            instagram_url: '',
            instagram_embed: false,
            facebook_url: '',
            twitter_url: '',
            
            // Support
            support_email: '',
            support_phone: '',
            support_url: '',
            
            // Custom CSS
            custom_css: '',
            
            // Email settings
            email_from_name: 'Ma Boutique',
            email_from_address: 'noreply@maboutique.com',
            email_reply_to: '',
            email_logo_url: null,
            email_footer_text: '',
            
            // Notification settings
            notifications: {
                email: {
                    enabled: true,
                    events: ['label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception']
                },
                sms: {
                    enabled: false,
                    events: ['out_for_delivery', 'delivered']
                }
            }
        };
    }

    async saveBrandConfig(orgId, brandConfig) {
        await db.query(`
            INSERT INTO brand_settings (organization_id, name, logo_url, favicon_url, 
                primary_color, secondary_color, accent_color, background_color, text_color,
                font_family, border_radius, show_carrier_logo, show_estimated_delivery,
                show_map, show_products, show_promo_banner, promo_banner_text, promo_banner_url,
                promo_banner_image, instagram_url, instagram_embed, facebook_url, twitter_url,
                support_email, support_phone, support_url, custom_css, email_from_name,
                email_from_address, email_reply_to, email_logo_url, email_footer_text, notifications)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
            ON CONFLICT (organization_id) DO UPDATE SET
                name = EXCLUDED.name,
                logo_url = EXCLUDED.logo_url,
                favicon_url = EXCLUDED.favicon_url,
                primary_color = EXCLUDED.primary_color,
                secondary_color = EXCLUDED.secondary_color,
                accent_color = EXCLUDED.accent_color,
                background_color = EXCLUDED.background_color,
                text_color = EXCLUDED.text_color,
                font_family = EXCLUDED.font_family,
                border_radius = EXCLUDED.border_radius,
                show_carrier_logo = EXCLUDED.show_carrier_logo,
                show_estimated_delivery = EXCLUDED.show_estimated_delivery,
                show_map = EXCLUDED.show_map,
                show_products = EXCLUDED.show_products,
                show_promo_banner = EXCLUDED.show_promo_banner,
                promo_banner_text = EXCLUDED.promo_banner_text,
                promo_banner_url = EXCLUDED.promo_banner_url,
                promo_banner_image = EXCLUDED.promo_banner_image,
                instagram_url = EXCLUDED.instagram_url,
                instagram_embed = EXCLUDED.instagram_embed,
                facebook_url = EXCLUDED.facebook_url,
                twitter_url = EXCLUDED.twitter_url,
                support_email = EXCLUDED.support_email,
                support_phone = EXCLUDED.support_phone,
                support_url = EXCLUDED.support_url,
                custom_css = EXCLUDED.custom_css,
                email_from_name = EXCLUDED.email_from_name,
                email_from_address = EXCLUDED.email_from_address,
                email_reply_to = EXCLUDED.email_reply_to,
                email_logo_url = EXCLUDED.email_logo_url,
                email_footer_text = EXCLUDED.email_footer_text,
                notifications = EXCLUDED.notifications,
                updated_at = NOW()
        `, [orgId, brandConfig.name, brandConfig.logo_url, brandConfig.favicon_url,
            brandConfig.primary_color, brandConfig.secondary_color, brandConfig.accent_color,
            brandConfig.background_color, brandConfig.text_color, brandConfig.font_family,
            brandConfig.border_radius, brandConfig.show_carrier_logo, brandConfig.show_estimated_delivery,
            brandConfig.show_map, brandConfig.show_products, brandConfig.show_promo_banner,
            brandConfig.promo_banner_text, brandConfig.promo_banner_url, brandConfig.promo_banner_image,
            brandConfig.instagram_url, brandConfig.instagram_embed, brandConfig.facebook_url,
            brandConfig.twitter_url, brandConfig.support_email, brandConfig.support_phone,
            brandConfig.support_url, brandConfig.custom_css, brandConfig.email_from_name,
            brandConfig.email_from_address, brandConfig.email_reply_to, brandConfig.email_logo_url,
            brandConfig.email_footer_text, JSON.stringify(brandConfig.notifications)]);

        // Invalidate cache
        await redis.del(`brand:${orgId}`);
        
        return brandConfig;
    }

    // ----------------------------------------
    // TRACKING PAGE GENERATION
    // ----------------------------------------

    async generateTrackingPage(trackingNumber, options = {}) {
        const shipment = await this.getShipmentByTracking(trackingNumber);
        if (!shipment) {
            return this.generate404Page();
        }

        const brand = await this.getBrandConfig(shipment.organization_id);
        const lang = options.lang || this.detectLanguage(shipment) || config.defaultLanguage;
        const t = translations[lang] || translations.fr;

        // Get order details if available
        const order = shipment.order_id ? await this.getOrderDetails(shipment.order_id) : null;

        const templateData = {
            shipment,
            order,
            brand,
            lang,
            t,
            trackingUrl: `${config.baseUrl}/t/${trackingNumber}`,
            returnUrl: `${config.baseUrl}/returns/${shipment.organization_id}?order=${order?.order_number || ''}`,
            statusIcon: STATUS_ICONS[shipment.status],
            statusColor: STATUS_COLORS[shipment.status],
            progressPercent: this.getProgressPercent(shipment.status),
            events: this.formatTrackingEvents(shipment.tracking_events, lang),
            carrierLogo: this.getCarrierLogo(shipment.carrier),
            carrierName: this.getCarrierName(shipment.carrier),
            estimatedDeliveryFormatted: this.formatDate(shipment.estimated_delivery, lang),
            isDelivered: shipment.status === 'delivered',
            isException: shipment.status === 'exception',
            currentYear: new Date().getFullYear()
        };

        const template = await this.loadTemplate('tracking-page');
        return template(templateData);
    }

    async generateTrackingWidget(trackingNumber, options = {}) {
        const shipment = await this.getShipmentByTracking(trackingNumber);
        if (!shipment) return null;

        const brand = await this.getBrandConfig(shipment.organization_id);
        const lang = options.lang || config.defaultLanguage;
        const t = translations[lang] || translations.fr;

        const templateData = {
            shipment,
            brand,
            lang,
            t,
            statusIcon: STATUS_ICONS[shipment.status],
            statusColor: STATUS_COLORS[shipment.status],
            progressPercent: this.getProgressPercent(shipment.status),
            compact: options.compact || false
        };

        const template = await this.loadTemplate('tracking-widget');
        return template(templateData);
    }

    // ----------------------------------------
    // EMAIL NOTIFICATIONS
    // ----------------------------------------

    async sendTrackingEmail(shipmentId, eventType, options = {}) {
        const shipment = await this.getShipmentById(shipmentId);
        if (!shipment) throw new Error('Shipment not found');

        const brand = await this.getBrandConfig(shipment.organization_id);
        
        // Check if email notifications are enabled for this event
        if (!brand.notifications?.email?.enabled) return null;
        if (!brand.notifications?.email?.events?.includes(eventType)) return null;

        const recipientEmail = shipment.recipient_email;
        if (!recipientEmail) return null;

        const lang = this.detectLanguage(shipment) || config.defaultLanguage;
        const t = translations[lang] || translations.fr;

        // Get order details
        const order = shipment.order_id ? await this.getOrderDetails(shipment.order_id) : null;

        const subject = (t.email_subject[eventType] || t.email_subject.in_transit)
            .replace('{orderNumber}', order?.order_number || shipment.tracking_number);

        const templateData = {
            shipment,
            order,
            brand,
            lang,
            t,
            eventType,
            subject,
            trackingUrl: `${config.baseUrl}/t/${shipment.tracking_number}`,
            returnUrl: `${config.baseUrl}/returns/${shipment.organization_id}?order=${order?.order_number || ''}`,
            statusIcon: STATUS_ICONS[shipment.status],
            statusColor: STATUS_COLORS[shipment.status],
            progressPercent: this.getProgressPercent(shipment.status),
            carrierLogo: this.getCarrierLogo(shipment.carrier),
            carrierName: this.getCarrierName(shipment.carrier),
            estimatedDeliveryFormatted: this.formatDate(shipment.estimated_delivery, lang),
            isDelivered: shipment.status === 'delivered',
            preheader: this.getEmailPreheader(eventType, t, shipment),
            currentYear: new Date().getFullYear()
        };

        const template = await this.loadTemplate('tracking-email');
        const html = template(templateData);

        const mailOptions = {
            from: `"${brand.email_from_name}" <${brand.email_from_address}>`,
            replyTo: brand.email_reply_to || brand.support_email,
            to: recipientEmail,
            subject,
            html
        };

        try {
            const result = await this.mailer.sendMail(mailOptions);
            
            // Log email sent
            await this.logNotification({
                shipmentId,
                type: 'email',
                eventType,
                recipient: recipientEmail,
                status: 'sent',
                messageId: result.messageId
            });

            return result;
        } catch (error) {
            await this.logNotification({
                shipmentId,
                type: 'email',
                eventType,
                recipient: recipientEmail,
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    async sendTrackingSMS(shipmentId, eventType) {
        if (!this.smsClient) return null;

        const shipment = await this.getShipmentById(shipmentId);
        if (!shipment) throw new Error('Shipment not found');

        const brand = await this.getBrandConfig(shipment.organization_id);
        
        // Check if SMS notifications are enabled
        if (!brand.notifications?.sms?.enabled) return null;
        if (!brand.notifications?.sms?.events?.includes(eventType)) return null;

        const phone = shipment.recipient_phone;
        if (!phone) return null;

        const lang = this.detectLanguage(shipment) || config.defaultLanguage;
        const t = translations[lang] || translations.fr;

        const message = this.getSMSMessage(eventType, t, shipment, brand);
        const trackingUrl = `${config.baseUrl}/t/${shipment.tracking_number}`;

        try {
            const result = await this.smsClient.messages.create({
                body: `${message}\n${trackingUrl}`,
                from: config.sms.fromNumber,
                to: phone
            });

            await this.logNotification({
                shipmentId,
                type: 'sms',
                eventType,
                recipient: phone,
                status: 'sent',
                messageId: result.sid
            });

            return result;
        } catch (error) {
            await this.logNotification({
                shipmentId,
                type: 'sms',
                eventType,
                recipient: phone,
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    getSMSMessage(eventType, t, shipment, brand) {
        const messages = {
            out_for_delivery: `${brand.name}: ${t.status.out_for_delivery}! ${t.cta_track}:`,
            delivered: `${brand.name}: ${t.status.delivered}! Merci pour votre achat.`,
            exception: `${brand.name}: ${t.status.exception}. ${t.cta_help}:`
        };
        return messages[eventType] || `${brand.name}: Mise à jour de votre colis`;
    }

    getEmailPreheader(eventType, t, shipment) {
        const preheaders = {
            label_created: `Votre colis est en route ! N° de suivi: ${shipment.tracking_number}`,
            in_transit: `Votre colis est actuellement en cours d'acheminement`,
            out_for_delivery: `Préparez-vous, votre colis arrive aujourd'hui !`,
            delivered: `Votre colis a bien été livré. Merci pour votre confiance !`,
            exception: `Attention, un incident a été signalé sur votre livraison`
        };
        return preheaders[eventType] || `Mise à jour de votre commande`;
    }

    // ----------------------------------------
    // HELPER METHODS
    // ----------------------------------------

    async getShipmentByTracking(trackingNumber) {
        const result = await db.query(
            `SELECT s.*, o.order_number, o.items as order_items, o.total as order_total
             FROM shipments s
             LEFT JOIN orders o ON s.order_id = o.id
             WHERE s.tracking_number = $1`,
            [trackingNumber]
        );
        return result.rows[0];
    }

    async getShipmentById(shipmentId) {
        const result = await db.query(
            `SELECT s.*, o.order_number, o.items as order_items, o.total as order_total
             FROM shipments s
             LEFT JOIN orders o ON s.order_id = o.id
             WHERE s.id = $1`,
            [shipmentId]
        );
        return result.rows[0];
    }

    async getOrderDetails(orderId) {
        const result = await db.query(
            `SELECT * FROM orders WHERE id = $1`,
            [orderId]
        );
        return result.rows[0];
    }

    async loadTemplate(templateName) {
        if (this.templateCache.has(templateName)) {
            return this.templateCache.get(templateName);
        }

        const templatePath = path.join(__dirname, '..', 'templates', `${templateName}.hbs`);
        const templateSource = await fs.readFile(templatePath, 'utf-8');
        const template = Handlebars.compile(templateSource);
        
        this.templateCache.set(templateName, template);
        return template;
    }

    detectLanguage(shipment) {
        // Detect from country code
        const countryLang = {
            'FR': 'fr', 'BE': 'fr', 'CH': 'fr', 'LU': 'fr', 'MC': 'fr',
            'DE': 'de', 'AT': 'de',
            'ES': 'es', 'MX': 'es', 'AR': 'es',
            'IT': 'it',
            'NL': 'nl',
            'PT': 'pt', 'BR': 'pt',
            'PL': 'pl',
            'GB': 'en', 'US': 'en', 'CA': 'en', 'AU': 'en', 'IE': 'en'
        };
        return countryLang[shipment.recipient_country] || 'en';
    }

    formatDate(date, lang) {
        if (!date) return '';
        const d = new Date(date);
        const options = { weekday: 'long', day: 'numeric', month: 'long' };
        const locale = `${lang}-${lang.toUpperCase()}`;
        try {
            return d.toLocaleDateString(locale, options);
        } catch {
            return d.toLocaleDateString('fr-FR', options);
        }
    }

    formatTrackingEvents(events, lang) {
        if (!events || !Array.isArray(events)) return [];
        return events.map(event => ({
            ...event,
            formattedDate: this.formatDate(event.timestamp, lang),
            formattedTime: new Date(event.timestamp).toLocaleTimeString(
                `${lang}-${lang.toUpperCase()}`, 
                { hour: '2-digit', minute: '2-digit' }
            ),
            icon: STATUS_ICONS[event.status] || '📍'
        })).reverse();
    }

    getProgressPercent(status) {
        const progress = {
            pending: 10,
            label_created: 20,
            picked_up: 35,
            in_transit: 60,
            out_for_delivery: 85,
            delivered: 100,
            exception: 70,
            returned: 100,
            cancelled: 0
        };
        return progress[status] || 0;
    }

    getCarrierLogo(carrier) {
        const logos = {
            colissimo: 'https://cdn.routz.io/carriers/colissimo.svg',
            chronopost: 'https://cdn.routz.io/carriers/chronopost.svg',
            mondial_relay: 'https://cdn.routz.io/carriers/mondial-relay.svg',
            dhl: 'https://cdn.routz.io/carriers/dhl.svg',
            ups: 'https://cdn.routz.io/carriers/ups.svg',
            fedex: 'https://cdn.routz.io/carriers/fedex.svg',
            gls: 'https://cdn.routz.io/carriers/gls.svg',
            dpd: 'https://cdn.routz.io/carriers/dpd.svg',
            colis_prive: 'https://cdn.routz.io/carriers/colis-prive.svg'
        };
        return logos[carrier] || 'https://cdn.routz.io/carriers/default.svg';
    }

    getCarrierName(carrier) {
        const names = {
            colissimo: 'Colissimo',
            chronopost: 'Chronopost',
            mondial_relay: 'Mondial Relay',
            dhl: 'DHL',
            ups: 'UPS',
            fedex: 'FedEx',
            gls: 'GLS',
            dpd: 'DPD',
            colis_prive: 'Colis Privé'
        };
        return names[carrier] || carrier;
    }

    async logNotification(data) {
        await db.query(`
            INSERT INTO notification_logs (shipment_id, type, event_type, recipient, status, message_id, error, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [data.shipmentId, data.type, data.eventType, data.recipient, data.status, data.messageId || null, data.error || null]);
    }

    generate404Page() {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Suivi introuvable</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: system-ui, sans-serif; 
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
            padding: 20px;
        }
        .container { max-width: 400px; }
        h1 { font-size: 120px; font-weight: 800; opacity: 0.3; }
        h2 { font-size: 24px; margin: 20px 0; }
        p { opacity: 0.8; line-height: 1.6; }
        .btn {
            display: inline-block;
            margin-top: 30px;
            padding: 14px 28px;
            background: white;
            color: #764ba2;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <h2>Suivi introuvable</h2>
        <p>Ce numéro de suivi n'existe pas ou a expiré. Vérifiez le numéro et réessayez.</p>
        <a href="/" class="btn">Retour à l'accueil</a>
    </div>
</body>
</html>`;
    }
}

// ============================================
// WEBHOOK HANDLER FOR STATUS UPDATES
// ============================================

class TrackingWebhookHandler {
    constructor(trackingService) {
        this.trackingService = trackingService;
    }

    async handleStatusUpdate(shipmentId, newStatus, eventData = {}) {
        // Update shipment status
        await db.query(`
            UPDATE shipments 
            SET status = $1, 
                last_tracking_update = NOW(),
                tracking_events = tracking_events || $2::jsonb,
                updated_at = NOW()
            WHERE id = $3
        `, [newStatus, JSON.stringify([{
            timestamp: new Date().toISOString(),
            status: newStatus,
            description: eventData.description || '',
            location: eventData.location || ''
        }]), shipmentId]);

        // Trigger notifications
        const notificationEvents = ['label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];
        
        if (notificationEvents.includes(newStatus)) {
            // Send email (async, don't wait)
            this.trackingService.sendTrackingEmail(shipmentId, newStatus).catch(console.error);
            
            // Send SMS for important events
            if (['out_for_delivery', 'delivered', 'exception'].includes(newStatus)) {
                this.trackingService.sendTrackingSMS(shipmentId, newStatus).catch(console.error);
            }
        }

        return { success: true, status: newStatus };
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    BrandedTrackingService,
    TrackingWebhookHandler,
    translations,
    STATUS_ICONS,
    STATUS_COLORS,
    SUPPORTED_LANGUAGES
};
