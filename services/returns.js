/**
 * Routz v4.0 - Returns Management System (RMA)
 * Gestion complète des retours avec portail client, remboursements et analytics
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

class ReturnsService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.db = config.db;
        this.carriers = config.carriers;
        this.notifications = config.notifications;
        this.refundService = config.refundService;
        
        // Configuration des politiques de retour
        this.defaultPolicy = {
            returnWindowDays: 30,
            freeReturnThreshold: 0, // 0 = toujours gratuit
            restockingFeePercent: 0,
            requirePhotos: false,
            autoApprove: false,
            autoRefund: false,
            allowExchange: true,
            allowStoreCredit: true,
            labelPaidBy: 'merchant' // merchant, customer
        };

        this.returnReasons = [
            { code: 'SIZE_TOO_SMALL', label: 'Taille trop petite', category: 'size', exchangeable: true },
            { code: 'SIZE_TOO_LARGE', label: 'Taille trop grande', category: 'size', exchangeable: true },
            { code: 'WRONG_COLOR', label: 'Couleur différente', category: 'description', exchangeable: true },
            { code: 'NOT_AS_DESCRIBED', label: 'Non conforme à la description', category: 'description', refundable: true },
            { code: 'DAMAGED_IN_TRANSIT', label: 'Endommagé pendant le transport', category: 'damage', refundable: true, urgent: true },
            { code: 'DEFECTIVE', label: 'Produit défectueux', category: 'quality', refundable: true },
            { code: 'WRONG_ITEM', label: 'Mauvais article reçu', category: 'fulfillment', exchangeable: true, urgent: true },
            { code: 'MISSING_PARTS', label: 'Pièces manquantes', category: 'fulfillment', refundable: true },
            { code: 'CHANGED_MIND', label: 'Je ne veux plus de cet article', category: 'preference', restockingFee: true },
            { code: 'FOUND_BETTER_PRICE', label: 'Trouvé moins cher ailleurs', category: 'preference', restockingFee: true },
            { code: 'ORDERED_BY_MISTAKE', label: 'Commandé par erreur', category: 'preference', restockingFee: true },
            { code: 'LATE_DELIVERY', label: 'Livraison trop tardive', category: 'delivery', refundable: true },
            { code: 'OTHER', label: 'Autre raison', category: 'other' }
        ];

        this.returnStatuses = {
            REQUESTED: { label: 'Demandé', color: '#F59E0B' },
            PENDING_APPROVAL: { label: 'En attente d\'approbation', color: '#F59E0B' },
            APPROVED: { label: 'Approuvé', color: '#10B981' },
            REJECTED: { label: 'Rejeté', color: '#EF4444' },
            LABEL_CREATED: { label: 'Étiquette créée', color: '#3B82F6' },
            SHIPPED: { label: 'Expédié', color: '#8B5CF6' },
            IN_TRANSIT: { label: 'En transit', color: '#8B5CF6' },
            DELIVERED: { label: 'Reçu à l\'entrepôt', color: '#10B981' },
            INSPECTING: { label: 'Inspection en cours', color: '#F59E0B' },
            INSPECTION_PASSED: { label: 'Inspection validée', color: '#10B981' },
            INSPECTION_FAILED: { label: 'Inspection échouée', color: '#EF4444' },
            REFUND_PENDING: { label: 'Remboursement en cours', color: '#3B82F6' },
            REFUNDED: { label: 'Remboursé', color: '#10B981' },
            EXCHANGED: { label: 'Échangé', color: '#10B981' },
            STORE_CREDIT: { label: 'Avoir émis', color: '#10B981' },
            CLOSED: { label: 'Clôturé', color: '#6B7280' },
            CANCELLED: { label: 'Annulé', color: '#6B7280' }
        };
    }

    // ==========================================
    // RETURN REQUEST MANAGEMENT
    // ==========================================

    /**
     * Créer une demande de retour
     */
    async createReturnRequest(data) {
        const order = await this.getOrder(data.orderId);
        if (!order) throw new Error('Commande introuvable');

        // Vérifier la politique de retour
        const policy = await this.getReturnPolicy(order.organizationId);
        const validation = this.validateReturnEligibility(order, data.items, policy);
        
        if (!validation.eligible) {
            throw new Error(validation.reason);
        }

        const returnRequest = {
            id: this.generateId('ret'),
            rmaNumber: this.generateRMANumber(),
            organizationId: order.organizationId,
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerId: order.customerId,
            customer: {
                email: data.customerEmail || order.customer.email,
                firstName: order.customer.firstName,
                lastName: order.customer.lastName,
                phone: order.customer.phone
            },
            items: data.items.map(item => ({
                orderItemId: item.orderItemId,
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                originalQuantity: item.originalQuantity,
                price: item.price,
                reason: item.reason,
                reasonCode: item.reasonCode,
                condition: item.condition || 'unknown',
                photos: item.photos || [],
                notes: item.notes
            })),
            reason: data.reason,
            reasonCode: data.reasonCode,
            reasonCategory: this.getReasonCategory(data.reasonCode),
            customerNotes: data.customerNotes,
            internalNotes: data.internalNotes,
            resolution: data.preferredResolution || 'refund', // refund, exchange, store_credit
            status: policy.autoApprove ? 'APPROVED' : 'PENDING_APPROVAL',
            refundAmount: this.calculateRefundAmount(data.items, policy),
            restockingFee: this.calculateRestockingFee(data.items, data.reasonCode, policy),
            shippingRefund: this.shouldRefundShipping(data.reasonCode, policy),
            originalShippingCost: order.shippingCost,
            returnShipping: {
                method: null,
                carrier: null,
                trackingNumber: null,
                labelUrl: null,
                labelCreatedAt: null,
                cost: null,
                paidBy: policy.labelPaidBy
            },
            warehouse: data.warehouseId || await this.getDefaultReturnWarehouse(order.organizationId),
            timeline: [{
                status: 'REQUESTED',
                timestamp: new Date().toISOString(),
                actor: 'customer',
                notes: 'Demande de retour créée'
            }],
            metadata: data.metadata || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: this.calculateExpiryDate(policy.returnWindowDays)
        };

        // Auto-approve si configuré
        if (policy.autoApprove) {
            returnRequest.timeline.push({
                status: 'APPROVED',
                timestamp: new Date().toISOString(),
                actor: 'system',
                notes: 'Approuvé automatiquement selon la politique de retour'
            });
        }

        await this.db.query(
            `INSERT INTO returns (id, rma_number, organization_id, order_id, customer_id, items, reason_code, status, refund_amount, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [returnRequest.id, returnRequest.rmaNumber, returnRequest.organizationId, returnRequest.orderId,
             returnRequest.customerId, JSON.stringify(returnRequest.items), returnRequest.reasonCode,
             returnRequest.status, returnRequest.refundAmount, returnRequest.createdAt]
        );

        // Notifications
        await this.notifications.send({
            type: 'return_requested',
            to: returnRequest.customer.email,
            data: { returnRequest, order }
        });

        this.emit('return:created', returnRequest);

        // Auto-générer l'étiquette si approuvé
        if (returnRequest.status === 'APPROVED' && policy.labelPaidBy === 'merchant') {
            await this.generateReturnLabel(returnRequest.id);
        }

        return returnRequest;
    }

    /**
     * Valider l'éligibilité au retour
     */
    validateReturnEligibility(order, items, policy) {
        // Vérifier le délai
        const orderDate = new Date(order.createdAt);
        const daysSinceOrder = Math.floor((Date.now() - orderDate) / (1000 * 60 * 60 * 24));
        
        if (daysSinceOrder > policy.returnWindowDays) {
            return {
                eligible: false,
                reason: `La période de retour de ${policy.returnWindowDays} jours est dépassée`
            };
        }

        // Vérifier que les articles sont dans la commande
        for (const item of items) {
            const orderItem = order.items.find(i => i.id === item.orderItemId || i.sku === item.sku);
            if (!orderItem) {
                return { eligible: false, reason: `Article ${item.sku} non trouvé dans la commande` };
            }
            if (item.quantity > orderItem.quantity) {
                return { eligible: false, reason: `Quantité demandée supérieure à la quantité commandée pour ${item.sku}` };
            }
        }

        // Vérifier si pas déjà retourné
        const existingReturns = order.returns || [];
        for (const item of items) {
            const alreadyReturned = existingReturns
                .filter(r => r.status !== 'CANCELLED' && r.status !== 'REJECTED')
                .flatMap(r => r.items)
                .filter(i => i.sku === item.sku)
                .reduce((sum, i) => sum + i.quantity, 0);
            
            const orderItem = order.items.find(i => i.sku === item.sku);
            if (alreadyReturned + item.quantity > orderItem.quantity) {
                return { eligible: false, reason: `Article ${item.sku} déjà retourné ou en cours de retour` };
            }
        }

        return { eligible: true };
    }

    /**
     * Approuver une demande de retour
     */
    async approveReturn(returnId, approvedBy, notes) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');
        if (returnRequest.status !== 'PENDING_APPROVAL') {
            throw new Error('Ce retour ne peut pas être approuvé');
        }

        returnRequest.status = 'APPROVED';
        returnRequest.approvedAt = new Date().toISOString();
        returnRequest.approvedBy = approvedBy;
        returnRequest.timeline.push({
            status: 'APPROVED',
            timestamp: new Date().toISOString(),
            actor: approvedBy,
            notes: notes || 'Retour approuvé'
        });

        await this.updateReturn(returnRequest);

        // Générer l'étiquette
        const policy = await this.getReturnPolicy(returnRequest.organizationId);
        if (policy.labelPaidBy === 'merchant') {
            await this.generateReturnLabel(returnId);
        }

        await this.notifications.send({
            type: 'return_approved',
            to: returnRequest.customer.email,
            data: { returnRequest }
        });

        this.emit('return:approved', returnRequest);
        return returnRequest;
    }

    /**
     * Rejeter une demande de retour
     */
    async rejectReturn(returnId, rejectedBy, reason) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');

        returnRequest.status = 'REJECTED';
        returnRequest.rejectedAt = new Date().toISOString();
        returnRequest.rejectedBy = rejectedBy;
        returnRequest.rejectionReason = reason;
        returnRequest.timeline.push({
            status: 'REJECTED',
            timestamp: new Date().toISOString(),
            actor: rejectedBy,
            notes: reason
        });

        await this.updateReturn(returnRequest);

        await this.notifications.send({
            type: 'return_rejected',
            to: returnRequest.customer.email,
            data: { returnRequest, reason }
        });

        this.emit('return:rejected', returnRequest);
        return returnRequest;
    }

    // ==========================================
    // RETURN LABELS
    // ==========================================

    /**
     * Générer une étiquette de retour
     */
    async generateReturnLabel(returnId, options = {}) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');

        const order = await this.getOrder(returnRequest.orderId);
        const warehouse = await this.getWarehouse(returnRequest.warehouse);
        const policy = await this.getReturnPolicy(returnRequest.organizationId);

        // Choisir le transporteur
        const carrier = options.carrier || policy.defaultReturnCarrier || 'colissimo';

        // Créer l'expédition retour
        const shipmentData = {
            carrier,
            service: options.service || 'standard',
            sender: {
                firstName: order.customer.firstName,
                lastName: order.customer.lastName,
                line1: order.shippingAddress.line1,
                line2: order.shippingAddress.line2,
                city: order.shippingAddress.city,
                postalCode: order.shippingAddress.postalCode,
                country: order.shippingAddress.country,
                phone: order.customer.phone,
                email: order.customer.email
            },
            recipient: {
                company: warehouse.name,
                line1: warehouse.address.line1,
                city: warehouse.address.city,
                postalCode: warehouse.address.postalCode,
                country: warehouse.address.country,
                phone: warehouse.contact.phone
            },
            parcels: [{
                weight: this.estimateReturnWeight(returnRequest.items),
                reference: returnRequest.rmaNumber
            }],
            options: {
                returnLabel: true,
                reference: returnRequest.rmaNumber
            }
        };

        const label = await this.carriers.createShipment(carrier, shipmentData);

        returnRequest.returnShipping = {
            method: carrier,
            carrier: carrier,
            trackingNumber: label.trackingNumber,
            labelUrl: label.labelUrl,
            labelBase64: label.labelBase64,
            labelCreatedAt: new Date().toISOString(),
            cost: label.cost,
            paidBy: policy.labelPaidBy
        };
        returnRequest.status = 'LABEL_CREATED';
        returnRequest.timeline.push({
            status: 'LABEL_CREATED',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: `Étiquette ${carrier} créée: ${label.trackingNumber}`
        });

        await this.updateReturn(returnRequest);

        // Envoyer l'étiquette au client
        await this.notifications.send({
            type: 'return_label_created',
            to: returnRequest.customer.email,
            data: {
                returnRequest,
                labelUrl: label.labelUrl,
                trackingNumber: label.trackingNumber,
                instructions: this.getReturnInstructions(carrier)
            }
        });

        this.emit('return:label_created', returnRequest);
        return returnRequest;
    }

    // ==========================================
    // RETURN PROCESSING
    // ==========================================

    /**
     * Marquer le retour comme reçu
     */
    async markAsReceived(returnId, receivedBy, condition, notes) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');

        returnRequest.status = 'DELIVERED';
        returnRequest.receivedAt = new Date().toISOString();
        returnRequest.receivedBy = receivedBy;
        returnRequest.receivedCondition = condition; // good, damaged, incomplete
        returnRequest.timeline.push({
            status: 'DELIVERED',
            timestamp: new Date().toISOString(),
            actor: receivedBy,
            notes: notes || `Colis reçu - Condition: ${condition}`
        });

        await this.updateReturn(returnRequest);

        // Démarrer l'inspection si nécessaire
        const policy = await this.getReturnPolicy(returnRequest.organizationId);
        if (policy.requireInspection) {
            await this.startInspection(returnId);
        } else {
            await this.processResolution(returnId);
        }

        this.emit('return:received', returnRequest);
        return returnRequest;
    }

    /**
     * Démarrer l'inspection
     */
    async startInspection(returnId) {
        const returnRequest = await this.getReturn(returnId);
        
        returnRequest.status = 'INSPECTING';
        returnRequest.inspectionStartedAt = new Date().toISOString();
        returnRequest.timeline.push({
            status: 'INSPECTING',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: 'Inspection en cours'
        });

        await this.updateReturn(returnRequest);
        this.emit('return:inspecting', returnRequest);
        return returnRequest;
    }

    /**
     * Compléter l'inspection
     */
    async completeInspection(returnId, inspectedBy, results) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');

        const passed = results.every(r => r.passed);
        
        returnRequest.inspection = {
            completedAt: new Date().toISOString(),
            completedBy: inspectedBy,
            passed,
            results: results.map(r => ({
                itemSku: r.sku,
                condition: r.condition,
                passed: r.passed,
                notes: r.notes,
                photos: r.photos
            }))
        };

        returnRequest.status = passed ? 'INSPECTION_PASSED' : 'INSPECTION_FAILED';
        returnRequest.timeline.push({
            status: returnRequest.status,
            timestamp: new Date().toISOString(),
            actor: inspectedBy,
            notes: passed ? 'Inspection validée' : 'Inspection échouée - ' + results.filter(r => !r.passed).map(r => r.notes).join(', ')
        });

        await this.updateReturn(returnRequest);

        if (passed) {
            await this.processResolution(returnId);
        } else {
            // Notifier le client du problème
            await this.notifications.send({
                type: 'return_inspection_failed',
                to: returnRequest.customer.email,
                data: { returnRequest, results }
            });
        }

        this.emit('return:inspection_completed', returnRequest);
        return returnRequest;
    }

    /**
     * Traiter la résolution (remboursement, échange, avoir)
     */
    async processResolution(returnId) {
        const returnRequest = await this.getReturn(returnId);
        if (!returnRequest) throw new Error('Retour introuvable');

        switch (returnRequest.resolution) {
            case 'refund':
                await this.processRefund(returnRequest);
                break;
            case 'exchange':
                await this.processExchange(returnRequest);
                break;
            case 'store_credit':
                await this.processStoreCredit(returnRequest);
                break;
        }

        return returnRequest;
    }

    /**
     * Traiter le remboursement
     */
    async processRefund(returnRequest) {
        returnRequest.status = 'REFUND_PENDING';
        returnRequest.timeline.push({
            status: 'REFUND_PENDING',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: 'Remboursement en cours de traitement'
        });

        await this.updateReturn(returnRequest);

        // Calculer le montant final
        let refundAmount = returnRequest.refundAmount - returnRequest.restockingFee;
        if (returnRequest.shippingRefund) {
            refundAmount += returnRequest.originalShippingCost;
        }

        // Effectuer le remboursement
        const refund = await this.refundService.createRefund({
            orderId: returnRequest.orderId,
            returnId: returnRequest.id,
            amount: refundAmount,
            reason: `Retour ${returnRequest.rmaNumber}: ${returnRequest.reason}`,
            items: returnRequest.items
        });

        returnRequest.refund = {
            id: refund.id,
            amount: refundAmount,
            method: refund.method,
            processedAt: new Date().toISOString()
        };
        returnRequest.status = 'REFUNDED';
        returnRequest.completedAt = new Date().toISOString();
        returnRequest.timeline.push({
            status: 'REFUNDED',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: `Remboursement de ${refundAmount}€ effectué`
        });

        await this.updateReturn(returnRequest);

        await this.notifications.send({
            type: 'return_refunded',
            to: returnRequest.customer.email,
            data: { returnRequest, refundAmount }
        });

        this.emit('return:refunded', returnRequest);
    }

    /**
     * Traiter l'échange
     */
    async processExchange(returnRequest) {
        // Créer une nouvelle commande d'échange
        const exchangeOrder = await this.createExchangeOrder(returnRequest);

        returnRequest.exchange = {
            orderId: exchangeOrder.id,
            orderNumber: exchangeOrder.orderNumber,
            createdAt: new Date().toISOString()
        };
        returnRequest.status = 'EXCHANGED';
        returnRequest.completedAt = new Date().toISOString();
        returnRequest.timeline.push({
            status: 'EXCHANGED',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: `Commande d'échange créée: ${exchangeOrder.orderNumber}`
        });

        await this.updateReturn(returnRequest);

        await this.notifications.send({
            type: 'return_exchanged',
            to: returnRequest.customer.email,
            data: { returnRequest, exchangeOrder }
        });

        this.emit('return:exchanged', returnRequest);
    }

    /**
     * Émettre un avoir
     */
    async processStoreCredit(returnRequest) {
        const creditAmount = returnRequest.refundAmount - returnRequest.restockingFee;

        const storeCredit = await this.createStoreCredit({
            customerId: returnRequest.customerId,
            amount: creditAmount,
            reason: `Retour ${returnRequest.rmaNumber}`,
            returnId: returnRequest.id,
            expiresAt: this.addMonths(new Date(), 12)
        });

        returnRequest.storeCredit = {
            id: storeCredit.id,
            code: storeCredit.code,
            amount: creditAmount,
            createdAt: new Date().toISOString(),
            expiresAt: storeCredit.expiresAt
        };
        returnRequest.status = 'STORE_CREDIT';
        returnRequest.completedAt = new Date().toISOString();
        returnRequest.timeline.push({
            status: 'STORE_CREDIT',
            timestamp: new Date().toISOString(),
            actor: 'system',
            notes: `Avoir de ${creditAmount}€ émis: ${storeCredit.code}`
        });

        await this.updateReturn(returnRequest);

        await this.notifications.send({
            type: 'return_store_credit',
            to: returnRequest.customer.email,
            data: { returnRequest, storeCredit }
        });

        this.emit('return:store_credit', returnRequest);
    }

    // ==========================================
    // ANALYTICS
    // ==========================================

    /**
     * Obtenir les statistiques de retours
     */
    async getReturnAnalytics(orgId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const stats = await this.db.query(`
            SELECT 
                COUNT(*) as total_returns,
                SUM(CASE WHEN status = 'REFUNDED' THEN refund_amount ELSE 0 END) as total_refunded,
                AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/86400) as avg_processing_days,
                COUNT(CASE WHEN status = 'REFUNDED' THEN 1 END) as refunded_count,
                COUNT(CASE WHEN status = 'EXCHANGED' THEN 1 END) as exchanged_count,
                COUNT(CASE WHEN status = 'STORE_CREDIT' THEN 1 END) as store_credit_count,
                COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_count
            FROM returns 
            WHERE organization_id = $1 AND created_at >= $2
        `, [orgId, startDate]);

        const byReason = await this.db.query(`
            SELECT reason_code, COUNT(*) as count
            FROM returns 
            WHERE organization_id = $1 AND created_at >= $2
            GROUP BY reason_code
            ORDER BY count DESC
        `, [orgId, startDate]);

        const byProduct = await this.db.query(`
            SELECT 
                item->>'sku' as sku,
                item->>'name' as name,
                COUNT(*) as return_count,
                SUM((item->>'quantity')::int) as total_quantity
            FROM returns, jsonb_array_elements(items) as item
            WHERE organization_id = $1 AND created_at >= $2
            GROUP BY item->>'sku', item->>'name'
            ORDER BY return_count DESC
            LIMIT 10
        `, [orgId, startDate]);

        const trend = await this.db.query(`
            SELECT 
                DATE_TRUNC('day', created_at) as date,
                COUNT(*) as count
            FROM returns 
            WHERE organization_id = $1 AND created_at >= $2
            GROUP BY DATE_TRUNC('day', created_at)
            ORDER BY date
        `, [orgId, startDate]);

        return {
            summary: stats.rows[0],
            byReason: byReason.rows,
            byProduct: byProduct.rows,
            trend: trend.rows,
            returnRate: await this.calculateReturnRate(orgId, periodDays)
        };
    }

    /**
     * Calculer le taux de retour
     */
    async calculateReturnRate(orgId, days) {
        const result = await this.db.query(`
            SELECT 
                (SELECT COUNT(*) FROM returns WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days') as returns,
                (SELECT COUNT(*) FROM orders WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '${days} days') as orders
        `, [orgId]);

        const { returns, orders } = result.rows[0];
        return orders > 0 ? (returns / orders * 100).toFixed(2) : 0;
    }

    // ==========================================
    // HELPERS
    // ==========================================

    generateId(prefix = 'ret') {
        return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    }

    generateRMANumber() {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = crypto.randomBytes(2).toString('hex').toUpperCase();
        return `RMA-${timestamp}${random}`;
    }

    getReasonCategory(reasonCode) {
        const reason = this.returnReasons.find(r => r.code === reasonCode);
        return reason?.category || 'other';
    }

    calculateRefundAmount(items, policy) {
        return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    }

    calculateRestockingFee(items, reasonCode, policy) {
        const reason = this.returnReasons.find(r => r.code === reasonCode);
        if (reason?.restockingFee && policy.restockingFeePercent > 0) {
            const itemsTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            return itemsTotal * (policy.restockingFeePercent / 100);
        }
        return 0;
    }

    shouldRefundShipping(reasonCode, policy) {
        const merchantFaultReasons = ['DAMAGED_IN_TRANSIT', 'DEFECTIVE', 'WRONG_ITEM', 'MISSING_PARTS', 'NOT_AS_DESCRIBED'];
        return merchantFaultReasons.includes(reasonCode);
    }

    estimateReturnWeight(items) {
        // Estimation basique - en production, utiliser les poids produits
        return Math.max(0.5, items.reduce((sum, item) => sum + (item.weight || 0.3) * item.quantity, 0));
    }

    calculateExpiryDate(days) {
        return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    addMonths(date, months) {
        const d = new Date(date);
        d.setMonth(d.getMonth() + months);
        return d.toISOString();
    }

    getReturnInstructions(carrier) {
        const instructions = {
            colissimo: 'Déposez votre colis dans un bureau de poste ou un point relais.',
            chronopost: 'Déposez votre colis dans un point Chronopost ou planifiez un enlèvement.',
            mondial_relay: 'Déposez votre colis dans un Point Relay®.',
            dhl: 'Planifiez un enlèvement DHL ou déposez dans un point de service.'
        };
        return instructions[carrier] || 'Suivez les instructions de votre transporteur.';
    }

    async getReturn(returnId) {
        const result = await this.db.query('SELECT * FROM returns WHERE id = $1', [returnId]);
        return result.rows[0];
    }

    async updateReturn(returnRequest) {
        returnRequest.updatedAt = new Date().toISOString();
        await this.db.query(
            'UPDATE returns SET status = $1, items = $2, timeline = $3, updated_at = $4 WHERE id = $5',
            [returnRequest.status, JSON.stringify(returnRequest.items), JSON.stringify(returnRequest.timeline), 
             returnRequest.updatedAt, returnRequest.id]
        );
    }

    async getOrder(orderId) {
        const result = await this.db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        return result.rows[0];
    }

    async getWarehouse(warehouseId) {
        const result = await this.db.query('SELECT * FROM warehouses WHERE id = $1', [warehouseId]);
        return result.rows[0];
    }

    async getReturnPolicy(orgId) {
        const result = await this.db.query('SELECT return_policy FROM organizations WHERE id = $1', [orgId]);
        return { ...this.defaultPolicy, ...(result.rows[0]?.return_policy || {}) };
    }

    async getDefaultReturnWarehouse(orgId) {
        const result = await this.db.query(
            "SELECT id FROM warehouses WHERE organization_id = $1 AND type = 'return' ORDER BY priority LIMIT 1",
            [orgId]
        );
        return result.rows[0]?.id;
    }

    async createExchangeOrder(returnRequest) {
        // Implémentation à adapter selon le système de commandes
        return { id: this.generateId('ord'), orderNumber: `EXC-${Date.now()}` };
    }

    async createStoreCredit(data) {
        const code = `SC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        return { id: this.generateId('sc'), code, ...data };
    }
}

module.exports = { ReturnsService };
