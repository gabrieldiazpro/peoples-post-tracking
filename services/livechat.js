/**
 * Routz v4.0 - Customer Support Chat Service v2
 * Chat en direct, chatbot IA, ticketing, historique client, CSAT
 */

const { EventEmitter } = require('events');

class LiveChatService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.db = config.db;
        this.ai = config.aiService;
        this.notifications = config.notifications;
        this.maxConcurrentChats = config.maxConcurrentChats || 5;
    }

    // ==========================================
    // CONVERSATIONS
    // ==========================================

    async createConversation(data) {
        const conversation = {
            id: `CONV_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`,
            organizationId: data.organizationId,
            customerId: data.customerId,
            customerEmail: data.customerEmail,
            customerName: data.customerName,
            channel: data.channel || 'widget',
            subject: data.subject,
            status: 'open',
            priority: data.priority || 'normal',
            assignedTo: null,
            relatedShipmentId: data.shipmentId,
            relatedOrderId: data.orderId,
            createdAt: new Date().toISOString(),
            firstResponseAt: null,
            resolvedAt: null,
            satisfactionScore: null
        };

        await this.db.query(
            `INSERT INTO conversations (id, organization_id, customer_id, customer_email, customer_name, channel, subject, status, priority, related_shipment_id, related_order_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [conversation.id, conversation.organizationId, conversation.customerId, conversation.customerEmail, 
             conversation.customerName, conversation.channel, conversation.subject, conversation.status,
             conversation.priority, conversation.relatedShipmentId, conversation.relatedOrderId, conversation.createdAt]
        );

        await this.sendBotMessage(conversation.id, this.getWelcomeMessage(conversation));
        this.emit('conversation:created', conversation);
        return conversation;
    }

    async sendMessage(conversationId, data) {
        const message = {
            id: `MSG_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`,
            conversationId,
            type: data.type || 'text',
            content: data.content,
            sender: data.sender,
            senderName: data.senderName,
            senderId: data.senderId,
            attachments: data.attachments || [],
            metadata: data.metadata || {},
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO messages (id, conversation_id, type, content, sender, sender_name, sender_id, attachments, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [message.id, message.conversationId, message.type, message.content, message.sender,
             message.senderName, message.senderId, JSON.stringify(message.attachments), message.createdAt]
        );

        this.emit('message:sent', { conversationId, message });

        if (data.sender === 'customer') {
            await this.handleBotResponse(conversationId, message);
        }

        return message;
    }

    // ==========================================
    // AI CHATBOT
    // ==========================================

    async handleBotResponse(conversationId, customerMessage) {
        const conversation = await this.getConversation(conversationId);
        const intent = this.detectIntent(customerMessage.content);

        let response;
        switch (intent.type) {
            case 'tracking':
                response = await this.handleTrackingQuery(conversation);
                break;
            case 'return':
                response = this.handleReturnQuery(conversation);
                break;
            case 'delivery_date':
                response = await this.handleDeliveryDateQuery(conversation);
                break;
            case 'complaint':
                response = this.handleComplaintQuery();
                await this.escalateToAgent(conversationId, 'Réclamation client');
                break;
            case 'agent':
                response = { text: 'Je vous mets en relation avec un conseiller. Merci de patienter...' };
                await this.escalateToAgent(conversationId, 'Demande client');
                break;
            default:
                response = this.getDefaultResponse();
        }

        setTimeout(async () => {
            await this.sendBotMessage(conversationId, response);
        }, 1000);
    }

    detectIntent(message) {
        const lower = message.toLowerCase();
        const patterns = {
            tracking: /o[uù]\s*(est|en est)|suivi|tracking|colis|statut/i,
            return: /retour|renvoi|retourner|rembours/i,
            delivery_date: /quand|date|délai|arriver|recevoir/i,
            complaint: /problème|réclamation|plainte|erreur|cassé|endommagé/i,
            agent: /agent|humain|conseiller|parler/i
        };

        for (const [type, pattern] of Object.entries(patterns)) {
            if (pattern.test(lower)) return { type, confidence: 0.85 };
        }
        return { type: 'general', confidence: 0.5 };
    }

    async handleTrackingQuery(conversation) {
        if (!conversation.related_shipment_id) {
            return {
                text: "Je vais vous aider à suivre votre colis. Pouvez-vous me donner votre numéro de commande ou de suivi ?",
                quickReplies: ["J'ai mon numéro de suivi", "J'ai mon numéro de commande"]
            };
        }

        const shipment = await this.getShipmentInfo(conversation.related_shipment_id);
        if (!shipment) return { text: "Je n'ai pas trouvé d'expédition associée." };

        const statusMessages = {
            'pending': `📦 Votre commande est en cours de préparation.`,
            'shipped': `📬 Votre colis a été expédié ! Suivi: ${shipment.tracking_number}`,
            'in_transit': `🚚 Votre colis est en transit. Livraison prévue le ${this.formatDate(shipment.estimated_delivery)}.`,
            'out_for_delivery': `🎉 Bonne nouvelle ! Votre colis est en cours de livraison.`,
            'delivered': `✅ Votre colis a été livré le ${this.formatDate(shipment.delivered_at)}.`,
            'exception': `⚠️ Un problème est survenu. Un agent va vous contacter.`
        };

        return {
            text: statusMessages[shipment.status] || `Statut: ${shipment.status}`,
            quickReplies: shipment.status === 'in_transit' ? ['Modifier l\'adresse', 'Parler à un agent'] : null
        };
    }

    handleReturnQuery(conversation) {
        return {
            text: `Je peux vous aider à créer un retour. Voici les étapes:

1️⃣ Sélectionnez les articles à retourner
2️⃣ Indiquez le motif du retour  
3️⃣ Imprimez l'étiquette de retour gratuite
4️⃣ Déposez le colis en point relais

Voulez-vous commencer ?`,
            quickReplies: ['Oui, créer un retour', 'Non merci', 'Parler à un agent'],
            actions: conversation.related_order_id ? [{
                type: 'link',
                label: 'Créer un retour',
                url: `/returns/create?order=${conversation.related_order_id}`
            }] : null
        };
    }

    async handleDeliveryDateQuery(conversation) {
        if (!conversation.related_shipment_id) {
            return { text: "Pour une date de livraison estimée, j'ai besoin de votre numéro de commande." };
        }

        const shipment = await this.getShipmentInfo(conversation.related_shipment_id);
        if (!shipment) return { text: "Je n'ai pas trouvé d'information sur cette expédition." };

        if (shipment.status === 'delivered') {
            return { text: `✅ Votre colis a été livré le ${this.formatDate(shipment.delivered_at)}.` };
        }

        return {
            text: `📅 Livraison prévue le ${this.formatDate(shipment.estimated_delivery)}.`,
            quickReplies: ['Modifier la date', 'Modifier l\'adresse']
        };
    }

    handleComplaintQuery() {
        return {
            text: `😔 Je suis désolé d'apprendre que vous rencontrez un problème.

Pouvez-vous me préciser:
- Quel est le problème ?
- Avez-vous des photos ?

Un conseiller va être notifié.`,
            quickReplies: ['Colis endommagé', 'Article manquant', 'Mauvais article', 'Autre']
        };
    }

    getDefaultResponse() {
        return {
            text: `Merci pour votre message. Un conseiller va vous répondre rapidement.

En attendant, comment puis-je vous aider ?`,
            quickReplies: ['Suivi de colis', 'Faire un retour', 'Parler à un agent']
        };
    }

    getWelcomeMessage(conversation) {
        return {
            text: `Bonjour${conversation.customerName ? ' ' + conversation.customerName : ''} ! 👋

Je suis l'assistant Routz. Comment puis-je vous aider ?`,
            quickReplies: ['Suivre mon colis', 'Faire un retour', 'Question sur ma commande', 'Autre']
        };
    }

    // ==========================================
    // AGENT FEATURES
    // ==========================================

    async assignToAgent(conversationId, agentId) {
        await this.db.query(
            `UPDATE conversations SET assigned_to = $1, status = 'pending' WHERE id = $2`,
            [agentId, conversationId]
        );
        await this.sendSystemMessage(conversationId, 'Un conseiller prend en charge votre demande.');
        this.emit('conversation:assigned', { conversationId, agentId });
    }

    async escalateToAgent(conversationId, reason) {
        await this.db.query(
            `UPDATE conversations SET priority = 'high' WHERE id = $1`,
            [conversationId]
        );
        await this.sendSystemMessage(conversationId, 'Transfert vers un conseiller en cours...');
        
        const availableAgent = await this.findAvailableAgent(conversationId);
        if (availableAgent) {
            await this.assignToAgent(conversationId, availableAgent.id);
        }

        this.emit('conversation:escalated', { conversationId, reason });
    }

    async findAvailableAgent(conversationId) {
        const conv = await this.getConversation(conversationId);
        const result = await this.db.query(`
            SELECT a.id, a.name, COUNT(c.id) as active_chats
            FROM agents a
            LEFT JOIN conversations c ON c.assigned_to = a.id AND c.status IN ('open', 'pending')
            WHERE a.organization_id = $1 AND a.status = 'online'
            GROUP BY a.id, a.name
            HAVING COUNT(c.id) < $2
            ORDER BY active_chats ASC LIMIT 1
        `, [conv.organization_id, this.maxConcurrentChats]);
        return result.rows[0];
    }

    async resolveConversation(conversationId, resolution) {
        await this.db.query(
            `UPDATE conversations SET status = 'resolved', resolved_at = NOW() WHERE id = $1`,
            [conversationId]
        );

        await this.sendBotMessage(conversationId, {
            text: `Votre demande a été traitée. Comment évaluez-vous notre service ?`,
            satisfactionRating: true,
            quickReplies: ['😀 Excellent', '🙂 Bon', '😐 Moyen', '😞 Mauvais']
        });

        this.emit('conversation:resolved', { conversationId });
    }

    async recordSatisfaction(conversationId, score) {
        await this.db.query(
            `UPDATE conversations SET satisfaction_score = $1 WHERE id = $2`,
            [score, conversationId]
        );
    }

    // ==========================================
    // CANNED RESPONSES
    // ==========================================

    getCannedResponses() {
        return [
            { id: 'greeting', title: 'Salutation', content: 'Bonjour ! Comment puis-je vous aider ?', category: 'general' },
            { id: 'tracking', title: 'Info suivi', content: 'Suivez votre colis avec le numéro {tracking_number} sur {carrier}.', category: 'shipping' },
            { id: 'delay', title: 'Excuse retard', content: 'Je suis désolé pour ce retard. Nous faisons le maximum pour vous livrer rapidement.', category: 'shipping' },
            { id: 'return', title: 'Instructions retour', content: 'Pour retourner: 1) Emballez les articles 2) Imprimez l\'étiquette 3) Déposez en point relais. Remboursement sous 5-7 jours.', category: 'returns' },
            { id: 'closing', title: 'Clôture', content: 'Puis-je vous aider pour autre chose ? Bonne journée !', category: 'general' }
        ];
    }

    // ==========================================
    // ANALYTICS
    // ==========================================

    async getChatAnalytics(orgId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const stats = await this.db.query(`
            SELECT 
                COUNT(*) as total_conversations,
                COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
                AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60) as avg_first_response_min,
                AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_resolution_hours,
                AVG(satisfaction_score) as avg_csat
            FROM conversations
            WHERE organization_id = $1 AND created_at >= $2
        `, [orgId, startDate.toISOString()]);

        const byChannel = await this.db.query(`
            SELECT channel, COUNT(*) as count
            FROM conversations WHERE organization_id = $1 AND created_at >= $2
            GROUP BY channel
        `, [orgId, startDate.toISOString()]);

        return {
            summary: stats.rows[0],
            byChannel: byChannel.rows,
            period: periodDays
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getConversation(conversationId) {
        const result = await this.db.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
        return result.rows[0];
    }

    async getShipmentInfo(shipmentId) {
        const result = await this.db.query('SELECT * FROM shipments WHERE id = $1', [shipmentId]);
        return result.rows[0];
    }

    async sendBotMessage(conversationId, response) {
        const content = typeof response === 'string' ? response : response.text;
        await this.sendMessage(conversationId, {
            type: response.satisfactionRating ? 'satisfaction' : 'text',
            content,
            sender: 'bot',
            senderName: 'Assistant Routz',
            metadata: { quickReplies: response.quickReplies, actions: response.actions }
        });
    }

    async sendSystemMessage(conversationId, content) {
        await this.sendMessage(conversationId, {
            type: 'system', content, sender: 'system', senderName: 'Système'
        });
    }

    formatDate(dateString) {
        if (!dateString) return 'date inconnue';
        return new Date(dateString).toLocaleDateString('fr-FR', {
            weekday: 'long', day: 'numeric', month: 'long'
        });
    }
}

module.exports = { LiveChatService };
