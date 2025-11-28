/**
 * Routz v4.0 - Advanced Returns Management System
 * Gestion complète des retours : RMA, portail client, remboursements, analytics
 */

class ReturnsService {
    constructor(config = {}) {
        this.db = config.db;
        this.carriers = config.carriers;
        this.notifications = config.notifications;
        this.refundProviders = config.refundProviders || {};
    }

    // ==========================================
    // RMA (Return Merchandise Authorization)
    // ==========================================

    /**
     * Créer une demande de retour (RMA)
     */
    async createReturnRequest(data) {
        const rma = {
            id: this.generateId('RMA'),
            organizationId: data.organizationId,
            orderId: data.orderId,
            orderNumber: data.orderNumber,
            shipmentId: data.shipmentId,
            customerId: data.customerId,
            
            // Items à retourner
            items: data.items.map(item => ({
                id: this.generateId('ITEM'),
                orderItemId: item.orderItemId,
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                reason: item.reason,
                reasonCode: item.reasonCode,
                condition: item.condition || 'unknown', // new, used, damaged, defective
                photos: item.photos || [],
                notes: item.notes
            })),
            
            // Statut et workflow
            status: 'pending_approval', // pending_approval, approved, label_created, in_transit, received, inspecting, processed, refunded, rejected, closed
            workflow: data.workflow || 'standard', // standard, exchange, repair, store_credit
            
            // Adresses
            returnAddress: data.returnAddress,
            customerAddress: data.customerAddress,
            
            // Shipping
            carrier: null,
            trackingNumber: null,
            labelUrl: null,
            labelFormat: data.labelFormat || 'pdf',
            shippingMethod: data.shippingMethod || 'prepaid', // prepaid, customer_paid, drop_off
            
            // Financier
            originalAmount: data.originalAmount,
            refundAmount: null,
            refundMethod: data.refundMethod || 'original_payment', // original_payment, store_credit, bank_transfer
            restockingFee: 0,
            shippingDeduction: 0,
            
            // Métadonnées
            source: data.source || 'customer_portal', // customer_portal, admin, api, cs_chat
            priority: data.priority || 'normal',
            tags: data.tags || [],
            internalNotes: [],
            customerComments: data.customerComments,
            
            // Dates
            requestedAt: new Date().toISOString(),
            approvedAt: null,
            shippedAt: null,
            receivedAt: null,
            processedAt: null,
            refundedAt: null,
            closedAt: null,
            
            // SLA
            slaDeadline: this.calculateSLADeadline(data.priority),
            isOverdue: false
        };

        await this.db.query(
            `INSERT INTO returns (id, organization_id, order_id, shipment_id, customer_id, items, status, workflow, return_address, customer_address, original_amount, source, priority, requested_at, sla_deadline)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [rma.id, rma.organizationId, rma.orderId, rma.shipmentId, rma.customerId, 
             JSON.stringify(rma.items), rma.status, rma.workflow, JSON.stringify(rma.returnAddress),
             JSON.stringify(rma.customerAddress), rma.originalAmount, rma.source, rma.priority,
             rma.requestedAt, rma.slaDeadline]
        );

        // Envoyer notification au client
        await this.notifications.send({
            type: 'return_request_created',
            to: data.customerEmail,
            data: { rmaId: rma.id, orderNumber: rma.orderNumber }
        });

        return rma;
    }

    /**
     * Approuver un retour
     */
    async approveReturn(rmaId, options = {}) {
        const rma = await this.getReturn(rmaId);
        if (!rma) throw new Error('Return not found');
        if (rma.status !== 'pending_approval') throw new Error('Return cannot be approved');

        const updates = {
            status: 'approved',
            approvedAt: new Date().toISOString(),
            approvedBy: options.userId,
            refundAmount: this.calculateRefundAmount(rma, options),
            restockingFee: options.restockingFee || 0,
            shippingDeduction: options.shippingDeduction || 0
        };

        // Générer l'étiquette de retour si prepaid
        if (rma.shippingMethod === 'prepaid') {
            const label = await this.generateReturnLabel(rma, options);
            updates.carrier = label.carrier;
            updates.trackingNumber = label.trackingNumber;
            updates.labelUrl = label.labelUrl;
            updates.status = 'label_created';
        }

        await this.updateReturn(rmaId, updates);

        // Notification
        await this.notifications.send({
            type: 'return_approved',
            to: rma.customerEmail,
            data: { 
                rmaId, 
                labelUrl: updates.labelUrl,
                trackingNumber: updates.trackingNumber,
                instructions: this.getReturnInstructions(rma)
            }
        });

        return { ...rma, ...updates };
    }

    /**
     * Rejeter un retour
     */
    async rejectReturn(rmaId, reason, userId) {
        const rma = await this.getReturn(rmaId);
        if (!rma) throw new Error('Return not found');

        await this.updateReturn(rmaId, {
            status: 'rejected',
            rejectionReason: reason,
            rejectedBy: userId,
            closedAt: new Date().toISOString()
        });

        await this.notifications.send({
            type: 'return_rejected',
            to: rma.customerEmail,
            data: { rmaId, reason }
        });
    }

    /**
     * Marquer comme reçu
     */
    async markAsReceived(rmaId, receivedData) {
        const rma = await this.getReturn(rmaId);
        if (!rma) throw new Error('Return not found');

        // Inspection des items
        const inspectedItems = rma.items.map((item, i) => ({
            ...item,
            receivedQuantity: receivedData.items?.[i]?.quantity || item.quantity,
            actualCondition: receivedData.items?.[i]?.condition || 'pending_inspection',
            inspectionNotes: receivedData.items?.[i]?.notes
        }));

        await this.updateReturn(rmaId, {
            status: 'received',
            receivedAt: new Date().toISOString(),
            receivedBy: receivedData.userId,
            items: inspectedItems,
            warehouseLocation: receivedData.warehouseLocation
        });

        // Auto-process si conditions OK
        if (this.canAutoProcess(inspectedItems)) {
            await this.processReturn(rmaId, { autoProcessed: true });
        }
    }

    /**
     * Traiter le retour (inspection terminée)
     */
    async processReturn(rmaId, options = {}) {
        const rma = await this.getReturn(rmaId);
        if (!rma) throw new Error('Return not found');

        let finalRefundAmount = rma.refundAmount;
        let refundAdjustments = [];

        // Ajustements basés sur l'inspection
        for (const item of rma.items) {
            if (item.actualCondition === 'damaged' && item.originalCondition !== 'damaged') {
                const deduction = item.price * 0.3; // 30% deduction for damage
                finalRefundAmount -= deduction;
                refundAdjustments.push({
                    itemId: item.id,
                    reason: 'damage_deduction',
                    amount: -deduction
                });
            }
        }

        await this.updateReturn(rmaId, {
            status: 'processed',
            processedAt: new Date().toISOString(),
            processedBy: options.userId,
            finalRefundAmount,
            refundAdjustments,
            autoProcessed: options.autoProcessed || false
        });

        // Initier le remboursement selon le workflow
        if (rma.workflow === 'standard' || rma.workflow === 'store_credit') {
            await this.initiateRefund(rmaId);
        } else if (rma.workflow === 'exchange') {
            await this.initiateExchange(rmaId);
        }

        // Mettre à jour le stock
        await this.updateInventory(rma);
    }

    /**
     * Initier le remboursement
     */
    async initiateRefund(rmaId) {
        const rma = await this.getReturn(rmaId);
        if (!rma) throw new Error('Return not found');

        let refundResult;

        switch (rma.refundMethod) {
            case 'original_payment':
                refundResult = await this.refundToOriginalPayment(rma);
                break;
            case 'store_credit':
                refundResult = await this.issueStoreCredit(rma);
                break;
            case 'bank_transfer':
                refundResult = await this.initiateBankTransfer(rma);
                break;
        }

        await this.updateReturn(rmaId, {
            status: 'refunded',
            refundedAt: new Date().toISOString(),
            refundTransactionId: refundResult.transactionId,
            refundStatus: refundResult.status
        });

        await this.notifications.send({
            type: 'refund_processed',
            to: rma.customerEmail,
            data: {
                rmaId,
                amount: rma.finalRefundAmount,
                method: rma.refundMethod,
                transactionId: refundResult.transactionId
            }
        });

        return refundResult;
    }

    // ==========================================
    // RETURN LABEL GENERATION
    // ==========================================

    async generateReturnLabel(rma, options = {}) {
        const carrier = options.carrier || await this.selectReturnCarrier(rma);
        
        const labelRequest = {
            carrier: carrier.code,
            service: carrier.returnService || 'standard',
            sender: rma.customerAddress,
            recipient: rma.returnAddress,
            parcels: [{
                weight: this.estimateReturnWeight(rma.items),
                reference: rma.id
            }],
            options: {
                isReturn: true,
                originalShipmentId: rma.shipmentId
            }
        };

        const label = await this.carriers.createLabel(labelRequest);

        return {
            carrier: carrier.code,
            trackingNumber: label.trackingNumber,
            labelUrl: label.labelUrl,
            labelBase64: label.labelBase64
        };
    }

    async selectReturnCarrier(rma) {
        // Logique de sélection du transporteur pour retour
        const originalShipment = await this.db.query(
            'SELECT carrier FROM shipments WHERE id = $1',
            [rma.shipmentId]
        );

        // Utiliser le même transporteur si possible
        if (originalShipment.rows[0]?.carrier) {
            return { code: originalShipment.rows[0].carrier, returnService: 'standard' };
        }

        // Sinon utiliser le transporteur par défaut pour les retours
        return { code: 'colissimo', returnService: 'retour' };
    }

    // ==========================================
    // RETURN REASONS MANAGEMENT
    // ==========================================

    getReturnReasons() {
        return [
            { code: 'SIZE_TOO_SMALL', label: 'Taille trop petite', category: 'size', refundable: true },
            { code: 'SIZE_TOO_LARGE', label: 'Taille trop grande', category: 'size', refundable: true },
            { code: 'WRONG_ITEM', label: 'Article incorrect reçu', category: 'error', refundable: true, priority: 'high' },
            { code: 'DEFECTIVE', label: 'Article défectueux', category: 'quality', refundable: true, priority: 'high' },
            { code: 'DAMAGED_SHIPPING', label: 'Endommagé pendant le transport', category: 'shipping', refundable: true, priority: 'high' },
            { code: 'NOT_AS_DESCRIBED', label: 'Ne correspond pas à la description', category: 'description', refundable: true },
            { code: 'QUALITY_NOT_EXPECTED', label: 'Qualité inférieure aux attentes', category: 'quality', refundable: true },
            { code: 'CHANGED_MIND', label: 'Changement d\'avis', category: 'customer', refundable: true, restockingFee: true },
            { code: 'ORDERED_BY_MISTAKE', label: 'Commandé par erreur', category: 'customer', refundable: true, restockingFee: true },
            { code: 'BETTER_PRICE', label: 'Trouvé moins cher ailleurs', category: 'customer', refundable: true, restockingFee: true },
            { code: 'ARRIVED_TOO_LATE', label: 'Arrivé trop tard', category: 'shipping', refundable: true },
            { code: 'MISSING_PARTS', label: 'Pièces manquantes', category: 'quality', refundable: true, priority: 'high' },
            { code: 'OTHER', label: 'Autre raison', category: 'other', refundable: true }
        ];
    }

    // ==========================================
    // ANALYTICS & REPORTING
    // ==========================================

    async getReturnAnalytics(orgId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const stats = await this.db.query(`
            SELECT 
                COUNT(*) as total_returns,
                COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded,
                COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
                COUNT(CASE WHEN status IN ('pending_approval', 'approved', 'label_created', 'in_transit', 'received', 'inspecting', 'processed') THEN 1 END) as pending,
                SUM(CASE WHEN status = 'refunded' THEN final_refund_amount ELSE 0 END) as total_refunded,
                AVG(EXTRACT(EPOCH FROM (refunded_at - requested_at))/86400) as avg_processing_days
            FROM returns 
            WHERE organization_id = $1 AND requested_at >= $2
        `, [orgId, startDate.toISOString()]);

        const byReason = await this.db.query(`
            SELECT 
                item->>'reasonCode' as reason_code,
                COUNT(*) as count
            FROM returns, jsonb_array_elements(items) as item
            WHERE organization_id = $1 AND requested_at >= $2
            GROUP BY item->>'reasonCode'
            ORDER BY count DESC
        `, [orgId, startDate.toISOString()]);

        const byProduct = await this.db.query(`
            SELECT 
                item->>'sku' as sku,
                item->>'name' as name,
                COUNT(*) as return_count,
                SUM((item->>'quantity')::int) as total_quantity
            FROM returns, jsonb_array_elements(items) as item
            WHERE organization_id = $1 AND requested_at >= $2
            GROUP BY item->>'sku', item->>'name'
            ORDER BY return_count DESC
            LIMIT 20
        `, [orgId, startDate.toISOString()]);

        // Calculer le taux de retour
        const ordersCount = await this.db.query(`
            SELECT COUNT(*) as total FROM orders 
            WHERE organization_id = $1 AND created_at >= $2
        `, [orgId, startDate.toISOString()]);

        const returnRate = ordersCount.rows[0]?.total > 0 
            ? (stats.rows[0].total_returns / ordersCount.rows[0].total * 100).toFixed(2)
            : 0;

        return {
            summary: {
                ...stats.rows[0],
                return_rate: returnRate,
                period: periodDays
            },
            byReason: byReason.rows,
            topReturnedProducts: byProduct.rows,
            trends: await this.getReturnTrends(orgId, periodDays)
        };
    }

    async getReturnTrends(orgId, days) {
        const result = await this.db.query(`
            SELECT 
                DATE(requested_at) as date,
                COUNT(*) as returns,
                SUM(final_refund_amount) as refund_amount
            FROM returns
            WHERE organization_id = $1 AND requested_at >= NOW() - INTERVAL '${days} days'
            GROUP BY DATE(requested_at)
            ORDER BY date
        `, [orgId]);

        return result.rows;
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getReturn(rmaId) {
        const result = await this.db.query('SELECT * FROM returns WHERE id = $1', [rmaId]);
        return result.rows[0];
    }

    async updateReturn(rmaId, updates) {
        const fields = Object.keys(updates).map((k, i) => `${this.toSnakeCase(k)} = $${i + 2}`);
        const values = Object.values(updates).map(v => typeof v === 'object' ? JSON.stringify(v) : v);
        
        await this.db.query(
            `UPDATE returns SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1`,
            [rmaId, ...values]
        );
    }

    async listReturns(orgId, filters = {}) {
        let query = 'SELECT * FROM returns WHERE organization_id = $1';
        const params = [orgId];
        let idx = 2;

        if (filters.status) {
            query += ` AND status = $${idx}`;
            params.push(filters.status);
            idx++;
        }

        if (filters.customerId) {
            query += ` AND customer_id = $${idx}`;
            params.push(filters.customerId);
            idx++;
        }

        query += ' ORDER BY requested_at DESC';

        if (filters.limit) {
            query += ` LIMIT $${idx}`;
            params.push(filters.limit);
        }

        const result = await this.db.query(query, params);
        return result.rows;
    }

    calculateRefundAmount(rma, options = {}) {
        let amount = rma.originalAmount;
        
        if (options.restockingFee) {
            amount -= options.restockingFee;
        }
        
        if (options.shippingDeduction) {
            amount -= options.shippingDeduction;
        }

        return Math.max(0, amount);
    }

    calculateSLADeadline(priority) {
        const slaDays = { high: 2, normal: 5, low: 10 };
        const days = slaDays[priority] || 5;
        return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    canAutoProcess(items) {
        return items.every(item => 
            item.receivedQuantity === item.quantity && 
            ['new', 'like_new'].includes(item.actualCondition)
        );
    }

    estimateReturnWeight(items) {
        return items.reduce((sum, item) => sum + (item.weight || 0.5) * item.quantity, 0);
    }

    getReturnInstructions(rma) {
        return {
            steps: [
                'Imprimez l\'étiquette de retour ci-jointe',
                'Emballez soigneusement les articles dans leur emballage d\'origine',
                'Collez l\'étiquette sur le colis',
                'Déposez le colis dans un point relais ou bureau de poste'
            ],
            deadline: '14 jours',
            dropOffLocations: 'Tous les bureaux de poste et points relais'
        };
    }

    generateId(prefix = 'RET') {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`.toUpperCase();
    }

    toSnakeCase(str) {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    }

    async refundToOriginalPayment(rma) {
        // Intégration Stripe refund
        return { transactionId: `ref_${Date.now()}`, status: 'completed' };
    }

    async issueStoreCredit(rma) {
        return { transactionId: `credit_${Date.now()}`, status: 'completed' };
    }

    async initiateBankTransfer(rma) {
        return { transactionId: `bank_${Date.now()}`, status: 'pending' };
    }

    async updateInventory(rma) {
        // Remettre en stock les articles retournés en bon état
        for (const item of rma.items) {
            if (['new', 'like_new'].includes(item.actualCondition)) {
                await this.db.query(
                    `UPDATE inventory SET quantity = quantity + $1 WHERE sku = $2`,
                    [item.receivedQuantity, item.sku]
                );
            }
        }
    }

    async initiateExchange(rmaId) {
        // Créer une nouvelle commande d'échange
        const rma = await this.getReturn(rmaId);
        // Logic for exchange order creation
    }
}

module.exports = { ReturnsService };
