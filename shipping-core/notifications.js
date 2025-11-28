/**
 * ROUTZ - Notifications Service
 * SMS, WhatsApp et Push notifications via Twilio et autres providers
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const Twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// ============================================
// NOTIFICATION TEMPLATES
// ============================================

const NOTIFICATION_TEMPLATES = {
    // SMS Templates (max 160 chars for single SMS, or 1600 for long SMS)
    sms: {
        fr: {
            label_created: '📦 {brand}: Votre commande {order} a été expédiée! Suivi: {tracking_url}',
            picked_up: '🚚 {brand}: Votre colis {tracking} est en route vers {city}. Suivi: {tracking_url}',
            in_transit: '🚛 {brand}: Votre colis est en cours d\'acheminement. Livraison prévue: {eta}',
            out_for_delivery: '🛵 {brand}: Votre colis arrive aujourd\'hui! Restez disponible. Suivi: {tracking_url}',
            delivered: '✅ {brand}: Votre colis a été livré! Merci pour votre commande.',
            delivery_attempt: '⚠️ {brand}: Tentative de livraison échouée. Nouvelle tentative demain ou récupérez en: {pickup_point}',
            exception: '⚠️ {brand}: Un problème avec votre livraison. Contactez-nous: {support_url}',
            pickup_ready: '📍 {brand}: Votre colis vous attend chez {pickup_name}. Récupérez-le avant le {deadline}.',
            return_received: '↩️ {brand}: Votre retour {rma} a été reçu. Remboursement sous 5-7 jours.',
            return_refunded: '💰 {brand}: Votre remboursement de {amount}€ a été effectué pour le retour {rma}.'
        },
        en: {
            label_created: '📦 {brand}: Your order {order} has been shipped! Track: {tracking_url}',
            picked_up: '🚚 {brand}: Your package {tracking} is on its way to {city}. Track: {tracking_url}',
            in_transit: '🚛 {brand}: Your package is in transit. Expected delivery: {eta}',
            out_for_delivery: '🛵 {brand}: Your package arrives today! Please be available. Track: {tracking_url}',
            delivered: '✅ {brand}: Your package has been delivered! Thank you for your order.',
            delivery_attempt: '⚠️ {brand}: Delivery attempt failed. Retry tomorrow or pick up at: {pickup_point}',
            exception: '⚠️ {brand}: An issue with your delivery. Contact us: {support_url}',
            pickup_ready: '📍 {brand}: Your package is waiting at {pickup_name}. Pick up before {deadline}.',
            return_received: '↩️ {brand}: Your return {rma} has been received. Refund in 5-7 days.',
            return_refunded: '💰 {brand}: Your refund of {amount}€ has been processed for return {rma}.'
        },
        de: {
            label_created: '📦 {brand}: Ihre Bestellung {order} wurde versandt! Tracking: {tracking_url}',
            out_for_delivery: '🛵 {brand}: Ihr Paket kommt heute! Bitte verfügbar sein. Tracking: {tracking_url}',
            delivered: '✅ {brand}: Ihr Paket wurde zugestellt! Vielen Dank für Ihre Bestellung.'
        },
        es: {
            label_created: '📦 {brand}: ¡Su pedido {order} ha sido enviado! Seguimiento: {tracking_url}',
            out_for_delivery: '🛵 {brand}: ¡Su paquete llega hoy! Esté disponible. Seguimiento: {tracking_url}',
            delivered: '✅ {brand}: ¡Su paquete ha sido entregado! Gracias por su pedido.'
        }
    },
    
    // WhatsApp Templates (must be pre-approved by Meta)
    whatsapp: {
        fr: {
            label_created: {
                templateName: 'shipping_confirmation_fr',
                components: [
                    { type: 'header', parameters: [{ type: 'image', image: { link: '{brand_logo}' } }] },
                    { type: 'body', parameters: [
                        { type: 'text', text: '{customer_name}' },
                        { type: 'text', text: '{order}' },
                        { type: 'text', text: '{carrier}' },
                        { type: 'text', text: '{tracking}' }
                    ]},
                    { type: 'button', sub_type: 'url', index: 0, parameters: [
                        { type: 'text', text: '{tracking_id}' }
                    ]}
                ]
            },
            out_for_delivery: {
                templateName: 'out_for_delivery_fr',
                components: [
                    { type: 'body', parameters: [
                        { type: 'text', text: '{customer_name}' },
                        { type: 'text', text: '{time_window}' }
                    ]}
                ]
            },
            delivered: {
                templateName: 'delivered_confirmation_fr',
                components: [
                    { type: 'body', parameters: [
                        { type: 'text', text: '{customer_name}' }
                    ]},
                    { type: 'button', sub_type: 'url', index: 0, parameters: [
                        { type: 'text', text: '{review_link}' }
                    ]}
                ]
            }
        },
        en: {
            label_created: {
                templateName: 'shipping_confirmation_en',
                components: [
                    { type: 'body', parameters: [
                        { type: 'text', text: '{customer_name}' },
                        { type: 'text', text: '{order}' },
                        { type: 'text', text: '{carrier}' },
                        { type: 'text', text: '{tracking}' }
                    ]}
                ]
            }
        }
    },
    
    // Push notification templates
    push: {
        fr: {
            label_created: {
                title: '📦 Commande expédiée!',
                body: 'Votre commande {order} est en route.',
                icon: 'shipping',
                action: '{tracking_url}'
            },
            out_for_delivery: {
                title: '🛵 Livraison aujourd\'hui!',
                body: 'Votre colis arrive aujourd\'hui. Restez disponible!',
                icon: 'delivery',
                action: '{tracking_url}'
            },
            delivered: {
                title: '✅ Colis livré!',
                body: 'Votre colis a été livré avec succès.',
                icon: 'success',
                action: '{tracking_url}'
            }
        }
    }
};

// ============================================
// NOTIFICATION SERVICE
// ============================================

class NotificationService {
    constructor() {
        // Initialize Twilio
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
            this.twilio = new Twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
        }
        
        // WhatsApp Business API config
        this.whatsappConfig = {
            baseUrl: 'https://graph.facebook.com/v18.0',
            phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            accessToken: process.env.WHATSAPP_ACCESS_TOKEN
        };
        
        // Firebase for push notifications
        this.firebaseConfig = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT
        };
    }

    // ----------------------------------------
    // MAIN NOTIFICATION METHODS
    // ----------------------------------------

    /**
     * Send notification based on event type
     */
    async sendNotification(params) {
        const {
            orgId,
            eventType,
            channels = ['sms'], // ['sms', 'whatsapp', 'push', 'email']
            recipient,
            data,
            priority = 'normal',
            scheduledAt
        } = params;

        // Get organization notification settings
        const settings = await this.getNotificationSettings(orgId);
        
        // Check if event type is enabled
        const enabledChannels = channels.filter(channel => {
            const channelConfig = settings[channel];
            return channelConfig?.enabled && channelConfig?.events?.includes(eventType);
        });

        if (enabledChannels.length === 0) {
            return { sent: false, reason: 'No enabled channels for this event' };
        }

        // Get brand config for templates
        const brand = await this.getBrandConfig(orgId);
        
        // Prepare template data
        const templateData = {
            ...data,
            brand: brand.name,
            brand_logo: brand.logo_url,
            support_url: brand.support_url || `https://${brand.domain}/support`,
            tracking_url: data.tracking_url || `${process.env.BASE_URL}/t/${data.tracking}`
        };

        // Send to each channel
        const results = await Promise.allSettled(
            enabledChannels.map(channel => 
                this.sendToChannel(channel, {
                    orgId,
                    eventType,
                    recipient,
                    data: templateData,
                    settings,
                    priority,
                    scheduledAt
                })
            )
        );

        // Log notifications
        const logs = results.map((result, i) => ({
            channel: enabledChannels[i],
            status: result.status === 'fulfilled' ? 'sent' : 'failed',
            messageId: result.value?.messageId,
            error: result.reason?.message
        }));

        await this.logNotifications(orgId, eventType, recipient, logs, data);

        return {
            sent: results.some(r => r.status === 'fulfilled'),
            channels: logs
        };
    }

    /**
     * Send to specific channel
     */
    async sendToChannel(channel, params) {
        switch (channel) {
            case 'sms':
                return this.sendSMS(params);
            case 'whatsapp':
                return this.sendWhatsApp(params);
            case 'push':
                return this.sendPush(params);
            default:
                throw new Error(`Unknown channel: ${channel}`);
        }
    }

    // ----------------------------------------
    // SMS
    // ----------------------------------------

    async sendSMS(params) {
        const { orgId, eventType, recipient, data, settings, priority, scheduledAt } = params;
        
        if (!this.twilio) {
            throw new Error('Twilio not configured');
        }

        // Get phone number
        const phone = this.normalizePhoneNumber(recipient.phone, recipient.country);
        if (!phone) {
            throw new Error('Invalid phone number');
        }

        // Get template
        const lang = recipient.lang || 'fr';
        const template = NOTIFICATION_TEMPLATES.sms[lang]?.[eventType] || 
                        NOTIFICATION_TEMPLATES.sms.en[eventType];
        
        if (!template) {
            throw new Error(`No SMS template for event: ${eventType}`);
        }

        // Render message
        const message = this.renderTemplate(template, data);

        // Get sender ID
        const senderId = settings.sms?.senderId || process.env.TWILIO_PHONE_NUMBER;

        // Send via Twilio
        const twilioParams = {
            body: message,
            to: phone,
            from: senderId
        };

        // Add messaging service SID if available (for better deliverability)
        if (settings.sms?.messagingServiceSid) {
            twilioParams.messagingServiceSid = settings.sms.messagingServiceSid;
            delete twilioParams.from;
        }

        // Schedule if needed
        if (scheduledAt) {
            twilioParams.scheduleType = 'fixed';
            twilioParams.sendAt = new Date(scheduledAt).toISOString();
        }

        const result = await this.twilio.messages.create(twilioParams);

        return {
            messageId: result.sid,
            status: result.status,
            channel: 'sms'
        };
    }

    /**
     * Send bulk SMS
     */
    async sendBulkSMS(params) {
        const { orgId, eventType, recipients, data, settings } = params;
        
        const results = await Promise.allSettled(
            recipients.map(recipient => 
                this.sendSMS({
                    orgId,
                    eventType,
                    recipient,
                    data: { ...data, ...recipient.data },
                    settings
                })
            )
        );

        return {
            total: recipients.length,
            sent: results.filter(r => r.status === 'fulfilled').length,
            failed: results.filter(r => r.status === 'rejected').length,
            results
        };
    }

    // ----------------------------------------
    // WHATSAPP
    // ----------------------------------------

    async sendWhatsApp(params) {
        const { orgId, eventType, recipient, data, settings } = params;
        
        if (!this.whatsappConfig.accessToken) {
            throw new Error('WhatsApp not configured');
        }

        // Get phone number
        const phone = this.normalizePhoneNumber(recipient.phone, recipient.country, 'whatsapp');
        if (!phone) {
            throw new Error('Invalid phone number');
        }

        // Get template
        const lang = recipient.lang || 'fr';
        const templateConfig = NOTIFICATION_TEMPLATES.whatsapp[lang]?.[eventType] ||
                              NOTIFICATION_TEMPLATES.whatsapp.en?.[eventType];
        
        if (!templateConfig) {
            throw new Error(`No WhatsApp template for event: ${eventType}`);
        }

        // Prepare components with data
        const components = this.prepareWhatsAppComponents(templateConfig.components, data);

        // Send via WhatsApp Business API
        const response = await axios.post(
            `${this.whatsappConfig.baseUrl}/${this.whatsappConfig.phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: phone,
                type: 'template',
                template: {
                    name: templateConfig.templateName,
                    language: { code: lang === 'fr' ? 'fr' : 'en' },
                    components
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.whatsappConfig.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            messageId: response.data.messages?.[0]?.id,
            status: 'sent',
            channel: 'whatsapp'
        };
    }

    /**
     * Send interactive WhatsApp message (not template)
     */
    async sendWhatsAppInteractive(params) {
        const { recipient, message, buttons } = params;
        
        const phone = this.normalizePhoneNumber(recipient.phone, recipient.country, 'whatsapp');
        
        const response = await axios.post(
            `${this.whatsappConfig.baseUrl}/${this.whatsappConfig.phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: phone,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: message },
                    action: {
                        buttons: buttons.map((btn, i) => ({
                            type: 'reply',
                            reply: { id: btn.id || `btn_${i}`, title: btn.title }
                        }))
                    }
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.whatsappConfig.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            messageId: response.data.messages?.[0]?.id,
            status: 'sent'
        };
    }

    prepareWhatsAppComponents(components, data) {
        return components.map(comp => {
            if (!comp.parameters) return comp;
            
            return {
                ...comp,
                parameters: comp.parameters.map(param => {
                    if (param.type === 'text' && param.text) {
                        return {
                            ...param,
                            text: this.renderTemplate(param.text, data)
                        };
                    }
                    if (param.type === 'image' && param.image?.link) {
                        return {
                            ...param,
                            image: { link: this.renderTemplate(param.image.link, data) }
                        };
                    }
                    return param;
                })
            };
        });
    }

    // ----------------------------------------
    // PUSH NOTIFICATIONS
    // ----------------------------------------

    async sendPush(params) {
        const { orgId, eventType, recipient, data, settings } = params;
        
        // Get push tokens for recipient
        const tokens = await this.getPushTokens(orgId, recipient.customerId || recipient.email);
        
        if (tokens.length === 0) {
            throw new Error('No push tokens found for recipient');
        }

        // Get template
        const lang = recipient.lang || 'fr';
        const template = NOTIFICATION_TEMPLATES.push[lang]?.[eventType] ||
                        NOTIFICATION_TEMPLATES.push.en?.[eventType];
        
        if (!template) {
            throw new Error(`No push template for event: ${eventType}`);
        }

        // Render notification
        const notification = {
            title: this.renderTemplate(template.title, data),
            body: this.renderTemplate(template.body, data),
            icon: template.icon,
            click_action: this.renderTemplate(template.action, data),
            data: {
                eventType,
                ...data
            }
        };

        // Send via Firebase Cloud Messaging
        const results = await this.sendFCM(tokens, notification);

        return {
            messageId: results.successCount > 0 ? uuidv4() : null,
            status: results.successCount > 0 ? 'sent' : 'failed',
            successCount: results.successCount,
            failureCount: results.failureCount,
            channel: 'push'
        };
    }

    async sendFCM(tokens, notification) {
        // Using Firebase Admin SDK would be better, but here's HTTP API version
        const response = await axios.post(
            'https://fcm.googleapis.com/fcm/send',
            {
                registration_ids: tokens,
                notification: {
                    title: notification.title,
                    body: notification.body,
                    icon: notification.icon,
                    click_action: notification.click_action
                },
                data: notification.data
            },
            {
                headers: {
                    'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            successCount: response.data.success,
            failureCount: response.data.failure,
            results: response.data.results
        };
    }

    async getPushTokens(orgId, identifier) {
        const result = await db.query(`
            SELECT token FROM push_tokens
            WHERE organization_id = $1 
            AND (customer_id = $2 OR customer_email = $2)
            AND active = true
        `, [orgId, identifier]);
        
        return result.rows.map(r => r.token);
    }

    // ----------------------------------------
    // DELIVERY WINDOW NOTIFICATIONS
    // ----------------------------------------

    /**
     * Send delivery time window notification
     * Called when carrier provides estimated delivery window
     */
    async sendDeliveryWindowNotification(params) {
        const {
            orgId,
            shipmentId,
            recipient,
            deliveryWindow, // { start: '09:00', end: '12:00', date: '2024-01-15' }
            carrier
        } = params;

        const settings = await this.getNotificationSettings(orgId);
        
        // Check if delivery window notifications are enabled
        if (!settings.sms?.events?.includes('delivery_window') &&
            !settings.whatsapp?.events?.includes('delivery_window')) {
            return { sent: false, reason: 'Delivery window notifications disabled' };
        }

        const data = {
            time_window: `${deliveryWindow.start} - ${deliveryWindow.end}`,
            delivery_date: deliveryWindow.date,
            carrier
        };

        return this.sendNotification({
            orgId,
            eventType: 'out_for_delivery',
            channels: ['sms', 'whatsapp'],
            recipient,
            data
        });
    }

    /**
     * Schedule reminder notifications
     */
    async schedulePickupReminder(params) {
        const {
            orgId,
            shipmentId,
            recipient,
            pickupPoint,
            deadline
        } = params;

        // Schedule reminder 2 days before deadline
        const reminderDate = new Date(deadline);
        reminderDate.setDate(reminderDate.getDate() - 2);
        
        if (reminderDate <= new Date()) {
            // Deadline is too close, send immediately
            return this.sendNotification({
                orgId,
                eventType: 'pickup_ready',
                channels: ['sms'],
                recipient,
                data: {
                    pickup_name: pickupPoint.name,
                    pickup_address: pickupPoint.address,
                    deadline: new Date(deadline).toLocaleDateString('fr-FR')
                }
            });
        }

        // Schedule for later
        await db.query(`
            INSERT INTO scheduled_notifications 
            (organization_id, shipment_id, event_type, recipient, data, scheduled_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            orgId,
            shipmentId,
            'pickup_reminder',
            JSON.stringify(recipient),
            JSON.stringify({
                pickup_name: pickupPoint.name,
                deadline: new Date(deadline).toLocaleDateString('fr-FR')
            }),
            reminderDate
        ]);

        return { scheduled: true, scheduledAt: reminderDate };
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    normalizePhoneNumber(phone, country = 'FR', format = 'e164') {
        if (!phone) return null;
        
        // Remove all non-digit characters
        let cleaned = phone.replace(/\D/g, '');
        
        // Country codes
        const countryCodes = {
            FR: '33', DE: '49', GB: '44', ES: '34', IT: '39',
            BE: '32', NL: '31', PT: '351', CH: '41', AT: '43',
            US: '1', CA: '1'
        };
        
        const countryCode = countryCodes[country] || '33';
        
        // Handle French numbers
        if (country === 'FR') {
            if (cleaned.startsWith('0')) {
                cleaned = countryCode + cleaned.substring(1);
            } else if (!cleaned.startsWith('33')) {
                cleaned = countryCode + cleaned;
            }
        }
        
        // Ensure starts with country code
        if (!cleaned.startsWith(countryCode) && !cleaned.startsWith('00')) {
            cleaned = countryCode + cleaned;
        }
        
        // Format
        if (format === 'whatsapp') {
            return cleaned; // WhatsApp uses numbers without +
        }
        
        return '+' + cleaned;
    }

    renderTemplate(template, data) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    async getNotificationSettings(orgId) {
        const cacheKey = `notif_settings:${orgId}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
        
        const result = await db.query(
            'SELECT notification_settings FROM organization_settings WHERE organization_id = $1',
            [orgId]
        );
        
        const settings = result.rows[0]?.notification_settings || this.getDefaultSettings();
        await redis.setex(cacheKey, 3600, JSON.stringify(settings));
        
        return settings;
    }

    getDefaultSettings() {
        return {
            sms: {
                enabled: true,
                events: ['out_for_delivery', 'delivered', 'exception'],
                senderId: null
            },
            whatsapp: {
                enabled: false,
                events: ['label_created', 'out_for_delivery', 'delivered']
            },
            push: {
                enabled: false,
                events: ['out_for_delivery', 'delivered']
            }
        };
    }

    async getBrandConfig(orgId) {
        const result = await db.query(
            'SELECT * FROM brand_settings WHERE organization_id = $1',
            [orgId]
        );
        
        return result.rows[0] || { name: 'Routz', domain: 'routz.io' };
    }

    async logNotifications(orgId, eventType, recipient, channels, data) {
        const logs = channels.map(ch => ({
            id: uuidv4(),
            organization_id: orgId,
            type: ch.channel,
            event_type: eventType,
            recipient: recipient.phone || recipient.email,
            status: ch.status,
            message_id: ch.messageId,
            error: ch.error,
            metadata: JSON.stringify(data),
            created_at: new Date()
        }));

        if (logs.length > 0) {
            const values = logs.map((_, i) => 
                `($${i*8+1}, $${i*8+2}, $${i*8+3}, $${i*8+4}, $${i*8+5}, $${i*8+6}, $${i*8+7}, $${i*8+8})`
            ).join(', ');
            
            const params = logs.flatMap(l => [
                l.id, l.organization_id, l.type, l.event_type,
                l.recipient, l.status, l.message_id, l.error
            ]);

            await db.query(`
                INSERT INTO notification_logs 
                (id, organization_id, type, event_type, recipient, status, message_id, error)
                VALUES ${values}
            `, params);
        }
    }

    // ----------------------------------------
    // WEBHOOK HANDLERS
    // ----------------------------------------

    /**
     * Handle Twilio delivery status webhook
     */
    async handleTwilioWebhook(data) {
        const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = data;
        
        await db.query(`
            UPDATE notification_logs 
            SET status = $1, 
                error = $2,
                delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
                metadata = metadata || $3
            WHERE message_id = $4
        `, [
            MessageStatus,
            ErrorMessage,
            JSON.stringify({ errorCode: ErrorCode }),
            MessageSid
        ]);

        return { success: true };
    }

    /**
     * Handle WhatsApp webhook
     */
    async handleWhatsAppWebhook(data) {
        // Handle status updates
        if (data.entry?.[0]?.changes?.[0]?.value?.statuses) {
            const status = data.entry[0].changes[0].value.statuses[0];
            
            await db.query(`
                UPDATE notification_logs 
                SET status = $1,
                    delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
                WHERE message_id = $2
            `, [status.status, status.id]);
        }

        // Handle incoming messages (customer replies)
        if (data.entry?.[0]?.changes?.[0]?.value?.messages) {
            const message = data.entry[0].changes[0].value.messages[0];
            
            // Store incoming message
            await db.query(`
                INSERT INTO whatsapp_incoming (
                    message_id, from_number, message_type, message_body, timestamp
                ) VALUES ($1, $2, $3, $4, $5)
            `, [
                message.id,
                message.from,
                message.type,
                message.text?.body || JSON.stringify(message),
                new Date(parseInt(message.timestamp) * 1000)
            ]);

            // Trigger any automated responses
            await this.handleIncomingWhatsApp(message);
        }

        return { success: true };
    }

    async handleIncomingWhatsApp(message) {
        // Auto-responses based on message content
        const body = message.text?.body?.toLowerCase() || '';
        
        if (body.includes('suivi') || body.includes('track')) {
            // Customer asking about tracking - could send tracking link
        }
        
        if (body.includes('retour') || body.includes('return')) {
            // Customer asking about returns
        }
        
        // Log for manual review if no auto-response
    }
}

// ============================================
// CRON JOB FOR SCHEDULED NOTIFICATIONS
// ============================================

async function processScheduledNotifications() {
    const service = new NotificationService();
    
    const result = await db.query(`
        SELECT * FROM scheduled_notifications
        WHERE scheduled_at <= NOW()
        AND sent = false
        AND attempts < 3
        ORDER BY scheduled_at ASC
        LIMIT 100
    `);

    for (const notification of result.rows) {
        try {
            await service.sendNotification({
                orgId: notification.organization_id,
                eventType: notification.event_type,
                channels: ['sms'],
                recipient: JSON.parse(notification.recipient),
                data: JSON.parse(notification.data)
            });

            await db.query(
                'UPDATE scheduled_notifications SET sent = true, sent_at = NOW() WHERE id = $1',
                [notification.id]
            );
        } catch (error) {
            await db.query(
                'UPDATE scheduled_notifications SET attempts = attempts + 1, last_error = $1 WHERE id = $2',
                [error.message, notification.id]
            );
        }
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    NotificationService,
    NOTIFICATION_TEMPLATES,
    processScheduledNotifications
};
