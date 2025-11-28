/**
 * Routz v4.0 - Customer Support Chat Service
 * Live chat, ticketing, chatbot IA, escalade automatique
 */

const { EventEmitter } = require('events');

class CustomerSupportService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.db = config.db;
        this.websocket = config.websocket;
        this.aiProvider = config.aiProvider;
        this.escalationRules = config.escalationRules || this.defaultEscalationRules();
    }

    // ==========================================
    // LIVE CHAT
    // ==========================================

    async startChat(data) {
        const chat = {
            id: this.generateId('CHAT'),
            organizationId: data.organizationId,
            customerId: data.customerId,
            customerName: data.customerName,
            customerEmail: data.customerEmail,
            channel: data.channel || 'widget', // widget, email, whatsapp, messenger
            status: 'waiting', // waiting, active, resolved, closed
            priority: 'normal',
            assignedTo: null,
            department: data.department || 'support',
            subject: data.subject,
            context: {
                orderId: data.orderId,
                shipmentId: data.shipmentId,
                trackingNumber: data.trackingNumber,
                page: data.currentPage,
                userAgent: data.userAgent
            },
            messages: [],
            tags: [],
            metadata: data.metadata || {},
            rating: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            firstResponseAt: null,
            resolvedAt: null
        };

        // Auto-assign basé sur les règles
        const assignment = await this.autoAssign(chat);
        chat.assignedTo = assignment.agentId;
        chat.priority = assignment.priority;

        await this.db.query(
            `INSERT INTO support_chats (id, organization_id, customer_id, customer_name, customer_email, channel, status, priority, assigned_to, department, subject, context, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [chat.id, chat.organizationId, chat.customerId, chat.customerName, chat.customerEmail, chat.channel, chat.status, chat.priority, chat.assignedTo, chat.department, chat.subject, JSON.stringify(chat.context), chat.createdAt]
        );

        // Envoyer message de bienvenue automatique
        await this.sendBotMessage(chat.id, this.getWelcomeMessage(chat));

        // Notifier les agents disponibles
        this.emit('chat:new', chat);

        return chat;
    }

    async sendMessage(chatId, message) {
        const chat = await this.getChat(chatId);
        if (!chat) throw new Error('Chat not found');

        const msg = {
            id: this.generateId('MSG'),
            chatId,
            type: message.type || 'text', // text, image, file, system, bot
            content: message.content,
            sender: {
                type: message.senderType, // customer, agent, bot
                id: message.senderId,
                name: message.senderName
            },
            attachments: message.attachments || [],
            metadata: message.metadata || {},
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO chat_messages (id, chat_id, type, content, sender_type, sender_id, sender_name, attachments, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [msg.id, chatId, msg.type, msg.content, msg.sender.type, msg.sender.id, msg.sender.name, JSON.stringify(msg.attachments), msg.createdAt]
        );

        // Mettre à jour le chat
        const updates = { updatedAt: new Date().toISOString() };
        
        if (chat.status === 'waiting' && message.senderType === 'agent') {
            updates.status = 'active';
            updates.firstResponseAt = new Date().toISOString();
        }

        await this.updateChat(chatId, updates);

        // Broadcast via WebSocket
        this.websocket?.broadcast(`chat:${chatId}`, { type: 'message', data: msg });
        this.emit('message:sent', msg);

        // Auto-réponse bot si nécessaire
        if (message.senderType === 'customer' && chat.status === 'waiting') {
            await this.handleBotResponse(chatId, message.content, chat.context);
        }

        return msg;
    }

    async handleBotResponse(chatId, customerMessage, context) {
        // Analyser l'intention
        const intent = await this.detectIntent(customerMessage);

        // Réponses automatiques basées sur l'intention
        const botResponses = {
            tracking: async () => {
                if (context.trackingNumber) {
                    const tracking = await this.getTrackingInfo(context.trackingNumber);
                    return `Votre colis ${context.trackingNumber} est actuellement **${tracking.status}**.\n\nDernière mise à jour: ${tracking.lastUpdate}\n📍 ${tracking.location}`;
                }
                return "Pouvez-vous me donner votre numéro de suivi ?";
            },
            delivery_delay: () => {
                return "Je comprends votre inquiétude concernant le délai de livraison. Laissez-moi vérifier l'état de votre commande...\n\nUn agent va prendre en charge votre demande sous peu.";
            },
            return: () => {
                return "Pour effectuer un retour, vous pouvez :\n1. Accéder à votre espace client\n2. Sélectionner la commande concernée\n3. Cliquer sur 'Demander un retour'\n\nSouhaitez-vous que je vous envoie le lien direct ?";
            },
            refund: () => {
                return "Les remboursements sont généralement traités sous 5-7 jours ouvrés après réception de votre retour.\n\nUn agent va vérifier le statut de votre remboursement.";
            },
            contact_human: () => {
                return "Je vous mets en relation avec un conseiller. Temps d'attente estimé : 2-3 minutes.";
            }
        };

        const responseGenerator = botResponses[intent] || (() => "Un conseiller va prendre en charge votre demande.");
        const response = typeof responseGenerator === 'function' ? await responseGenerator() : responseGenerator;

        await this.sendBotMessage(chatId, response);

        // Escalader si nécessaire
        if (['delivery_delay', 'refund', 'contact_human'].includes(intent)) {
            await this.escalateChat(chatId, intent);
        }
    }

    async detectIntent(message) {
        const lowerMessage = message.toLowerCase();

        const intents = [
            { keywords: ['suivi', 'tracking', 'où est', 'localiser', 'colis'], intent: 'tracking' },
            { keywords: ['retard', 'en retard', 'pas reçu', 'attends', 'délai'], intent: 'delivery_delay' },
            { keywords: ['retour', 'renvoyer', 'retourner', 'rma'], intent: 'return' },
            { keywords: ['remboursement', 'rembourser', 'argent'], intent: 'refund' },
            { keywords: ['parler', 'humain', 'conseiller', 'agent', 'quelqu\'un'], intent: 'contact_human' }
        ];

        for (const { keywords, intent } of intents) {
            if (keywords.some(kw => lowerMessage.includes(kw))) {
                return intent;
            }
        }

        return 'unknown';
    }

    async sendBotMessage(chatId, content) {
        return this.sendMessage(chatId, {
            type: 'bot',
            content,
            senderType: 'bot',
            senderId: 'routz-bot',
            senderName: 'Assistant Routz'
        });
    }

    // ==========================================
    // TICKETING
    // ==========================================

    async createTicket(data) {
        const ticket = {
            id: this.generateId('TKT'),
            organizationId: data.organizationId,
            chatId: data.chatId,
            customerId: data.customerId,
            customerEmail: data.customerEmail,
            subject: data.subject,
            description: data.description,
            category: data.category || 'general', // general, shipping, return, billing, technical
            priority: data.priority || 'normal', // low, normal, high, urgent
            status: 'open', // open, pending, in_progress, resolved, closed
            assignedTo: data.assignedTo,
            department: data.department || 'support',
            tags: data.tags || [],
            relatedOrders: data.relatedOrders || [],
            relatedShipments: data.relatedShipments || [],
            slaDeadline: this.calculateSLADeadline(data.priority),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            firstResponseAt: null,
            resolvedAt: null
        };

        await this.db.query(
            `INSERT INTO support_tickets (id, organization_id, chat_id, customer_id, customer_email, subject, description, category, priority, status, assigned_to, department, tags, sla_deadline, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [ticket.id, ticket.organizationId, ticket.chatId, ticket.customerId, ticket.customerEmail, ticket.subject, ticket.description, ticket.category, ticket.priority, ticket.status, ticket.assignedTo, ticket.department, JSON.stringify(ticket.tags), ticket.slaDeadline, ticket.createdAt]
        );

        this.emit('ticket:created', ticket);
        return ticket;
    }

    async updateTicketStatus(ticketId, status, userId) {
        const updates = { status, updatedAt: new Date().toISOString() };
        
        if (status === 'resolved') {
            updates.resolvedAt = new Date().toISOString();
        }

        await this.db.query(
            `UPDATE support_tickets SET status = $1, resolved_at = $2, updated_at = $3 WHERE id = $4`,
            [status, updates.resolvedAt, updates.updatedAt, ticketId]
        );

        // Ajouter une note interne
        await this.addTicketNote(ticketId, {
            type: 'status_change',
            content: `Statut changé en "${status}"`,
            userId
        });

        this.emit('ticket:updated', { ticketId, status });
    }

    async addTicketNote(ticketId, note) {
        const noteRecord = {
            id: this.generateId('NOTE'),
            ticketId,
            type: note.type || 'internal', // internal, customer_reply, system
            content: note.content,
            userId: note.userId,
            attachments: note.attachments || [],
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO ticket_notes (id, ticket_id, type, content, user_id, attachments, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [noteRecord.id, ticketId, noteRecord.type, noteRecord.content, noteRecord.userId, JSON.stringify(noteRecord.attachments), noteRecord.createdAt]
        );

        return noteRecord;
    }

    // ==========================================
    // ESCALATION
    // ==========================================

    async escalateChat(chatId, reason) {
        const chat = await this.getChat(chatId);
        if (!chat) throw new Error('Chat not found');

        // Augmenter la priorité
        const newPriority = this.escalatePriority(chat.priority);

        // Trouver un agent disponible de niveau supérieur
        const escalationAgent = await this.findEscalationAgent(chat.department);

        await this.updateChat(chatId, {
            priority: newPriority,
            assignedTo: escalationAgent?.id,
            escalatedAt: new Date().toISOString(),
            escalationReason: reason
        });

        // Message système
        await this.sendMessage(chatId, {
            type: 'system',
            content: `Conversation escaladée - Priorité: ${newPriority}`,
            senderType: 'system',
            senderId: 'system',
            senderName: 'Système'
        });

        // Notifier l'agent
        if (escalationAgent) {
            this.emit('chat:escalated', { chatId, agentId: escalationAgent.id, reason });
        }

        return { newPriority, assignedTo: escalationAgent };
    }

    escalatePriority(currentPriority) {
        const priorities = ['low', 'normal', 'high', 'urgent'];
        const currentIndex = priorities.indexOf(currentPriority);
        return priorities[Math.min(currentIndex + 1, priorities.length - 1)];
    }

    async findEscalationAgent(department) {
        const result = await this.db.query(`
            SELECT id, name FROM support_agents 
            WHERE department = $1 AND level >= 2 AND status = 'available'
            ORDER BY current_chats ASC LIMIT 1
        `, [department]);
        return result.rows[0];
    }

    // ==========================================
    // AUTO-ASSIGNMENT
    // ==========================================

    async autoAssign(chat) {
        // Règles de priorité basées sur le contexte
        let priority = 'normal';

        if (chat.context.orderId) {
            // Vérifier si la commande a un problème
            const order = await this.db.query(
                'SELECT status, created_at FROM orders WHERE id = $1',
                [chat.context.orderId]
            );
            
            if (order.rows[0]) {
                const daysSinceOrder = (Date.now() - new Date(order.rows[0].created_at)) / (1000 * 60 * 60 * 24);
                if (daysSinceOrder > 7 && order.rows[0].status !== 'delivered') {
                    priority = 'high';
                }
            }
        }

        if (chat.context.shipmentId) {
            // Vérifier les retards
            const shipment = await this.db.query(
                'SELECT status, estimated_delivery FROM shipments WHERE id = $1',
                [chat.context.shipmentId]
            );
            
            if (shipment.rows[0]?.estimated_delivery && new Date(shipment.rows[0].estimated_delivery) < new Date()) {
                priority = 'high';
            }
        }

        // Trouver l'agent le moins chargé
        const agent = await this.db.query(`
            SELECT id FROM support_agents 
            WHERE department = $1 AND status = 'available'
            ORDER BY current_chats ASC LIMIT 1
        `, [chat.department]);

        return {
            agentId: agent.rows[0]?.id || null,
            priority
        };
    }

    // ==========================================
    // CANNED RESPONSES
    // ==========================================

    getCannedResponses() {
        return [
            {
                id: 'greeting',
                category: 'general',
                shortcut: '/bonjour',
                title: 'Salutation',
                content: 'Bonjour ! Je suis {agent_name}, comment puis-je vous aider aujourd\'hui ?'
            },
            {
                id: 'tracking_info',
                category: 'shipping',
                shortcut: '/suivi',
                title: 'Info suivi',
                content: 'Votre colis est actuellement en cours de livraison. Vous pouvez suivre son acheminement ici : {tracking_url}'
            },
            {
                id: 'delay_apology',
                category: 'shipping',
                shortcut: '/retard',
                title: 'Excuse retard',
                content: 'Je suis sincèrement désolé pour ce retard. Notre équipe fait tout son possible pour que votre colis vous parvienne au plus vite. Je vais vérifier son statut immédiatement.'
            },
            {
                id: 'return_process',
                category: 'returns',
                shortcut: '/retour',
                title: 'Processus retour',
                content: 'Pour effectuer votre retour :\n1. Connectez-vous à votre espace client\n2. Accédez à "Mes commandes"\n3. Cliquez sur "Demander un retour"\n4. Imprimez l\'étiquette de retour\n\nLe remboursement sera effectué sous 5-7 jours après réception.'
            },
            {
                id: 'closing',
                category: 'general',
                shortcut: '/fin',
                title: 'Clôture',
                content: 'Y a-t-il autre chose que je puisse faire pour vous ? Si non, je vous souhaite une excellente journée ! N\'hésitez pas à nous recontacter si besoin.'
            }
        ];
    }

    // ==========================================
    // ANALYTICS
    // ==========================================

    async getSupportAnalytics(orgId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const chatStats = await this.db.query(`
            SELECT 
                COUNT(*) as total_chats,
                COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
                AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60) as avg_first_response_min,
                AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60) as avg_resolution_min,
                AVG(rating) as avg_rating
            FROM support_chats 
            WHERE organization_id = $1 AND created_at >= $2
        `, [orgId, startDate.toISOString()]);

        const ticketStats = await this.db.query(`
            SELECT 
                COUNT(*) as total_tickets,
                COUNT(CASE WHEN status = 'resolved' OR status = 'closed' THEN 1 END) as resolved,
                COUNT(CASE WHEN resolved_at > sla_deadline THEN 1 END) as sla_breached,
                AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_resolution_hours
            FROM support_tickets 
            WHERE organization_id = $1 AND created_at >= $2
        `, [orgId, startDate.toISOString()]);

        const byCategory = await this.db.query(`
            SELECT category, COUNT(*) as count
            FROM support_tickets 
            WHERE organization_id = $1 AND created_at >= $2
            GROUP BY category ORDER BY count DESC
        `, [orgId, startDate.toISOString()]);

        return {
            chats: {
                total: parseInt(chatStats.rows[0].total_chats),
                resolved: parseInt(chatStats.rows[0].resolved),
                avgFirstResponseMin: Math.round(chatStats.rows[0].avg_first_response_min || 0),
                avgResolutionMin: Math.round(chatStats.rows[0].avg_resolution_min || 0),
                avgRating: parseFloat(chatStats.rows[0].avg_rating || 0).toFixed(1)
            },
            tickets: {
                total: parseInt(ticketStats.rows[0].total_tickets),
                resolved: parseInt(ticketStats.rows[0].resolved),
                slaBreached: parseInt(ticketStats.rows[0].sla_breached),
                avgResolutionHours: Math.round(ticketStats.rows[0].avg_resolution_hours || 0)
            },
            byCategory: byCategory.rows,
            period: periodDays
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getChat(chatId) {
        const result = await this.db.query('SELECT * FROM support_chats WHERE id = $1', [chatId]);
        return result.rows[0];
    }

    async updateChat(chatId, updates) {
        const fields = Object.keys(updates).map((k, i) => `${this.toSnakeCase(k)} = $${i + 2}`);
        const values = Object.values(updates).map(v => typeof v === 'object' ? JSON.stringify(v) : v);
        await this.db.query(`UPDATE support_chats SET ${fields.join(', ')} WHERE id = $1`, [chatId, ...values]);
    }

    async getTrackingInfo(trackingNumber) {
        const result = await this.db.query(
            'SELECT status, last_tracking_update, last_location FROM shipments WHERE tracking_number = $1',
            [trackingNumber]
        );
        const shipment = result.rows[0];
        return {
            status: shipment?.status || 'inconnu',
            lastUpdate: shipment?.last_tracking_update || 'N/A',
            location: shipment?.last_location || 'N/A'
        };
    }

    getWelcomeMessage(chat) {
        const messages = {
            widget: `Bonjour ${chat.customerName || ''} ! 👋\n\nBienvenue sur le support Routz. Comment puis-je vous aider aujourd'hui ?`,
            email: `Bonjour,\n\nNous avons bien reçu votre demande. Un conseiller va la traiter dans les plus brefs délais.`,
            whatsapp: `Bonjour ! 👋 Comment puis-je vous aider ?`
        };
        return messages[chat.channel] || messages.widget;
    }

    calculateSLADeadline(priority) {
        const slaHours = { urgent: 2, high: 4, normal: 24, low: 48 };
        const hours = slaHours[priority] || 24;
        return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    }

    defaultEscalationRules() {
        return [
            { condition: 'wait_time > 5min', action: 'notify_supervisor' },
            { condition: 'priority = urgent', action: 'assign_senior' },
            { condition: 'customer_vip', action: 'assign_dedicated' }
        ];
    }

    generateId(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`.toUpperCase();
    }

    toSnakeCase(str) {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    }
}

module.exports = { CustomerSupportService };
