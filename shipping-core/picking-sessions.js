/**
 * ROUTZ - WMS Picking Sessions Service
 * Gestion avancée des sessions de picking avec optimisation et validation par scan
 * Comparable à ShippingBo WMS Pro
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Event emitter for real-time updates
const pickingEvents = new EventEmitter();

// ============================================
// PICKING STRATEGIES
// ============================================

const PICKING_STRATEGIES = {
    // Single order picking (1 order at a time)
    SINGLE: {
        id: 'single',
        name: 'Commande unique',
        description: 'Une commande à la fois, idéal pour débutants',
        maxOrders: 1,
        requiresCart: false,
        efficiency: 'low'
    },
    
    // Batch picking (multiple orders, sorted by location)
    BATCH: {
        id: 'batch',
        name: 'Picking par lot',
        description: 'Plusieurs commandes regroupées par zone',
        maxOrders: 20,
        requiresCart: true,
        efficiency: 'high'
    },
    
    // Wave picking (time-based batches)
    WAVE: {
        id: 'wave',
        name: 'Picking par vague',
        description: 'Commandes regroupées par créneau de départ transporteur',
        maxOrders: 50,
        requiresCart: true,
        efficiency: 'high'
    },
    
    // Zone picking (each picker handles specific zones)
    ZONE: {
        id: 'zone',
        name: 'Picking par zone',
        description: 'Chaque préparateur gère des zones spécifiques',
        maxOrders: 30,
        requiresCart: true,
        efficiency: 'very_high'
    },
    
    // Cluster picking (orders grouped by similar items)
    CLUSTER: {
        id: 'cluster',
        name: 'Picking par cluster',
        description: 'Commandes groupées par produits similaires',
        maxOrders: 25,
        requiresCart: true,
        efficiency: 'very_high'
    }
};

// ============================================
// PICKING SESSION SERVICE
// ============================================

class PickingSessionService {
    constructor() {
        this.activeSessions = new Map();
    }

    // ----------------------------------------
    // SESSION MANAGEMENT
    // ----------------------------------------

    /**
     * Create a new picking session
     */
    async createSession(params) {
        const {
            orgId,
            warehouseId,
            pickerId,
            pickerName,
            strategy = 'BATCH',
            orderIds,
            carrierFilter,
            priorityFilter,
            maxOrders,
            zones
        } = params;

        // Validate strategy
        const strategyConfig = PICKING_STRATEGIES[strategy];
        if (!strategyConfig) {
            throw new Error(`Invalid picking strategy: ${strategy}`);
        }

        // Get orders to pick
        let orders;
        if (orderIds && orderIds.length > 0) {
            orders = await this.getOrdersByIds(orgId, orderIds);
        } else {
            orders = await this.getOrdersToPick({
                orgId,
                warehouseId,
                carrierFilter,
                priorityFilter,
                maxOrders: maxOrders || strategyConfig.maxOrders,
                zones
            });
        }

        if (orders.length === 0) {
            throw new Error('No orders available for picking');
        }

        // Extract items and optimize route
        const pickingList = await this.generatePickingList(orders, warehouseId, strategy);
        
        // Create session
        const session = {
            id: uuidv4(),
            organization_id: orgId,
            warehouse_id: warehouseId,
            picker_id: pickerId,
            picker_name: pickerName,
            
            strategy,
            status: 'in_progress',
            
            orders: orders.map(o => ({
                id: o.id,
                order_number: o.order_number,
                items_count: o.items?.length || 0,
                priority: o.priority,
                carrier: o.carrier,
                picked: false
            })),
            
            picking_list: pickingList,
            
            // Stats
            total_items: pickingList.reduce((sum, item) => sum + item.quantity, 0),
            picked_items: 0,
            total_orders: orders.length,
            completed_orders: 0,
            
            // Timestamps
            started_at: new Date().toISOString(),
            estimated_duration: this.estimateDuration(pickingList, strategy),
            
            // Validation
            scan_required: true,
            errors: []
        };

        // Save to database
        await db.query(`
            INSERT INTO picking_sessions (
                id, organization_id, warehouse_id, picker_id, picker_name,
                strategy, status, orders, picking_list, 
                total_items, picked_items, total_orders, completed_orders,
                started_at, estimated_duration, scan_required
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [
            session.id, session.organization_id, session.warehouse_id,
            session.picker_id, session.picker_name, session.strategy,
            session.status, JSON.stringify(session.orders), JSON.stringify(session.picking_list),
            session.total_items, session.picked_items, session.total_orders,
            session.completed_orders, session.started_at, session.estimated_duration,
            session.scan_required
        ]);

        // Mark orders as in picking
        await this.markOrdersInPicking(orders.map(o => o.id), session.id);

        // Cache active session
        this.activeSessions.set(session.id, session);
        await redis.setex(`picking_session:${session.id}`, 3600 * 8, JSON.stringify(session));

        // Emit event
        pickingEvents.emit('session:created', { sessionId: session.id, pickerId });

        return session;
    }

    /**
     * Get orders available for picking
     */
    async getOrdersToPick(params) {
        const { orgId, warehouseId, carrierFilter, priorityFilter, maxOrders, zones } = params;

        let query = `
            SELECT o.*, 
                   w.name as warehouse_name,
                   COALESCE(o.priority, 'normal') as priority
            FROM orders o
            LEFT JOIN warehouses w ON o.warehouse_id = w.id
            WHERE o.organization_id = $1
            AND o.status = 'pending_fulfillment'
            AND o.picking_session_id IS NULL
            AND o.warehouse_id = $2
        `;
        const queryParams = [orgId, warehouseId];
        let paramIndex = 3;

        // Carrier filter
        if (carrierFilter && carrierFilter.length > 0) {
            query += ` AND o.carrier = ANY($${paramIndex})`;
            queryParams.push(carrierFilter);
            paramIndex++;
        }

        // Priority filter
        if (priorityFilter) {
            query += ` AND o.priority = $${paramIndex}`;
            queryParams.push(priorityFilter);
            paramIndex++;
        }

        // Order by priority then oldest first
        query += ` ORDER BY 
            CASE o.priority 
                WHEN 'urgent' THEN 1 
                WHEN 'high' THEN 2 
                WHEN 'normal' THEN 3 
                WHEN 'low' THEN 4 
                ELSE 5 
            END,
            o.created_at ASC
            LIMIT $${paramIndex}
        `;
        queryParams.push(maxOrders);

        const result = await db.query(query, queryParams);
        return result.rows;
    }

    /**
     * Generate optimized picking list
     */
    async generatePickingList(orders, warehouseId, strategy) {
        // Aggregate items across all orders
        const itemsMap = new Map();
        
        for (const order of orders) {
            const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
            
            for (const item of items) {
                const key = item.sku || item.product_id;
                
                if (itemsMap.has(key)) {
                    const existing = itemsMap.get(key);
                    existing.quantity += item.quantity;
                    existing.orders.push({
                        orderId: order.id,
                        orderNumber: order.order_number,
                        quantity: item.quantity
                    });
                } else {
                    // Get product location
                    const location = await this.getProductLocation(warehouseId, key);
                    
                    itemsMap.set(key, {
                        sku: key,
                        name: item.name,
                        quantity: item.quantity,
                        location,
                        barcode: item.barcode || item.ean || item.upc,
                        image: item.image,
                        weight: item.weight,
                        orders: [{
                            orderId: order.id,
                            orderNumber: order.order_number,
                            quantity: item.quantity
                        }],
                        picked_quantity: 0,
                        status: 'pending'
                    });
                }
            }
        }

        // Convert to array
        let pickingList = Array.from(itemsMap.values());

        // Optimize route based on strategy
        pickingList = this.optimizePickingRoute(pickingList, strategy);

        // Add sequence numbers
        pickingList.forEach((item, index) => {
            item.sequence = index + 1;
        });

        return pickingList;
    }

    /**
     * Optimize picking route based on warehouse layout
     */
    optimizePickingRoute(items, strategy) {
        // Sort by location for efficient walking path
        return items.sort((a, b) => {
            const locA = a.location || {};
            const locB = b.location || {};
            
            // Sort by zone first
            if (locA.zone !== locB.zone) {
                return (locA.zone || '').localeCompare(locB.zone || '');
            }
            
            // Then by aisle
            if (locA.aisle !== locB.aisle) {
                return (locA.aisle || '').localeCompare(locB.aisle || '');
            }
            
            // Then by rack (serpentine pattern for efficiency)
            const aisleNum = parseInt(locA.aisle) || 0;
            const rackA = parseInt(locA.rack) || 0;
            const rackB = parseInt(locB.rack) || 0;
            
            // Alternate direction on odd/even aisles
            if (aisleNum % 2 === 0) {
                return rackA - rackB;
            } else {
                return rackB - rackA;
            }
        });
    }

    async getProductLocation(warehouseId, sku) {
        const result = await db.query(`
            SELECT zone, aisle, rack, shelf, bin, quantity
            FROM inventory_locations
            WHERE warehouse_id = $1 AND sku = $2
            ORDER BY quantity DESC
            LIMIT 1
        `, [warehouseId, sku]);

        if (result.rows.length > 0) {
            const loc = result.rows[0];
            return {
                zone: loc.zone,
                aisle: loc.aisle,
                rack: loc.rack,
                shelf: loc.shelf,
                bin: loc.bin,
                formatted: `${loc.zone || ''}-${loc.aisle || ''}-${loc.rack || ''}-${loc.shelf || ''}${loc.bin ? '-' + loc.bin : ''}`.replace(/^-+|-+$/g, ''),
                available_quantity: loc.quantity
            };
        }

        return { formatted: 'Non assigné', zone: null };
    }

    estimateDuration(pickingList, strategy) {
        // Base time per item (seconds)
        const baseTimePerItem = 15;
        
        // Walking time estimate (based on unique locations)
        const uniqueLocations = new Set(pickingList.map(i => i.location?.formatted)).size;
        const walkingTime = uniqueLocations * 20; // 20 seconds per location change
        
        // Total items
        const totalItems = pickingList.reduce((sum, i) => sum + i.quantity, 0);
        
        // Calculate total time
        const totalSeconds = (totalItems * baseTimePerItem) + walkingTime;
        
        // Apply strategy efficiency modifier
        const efficiencyModifiers = {
            SINGLE: 1.5,
            BATCH: 1.0,
            WAVE: 0.9,
            ZONE: 0.8,
            CLUSTER: 0.85
        };
        
        const modifier = efficiencyModifiers[strategy] || 1.0;
        const adjustedSeconds = Math.round(totalSeconds * modifier);
        
        // Return in minutes
        return Math.ceil(adjustedSeconds / 60);
    }

    // ----------------------------------------
    // SCAN VALIDATION
    // ----------------------------------------

    /**
     * Validate item pick by barcode scan
     */
    async validateScan(params) {
        const { sessionId, barcode, quantity = 1, locationScan } = params;

        // Get session
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        if (session.status !== 'in_progress') {
            throw new Error('Session is not active');
        }

        // Find item in picking list
        const pickingList = session.picking_list;
        const itemIndex = pickingList.findIndex(item => 
            item.barcode === barcode || 
            item.sku === barcode ||
            item.sku?.toLowerCase() === barcode?.toLowerCase()
        );

        if (itemIndex === -1) {
            // Log error
            const error = {
                type: 'wrong_item',
                scanned: barcode,
                timestamp: new Date().toISOString(),
                message: 'Article non trouvé dans la liste de picking'
            };
            
            await this.logPickingError(sessionId, error);
            
            return {
                valid: false,
                error: 'ITEM_NOT_FOUND',
                message: 'Cet article ne fait pas partie de cette session de picking',
                scanned: barcode
            };
        }

        const item = pickingList[itemIndex];

        // Check if already fully picked
        if (item.picked_quantity >= item.quantity) {
            return {
                valid: false,
                error: 'ALREADY_PICKED',
                message: 'Cet article a déjà été entièrement pické',
                item: {
                    sku: item.sku,
                    name: item.name,
                    required: item.quantity,
                    picked: item.picked_quantity
                }
            };
        }

        // Validate location if required
        if (locationScan && session.scan_required) {
            const expectedLocation = item.location?.formatted;
            if (locationScan !== expectedLocation) {
                const error = {
                    type: 'wrong_location',
                    expected: expectedLocation,
                    scanned: locationScan,
                    sku: item.sku,
                    timestamp: new Date().toISOString()
                };
                
                await this.logPickingError(sessionId, error);
                
                return {
                    valid: false,
                    error: 'WRONG_LOCATION',
                    message: `Mauvais emplacement. Attendu: ${expectedLocation}`,
                    expected: expectedLocation,
                    scanned: locationScan
                };
            }
        }

        // Check quantity doesn't exceed required
        const newPickedQty = item.picked_quantity + quantity;
        if (newPickedQty > item.quantity) {
            return {
                valid: false,
                error: 'QUANTITY_EXCEEDED',
                message: `Quantité maximale atteinte (${item.quantity})`,
                required: item.quantity,
                alreadyPicked: item.picked_quantity
            };
        }

        // Update item
        item.picked_quantity = newPickedQty;
        item.status = newPickedQty >= item.quantity ? 'picked' : 'partial';
        item.last_scan = new Date().toISOString();

        // Update session stats
        session.picked_items += quantity;

        // Check if all items for any order are complete
        await this.checkOrderCompletion(session, item);

        // Save session
        await this.saveSession(session);

        // Emit event
        pickingEvents.emit('item:picked', {
            sessionId,
            sku: item.sku,
            quantity,
            progress: {
                picked: session.picked_items,
                total: session.total_items,
                percentage: Math.round((session.picked_items / session.total_items) * 100)
            }
        });

        return {
            valid: true,
            item: {
                sku: item.sku,
                name: item.name,
                required: item.quantity,
                picked: item.picked_quantity,
                remaining: item.quantity - item.picked_quantity,
                status: item.status
            },
            progress: {
                picked: session.picked_items,
                total: session.total_items,
                percentage: Math.round((session.picked_items / session.total_items) * 100),
                completedOrders: session.completed_orders,
                totalOrders: session.total_orders
            },
            nextItem: this.getNextItem(session)
        };
    }

    /**
     * Manual pick (without scan)
     */
    async manualPick(params) {
        const { sessionId, sku, quantity, reason } = params;

        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        const item = session.picking_list.find(i => i.sku === sku);
        if (!item) throw new Error('Item not found');

        // Log manual pick
        await this.logPickingEvent(sessionId, {
            type: 'manual_pick',
            sku,
            quantity,
            reason,
            timestamp: new Date().toISOString()
        });

        // Process as normal pick
        item.picked_quantity += quantity;
        item.status = item.picked_quantity >= item.quantity ? 'picked' : 'partial';
        item.manual_pick = true;

        session.picked_items += quantity;

        await this.checkOrderCompletion(session, item);
        await this.saveSession(session);

        return { success: true, item };
    }

    /**
     * Report item shortage/stockout
     */
    async reportShortage(params) {
        const { sessionId, sku, expectedQuantity, actualQuantity, reason } = params;

        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        const item = session.picking_list.find(i => i.sku === sku);
        if (!item) throw new Error('Item not found');

        const shortage = expectedQuantity - actualQuantity;

        // Log shortage
        await db.query(`
            INSERT INTO inventory_shortages (
                organization_id, warehouse_id, session_id, sku, 
                expected_quantity, actual_quantity, shortage, reason
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            session.organization_id, session.warehouse_id, sessionId,
            sku, expectedQuantity, actualQuantity, shortage, reason
        ]);

        // Update item
        item.shortage = shortage;
        item.shortage_reason = reason;
        item.status = 'shortage';

        // Mark affected orders
        for (const orderRef of item.orders) {
            const order = session.orders.find(o => o.id === orderRef.orderId);
            if (order) {
                order.has_shortage = true;
            }
        }

        session.errors.push({
            type: 'shortage',
            sku,
            shortage,
            reason,
            timestamp: new Date().toISOString()
        });

        await this.saveSession(session);

        // Emit event for inventory update
        pickingEvents.emit('shortage:reported', {
            sessionId,
            sku,
            shortage,
            warehouseId: session.warehouse_id
        });

        return { success: true, shortage, affectedOrders: item.orders.length };
    }

    // ----------------------------------------
    // ORDER COMPLETION
    // ----------------------------------------

    async checkOrderCompletion(session, pickedItem) {
        // For each order that contains this item
        for (const orderRef of pickedItem.orders) {
            const order = session.orders.find(o => o.id === orderRef.orderId);
            if (!order || order.picked) continue;

            // Check if all items for this order are picked
            const orderItems = session.picking_list.filter(item =>
                item.orders.some(o => o.orderId === order.id)
            );

            const allPicked = orderItems.every(item => {
                const orderQty = item.orders.find(o => o.orderId === order.id)?.quantity || 0;
                // Calculate how much of this item's picked quantity belongs to this order
                const pickedForOrder = Math.min(item.picked_quantity, orderQty);
                return pickedForOrder >= orderQty;
            });

            if (allPicked) {
                order.picked = true;
                order.picked_at = new Date().toISOString();
                session.completed_orders++;

                // Update order status
                await this.markOrderPicked(order.id, session.id);

                pickingEvents.emit('order:completed', {
                    sessionId: session.id,
                    orderId: order.id,
                    orderNumber: order.order_number
                });
            }
        }
    }

    async markOrderPicked(orderId, sessionId) {
        await db.query(`
            UPDATE orders SET 
                status = 'picked',
                picked_at = NOW(),
                picking_session_id = $1
            WHERE id = $2
        `, [sessionId, orderId]);
    }

    // ----------------------------------------
    // SESSION OPERATIONS
    // ----------------------------------------

    /**
     * Complete picking session
     */
    async completeSession(sessionId) {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        // Check if all items picked
        const allPicked = session.picked_items >= session.total_items;
        const hasShortages = session.errors.some(e => e.type === 'shortage');

        session.status = hasShortages ? 'completed_with_issues' : 'completed';
        session.completed_at = new Date().toISOString();
        session.duration_minutes = Math.round(
            (new Date(session.completed_at) - new Date(session.started_at)) / 60000
        );

        // Calculate efficiency
        session.efficiency = {
            items_per_minute: session.total_items / session.duration_minutes,
            estimated_vs_actual: session.estimated_duration / session.duration_minutes,
            accuracy: ((session.total_items - (session.errors?.length || 0)) / session.total_items) * 100
        };

        await this.saveSession(session);

        // Clear from active cache
        this.activeSessions.delete(sessionId);
        await redis.del(`picking_session:${sessionId}`);

        pickingEvents.emit('session:completed', {
            sessionId,
            duration: session.duration_minutes,
            efficiency: session.efficiency
        });

        return session;
    }

    /**
     * Pause session
     */
    async pauseSession(sessionId, reason) {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.status = 'paused';
        session.paused_at = new Date().toISOString();
        session.pause_reason = reason;

        await this.saveSession(session);

        pickingEvents.emit('session:paused', { sessionId, reason });

        return session;
    }

    /**
     * Resume session
     */
    async resumeSession(sessionId) {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        if (session.status !== 'paused') {
            throw new Error('Session is not paused');
        }

        session.status = 'in_progress';
        session.resumed_at = new Date().toISOString();

        await this.saveSession(session);

        pickingEvents.emit('session:resumed', { sessionId });

        return session;
    }

    /**
     * Cancel session
     */
    async cancelSession(sessionId, reason) {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.status = 'cancelled';
        session.cancelled_at = new Date().toISOString();
        session.cancel_reason = reason;

        // Release orders back to pool
        const orderIds = session.orders.map(o => o.id);
        await db.query(`
            UPDATE orders SET picking_session_id = NULL
            WHERE id = ANY($1) AND status = 'pending_fulfillment'
        `, [orderIds]);

        await this.saveSession(session);

        // Clear from active cache
        this.activeSessions.delete(sessionId);
        await redis.del(`picking_session:${sessionId}`);

        pickingEvents.emit('session:cancelled', { sessionId, reason });

        return session;
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    async getSession(sessionId) {
        // Check memory cache
        if (this.activeSessions.has(sessionId)) {
            return this.activeSessions.get(sessionId);
        }

        // Check Redis cache
        const cached = await redis.get(`picking_session:${sessionId}`);
        if (cached) {
            const session = JSON.parse(cached);
            this.activeSessions.set(sessionId, session);
            return session;
        }

        // Load from database
        const result = await db.query(
            'SELECT * FROM picking_sessions WHERE id = $1',
            [sessionId]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const session = {
            ...row,
            orders: typeof row.orders === 'string' ? JSON.parse(row.orders) : row.orders,
            picking_list: typeof row.picking_list === 'string' ? JSON.parse(row.picking_list) : row.picking_list,
            errors: typeof row.errors === 'string' ? JSON.parse(row.errors || '[]') : (row.errors || [])
        };

        if (session.status === 'in_progress') {
            this.activeSessions.set(sessionId, session);
            await redis.setex(`picking_session:${sessionId}`, 3600 * 8, JSON.stringify(session));
        }

        return session;
    }

    async saveSession(session) {
        await db.query(`
            UPDATE picking_sessions SET
                status = $1,
                orders = $2,
                picking_list = $3,
                picked_items = $4,
                completed_orders = $5,
                errors = $6,
                completed_at = $7,
                duration_minutes = $8,
                efficiency = $9,
                updated_at = NOW()
            WHERE id = $10
        `, [
            session.status,
            JSON.stringify(session.orders),
            JSON.stringify(session.picking_list),
            session.picked_items,
            session.completed_orders,
            JSON.stringify(session.errors || []),
            session.completed_at,
            session.duration_minutes,
            session.efficiency ? JSON.stringify(session.efficiency) : null,
            session.id
        ]);

        // Update cache
        if (session.status === 'in_progress') {
            this.activeSessions.set(session.id, session);
            await redis.setex(`picking_session:${session.id}`, 3600 * 8, JSON.stringify(session));
        }
    }

    async getOrdersByIds(orgId, orderIds) {
        const result = await db.query(`
            SELECT * FROM orders 
            WHERE organization_id = $1 AND id = ANY($2)
        `, [orgId, orderIds]);
        return result.rows;
    }

    async markOrdersInPicking(orderIds, sessionId) {
        await db.query(`
            UPDATE orders SET 
                picking_session_id = $1,
                status = 'picking'
            WHERE id = ANY($2)
        `, [sessionId, orderIds]);
    }

    getNextItem(session) {
        const next = session.picking_list.find(item => 
            item.status === 'pending' || item.status === 'partial'
        );
        
        if (!next) return null;

        return {
            sequence: next.sequence,
            sku: next.sku,
            name: next.name,
            quantity: next.quantity - next.picked_quantity,
            location: next.location,
            barcode: next.barcode,
            image: next.image
        };
    }

    async logPickingError(sessionId, error) {
        await db.query(`
            INSERT INTO picking_errors (session_id, error_type, error_data)
            VALUES ($1, $2, $3)
        `, [sessionId, error.type, JSON.stringify(error)]);

        // Update session errors
        const session = await this.getSession(sessionId);
        if (session) {
            session.errors = session.errors || [];
            session.errors.push(error);
            await this.saveSession(session);
        }
    }

    async logPickingEvent(sessionId, event) {
        await db.query(`
            INSERT INTO picking_events (session_id, event_type, event_data)
            VALUES ($1, $2, $3)
        `, [sessionId, event.type, JSON.stringify(event)]);
    }

    // ----------------------------------------
    // ANALYTICS
    // ----------------------------------------

    async getPickerStats(orgId, pickerId, dateRange) {
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_sessions,
                SUM(total_items) as total_items_picked,
                AVG(duration_minutes) as avg_duration,
                AVG(CAST(efficiency->>'items_per_minute' AS FLOAT)) as avg_items_per_minute,
                AVG(CAST(efficiency->>'accuracy' AS FLOAT)) as avg_accuracy,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_sessions,
                SUM(CASE WHEN status = 'completed_with_issues' THEN 1 ELSE 0 END) as sessions_with_issues
            FROM picking_sessions
            WHERE organization_id = $1 
            AND picker_id = $2
            AND started_at >= $3
            AND started_at <= $4
        `, [orgId, pickerId, dateRange.from, dateRange.to]);

        return result.rows[0];
    }

    async getWarehousePickingStats(orgId, warehouseId, date) {
        const result = await db.query(`
            SELECT 
                COUNT(DISTINCT picker_id) as active_pickers,
                COUNT(*) as total_sessions,
                SUM(total_items) as total_items,
                SUM(picked_items) as picked_items,
                SUM(total_orders) as total_orders,
                SUM(completed_orders) as completed_orders,
                AVG(duration_minutes) as avg_session_duration
            FROM picking_sessions
            WHERE organization_id = $1
            AND warehouse_id = $2
            AND DATE(started_at) = $3
        `, [orgId, warehouseId, date]);

        return result.rows[0];
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    PickingSessionService,
    PICKING_STRATEGIES,
    pickingEvents
};
