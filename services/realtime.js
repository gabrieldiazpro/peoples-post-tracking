/**
 * Routz v4.0 - Real-time WebSocket Service
 * Tracking live, notifications push, dashboard temps réel
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

class RealtimeService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.wss = null;
        this.clients = new Map(); // clientId -> { ws, subscriptions, orgId, userId }
        this.channels = new Map(); // channelName -> Set of clientIds
        this.redis = config.redis;
        this.db = config.db;
        this.heartbeatInterval = config.heartbeatInterval || 30000;
        this.reconnectTimeout = config.reconnectTimeout || 5000;
    }

    // ==========================================
    // SERVER SETUP
    // ==========================================

    initialize(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateClientId();
            const token = this.extractToken(req);

            this.handleConnection(ws, clientId, token);
        });

        // Heartbeat pour détecter les connexions mortes
        setInterval(() => this.checkHeartbeats(), this.heartbeatInterval);

        // Écouter les événements Redis pour le scaling horizontal
        if (this.redis) {
            this.subscribeToRedis();
        }

        console.log('🔌 WebSocket server initialized');
        return this;
    }

    async handleConnection(ws, clientId, token) {
        try {
            // Authentifier le client
            const auth = await this.authenticateClient(token);
            if (!auth.valid) {
                ws.close(4001, 'Authentication failed');
                return;
            }

            // Enregistrer le client
            this.clients.set(clientId, {
                ws,
                subscriptions: new Set(),
                orgId: auth.orgId,
                userId: auth.userId,
                isAlive: true,
                connectedAt: new Date()
            });

            // Event handlers
            ws.on('message', (data) => this.handleMessage(clientId, data));
            ws.on('close', () => this.handleDisconnect(clientId));
            ws.on('error', (err) => this.handleError(clientId, err));
            ws.on('pong', () => this.handlePong(clientId));

            // Envoyer confirmation de connexion
            this.send(clientId, {
                type: 'connected',
                clientId,
                timestamp: new Date().toISOString()
            });

            // Auto-subscribe aux channels de l'organisation
            this.subscribe(clientId, `org:${auth.orgId}`);
            this.subscribe(clientId, `user:${auth.userId}`);

            this.emit('client:connected', { clientId, orgId: auth.orgId, userId: auth.userId });

        } catch (error) {
            console.error('Connection error:', error);
            ws.close(4000, 'Connection error');
        }
    }

    // ==========================================
    // MESSAGE HANDLING
    // ==========================================

    handleMessage(clientId, rawData) {
        try {
            const message = JSON.parse(rawData.toString());
            const client = this.clients.get(clientId);

            if (!client) return;

            switch (message.type) {
                case 'subscribe':
                    this.handleSubscribe(clientId, message);
                    break;

                case 'unsubscribe':
                    this.handleUnsubscribe(clientId, message);
                    break;

                case 'ping':
                    this.send(clientId, { type: 'pong', timestamp: Date.now() });
                    break;

                case 'track_shipment':
                    this.handleTrackShipment(clientId, message);
                    break;

                case 'get_live_stats':
                    this.handleGetLiveStats(clientId, message);
                    break;

                default:
                    this.emit('message', { clientId, message });
            }

        } catch (error) {
            console.error('Message parse error:', error);
            this.send(clientId, { type: 'error', message: 'Invalid message format' });
        }
    }

    handleSubscribe(clientId, message) {
        const { channels } = message;
        const client = this.clients.get(clientId);

        if (!client || !channels) return;

        const allowedChannels = this.validateChannelAccess(client, channels);

        for (const channel of allowedChannels) {
            this.subscribe(clientId, channel);
        }

        this.send(clientId, {
            type: 'subscribed',
            channels: allowedChannels
        });
    }

    handleUnsubscribe(clientId, message) {
        const { channels } = message;

        if (!channels) return;

        for (const channel of channels) {
            this.unsubscribe(clientId, channel);
        }

        this.send(clientId, {
            type: 'unsubscribed',
            channels
        });
    }

    async handleTrackShipment(clientId, message) {
        const { trackingNumber, shipmentId } = message;
        const client = this.clients.get(clientId);

        if (!client) return;

        // S'abonner aux mises à jour de ce colis
        const channel = trackingNumber 
            ? `tracking:${trackingNumber}` 
            : `shipment:${shipmentId}`;

        this.subscribe(clientId, channel);

        // Récupérer le statut actuel
        const currentStatus = await this.getShipmentStatus(trackingNumber || shipmentId);

        this.send(clientId, {
            type: 'tracking_status',
            trackingNumber,
            shipmentId,
            status: currentStatus
        });
    }

    async handleGetLiveStats(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const stats = await this.getLiveStats(client.orgId);

        this.send(clientId, {
            type: 'live_stats',
            stats,
            timestamp: new Date().toISOString()
        });
    }

    // ==========================================
    // CHANNEL MANAGEMENT
    // ==========================================

    subscribe(clientId, channel) {
        const client = this.clients.get(clientId);
        if (!client) return;

        // Ajouter au client
        client.subscriptions.add(channel);

        // Ajouter au channel
        if (!this.channels.has(channel)) {
            this.channels.set(channel, new Set());
        }
        this.channels.get(channel).add(clientId);

        // Subscribe Redis si présent
        if (this.redis) {
            this.redis.subscribe(channel);
        }
    }

    unsubscribe(clientId, channel) {
        const client = this.clients.get(clientId);
        if (!client) return;

        client.subscriptions.delete(channel);

        const channelClients = this.channels.get(channel);
        if (channelClients) {
            channelClients.delete(clientId);
            if (channelClients.size === 0) {
                this.channels.delete(channel);
                if (this.redis) {
                    this.redis.unsubscribe(channel);
                }
            }
        }
    }

    validateChannelAccess(client, channels) {
        return channels.filter(channel => {
            // L'utilisateur peut s'abonner aux channels de son org
            if (channel.startsWith(`org:${client.orgId}`)) return true;
            if (channel.startsWith(`user:${client.userId}`)) return true;
            if (channel.startsWith('tracking:')) return true;
            if (channel.startsWith('shipment:')) return true;
            if (channel === 'global:announcements') return true;
            return false;
        });
    }

    // ==========================================
    // BROADCASTING
    // ==========================================

    broadcast(channel, message) {
        const channelClients = this.channels.get(channel);
        if (!channelClients) return;

        const payload = {
            channel,
            ...message,
            timestamp: new Date().toISOString()
        };

        for (const clientId of channelClients) {
            this.send(clientId, payload);
        }

        // Publier sur Redis pour le scaling horizontal
        if (this.redis) {
            this.redis.publish(channel, JSON.stringify(payload));
        }
    }

    broadcastToOrg(orgId, message) {
        this.broadcast(`org:${orgId}`, message);
    }

    broadcastToUser(userId, message) {
        this.broadcast(`user:${userId}`, message);
    }

    send(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;

        try {
            client.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error('Send error:', error);
        }
    }

    // ==========================================
    // TRACKING EVENTS
    // ==========================================

    /**
     * Notifier une mise à jour de tracking
     */
    notifyTrackingUpdate(trackingNumber, update) {
        const message = {
            type: 'tracking_update',
            trackingNumber,
            update: {
                status: update.status,
                statusLabel: update.statusLabel,
                location: update.location,
                description: update.description,
                timestamp: update.timestamp,
                carrier: update.carrier,
                estimatedDelivery: update.estimatedDelivery
            }
        };

        // Broadcast aux abonnés du tracking
        this.broadcast(`tracking:${trackingNumber}`, message);

        // Notifier l'organisation
        if (update.orgId) {
            this.broadcastToOrg(update.orgId, {
                type: 'shipment_status_changed',
                shipmentId: update.shipmentId,
                trackingNumber,
                oldStatus: update.oldStatus,
                newStatus: update.status
            });
        }
    }

    /**
     * Notifier une exception de livraison
     */
    notifyDeliveryException(shipmentData) {
        const message = {
            type: 'delivery_exception',
            shipmentId: shipmentData.id,
            trackingNumber: shipmentData.trackingNumber,
            exception: {
                code: shipmentData.exceptionCode,
                description: shipmentData.exceptionDescription,
                actionRequired: shipmentData.actionRequired
            },
            severity: shipmentData.severity || 'warning'
        };

        this.broadcast(`tracking:${shipmentData.trackingNumber}`, message);
        this.broadcastToOrg(shipmentData.orgId, message);
    }

    /**
     * Notifier une livraison réussie
     */
    notifyDeliverySuccess(shipmentData) {
        const message = {
            type: 'delivery_success',
            shipmentId: shipmentData.id,
            trackingNumber: shipmentData.trackingNumber,
            deliveredAt: shipmentData.deliveredAt,
            signedBy: shipmentData.signedBy,
            proofOfDelivery: shipmentData.proofOfDelivery
        };

        this.broadcast(`tracking:${shipmentData.trackingNumber}`, message);
        this.broadcastToOrg(shipmentData.orgId, message);
    }

    // ==========================================
    // DASHBOARD LIVE UPDATES
    // ==========================================

    /**
     * Envoyer les stats live du dashboard
     */
    async sendDashboardUpdate(orgId) {
        const stats = await this.getLiveStats(orgId);

        this.broadcastToOrg(orgId, {
            type: 'dashboard_update',
            stats
        });
    }

    async getLiveStats(orgId) {
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        const [shipmentsToday, pendingOrders, activeDeliveries, exceptions] = await Promise.all([
            this.db.query(`SELECT COUNT(*) as count FROM shipments WHERE organization_id = $1 AND DATE(created_at) = $2`, [orgId, today]),
            this.db.query(`SELECT COUNT(*) as count FROM orders WHERE organization_id = $1 AND status = 'pending'`, [orgId]),
            this.db.query(`SELECT COUNT(*) as count FROM shipments WHERE organization_id = $1 AND status IN ('in_transit', 'out_for_delivery')`, [orgId]),
            this.db.query(`SELECT COUNT(*) as count FROM shipments WHERE organization_id = $1 AND status = 'exception'`, [orgId])
        ]);

        return {
            shipmentsToday: parseInt(shipmentsToday.rows[0].count),
            pendingOrders: parseInt(pendingOrders.rows[0].count),
            activeDeliveries: parseInt(activeDeliveries.rows[0].count),
            exceptions: parseInt(exceptions.rows[0].count),
            updatedAt: now.toISOString()
        };
    }

    // ==========================================
    // ORDER & SHIPMENT NOTIFICATIONS
    // ==========================================

    notifyNewOrder(order) {
        this.broadcastToOrg(order.organizationId, {
            type: 'new_order',
            order: {
                id: order.id,
                orderNumber: order.orderNumber,
                customer: order.customerName,
                total: order.total,
                itemCount: order.items?.length || 0,
                source: order.source
            }
        });
    }

    notifyShipmentCreated(shipment) {
        this.broadcastToOrg(shipment.organizationId, {
            type: 'shipment_created',
            shipment: {
                id: shipment.id,
                trackingNumber: shipment.trackingNumber,
                carrier: shipment.carrier,
                recipient: shipment.recipientName,
                destination: `${shipment.recipientCity}, ${shipment.recipientCountry}`
            }
        });
    }

    notifyLabelGenerated(label) {
        this.broadcastToOrg(label.organizationId, {
            type: 'label_generated',
            shipmentId: label.shipmentId,
            trackingNumber: label.trackingNumber,
            labelUrl: label.labelUrl
        });
    }

    // ==========================================
    // ALERTS & NOTIFICATIONS
    // ==========================================

    sendAlert(orgId, alert) {
        this.broadcastToOrg(orgId, {
            type: 'alert',
            alert: {
                id: alert.id,
                severity: alert.severity, // info, warning, error, critical
                title: alert.title,
                message: alert.message,
                action: alert.action,
                dismissable: alert.dismissable !== false
            }
        });
    }

    sendNotification(userId, notification) {
        this.broadcastToUser(userId, {
            type: 'notification',
            notification: {
                id: notification.id,
                title: notification.title,
                body: notification.body,
                icon: notification.icon,
                link: notification.link,
                read: false
            }
        });
    }

    // ==========================================
    // CONNECTION MANAGEMENT
    // ==========================================

    handleDisconnect(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        // Retirer de tous les channels
        for (const channel of client.subscriptions) {
            this.unsubscribe(clientId, channel);
        }

        this.clients.delete(clientId);
        this.emit('client:disconnected', { clientId });
    }

    handleError(clientId, error) {
        console.error(`WebSocket error for client ${clientId}:`, error);
        this.emit('client:error', { clientId, error });
    }

    handlePong(clientId) {
        const client = this.clients.get(clientId);
        if (client) {
            client.isAlive = true;
        }
    }

    checkHeartbeats() {
        for (const [clientId, client] of this.clients) {
            if (!client.isAlive) {
                client.ws.terminate();
                this.handleDisconnect(clientId);
                continue;
            }

            client.isAlive = false;
            client.ws.ping();
        }
    }

    // ==========================================
    // REDIS PUB/SUB (Scaling horizontal)
    // ==========================================

    subscribeToRedis() {
        const subscriber = this.redis.duplicate();

        subscriber.on('message', (channel, message) => {
            try {
                const payload = JSON.parse(message);
                // Redistribuer aux clients locaux
                const channelClients = this.channels.get(channel);
                if (channelClients) {
                    for (const clientId of channelClients) {
                        this.send(clientId, payload);
                    }
                }
            } catch (error) {
                console.error('Redis message error:', error);
            }
        });

        subscriber.psubscribe('*');
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async authenticateClient(token) {
        if (!token) return { valid: false };

        try {
            // Vérifier le token JWT ou API key
            const decoded = await this.verifyToken(token);
            return {
                valid: true,
                orgId: decoded.orgId,
                userId: decoded.userId
            };
        } catch (error) {
            return { valid: false };
        }
    }

    async verifyToken(token) {
        // Simuler la vérification - à remplacer par votre logique JWT
        const result = await this.db.query(
            'SELECT organization_id, id FROM users WHERE api_token = $1',
            [token]
        );

        if (result.rows.length === 0) {
            throw new Error('Invalid token');
        }

        return {
            orgId: result.rows[0].organization_id,
            userId: result.rows[0].id
        };
    }

    extractToken(req) {
        const url = new URL(req.url, 'http://localhost');
        return url.searchParams.get('token') || 
               req.headers['authorization']?.replace('Bearer ', '');
    }

    async getShipmentStatus(identifier) {
        const result = await this.db.query(
            `SELECT * FROM shipments WHERE tracking_number = $1 OR id = $1`,
            [identifier]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const shipment = result.rows[0];
        return {
            status: shipment.status,
            carrier: shipment.carrier,
            trackingNumber: shipment.tracking_number,
            estimatedDelivery: shipment.estimated_delivery,
            lastUpdate: shipment.last_tracking_update,
            lastLocation: shipment.last_location
        };
    }

    generateClientId() {
        return `ws_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 8)}`;
    }

    // ==========================================
    // STATS & MONITORING
    // ==========================================

    getConnectionStats() {
        return {
            totalConnections: this.clients.size,
            totalChannels: this.channels.size,
            clientsByOrg: this.getClientsByOrg(),
            channelSubscribers: this.getChannelStats()
        };
    }

    getClientsByOrg() {
        const byOrg = {};
        for (const [_, client] of this.clients) {
            byOrg[client.orgId] = (byOrg[client.orgId] || 0) + 1;
        }
        return byOrg;
    }

    getChannelStats() {
        const stats = {};
        for (const [channel, clients] of this.channels) {
            stats[channel] = clients.size;
        }
        return stats;
    }
}

module.exports = { RealtimeService };
