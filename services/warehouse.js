/**
 * Routz v4.0 - Inventory & Warehouse Management Service
 * Gestion multi-entrepôts et stocks
 */

class WarehouseService {
    constructor(db) {
        this.db = db;
    }

    // ==========================================
    // WAREHOUSES
    // ==========================================

    /**
     * Create a new warehouse
     */
    async createWarehouse(orgId, data) {
        const warehouse = {
            id: this.generateId(),
            organizationId: orgId,
            name: data.name,
            code: data.code?.toUpperCase() || this.generateCode(data.name),
            type: data.type || 'fulfillment', // fulfillment, dropship, store, return
            status: 'active',
            address: {
                line1: data.address?.line1,
                line2: data.address?.line2,
                city: data.address?.city,
                postalCode: data.address?.postalCode,
                country: data.address?.country || 'FR',
                coordinates: data.address?.coordinates || null
            },
            contact: {
                name: data.contact?.name,
                email: data.contact?.email,
                phone: data.contact?.phone
            },
            settings: {
                priority: data.settings?.priority || 1,
                autoAssign: data.settings?.autoAssign ?? true,
                cutoffTime: data.settings?.cutoffTime || '16:00',
                processingDays: data.settings?.processingDays || ['MO', 'TU', 'WE', 'TH', 'FR'],
                carriers: data.settings?.carriers || [],
                zones: data.settings?.zones || []
            },
            capacity: {
                maxProducts: data.capacity?.maxProducts || null,
                maxOrders: data.capacity?.maxOrders || null,
                currentProducts: 0,
                currentOrders: 0
            },
            metadata: data.metadata || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO warehouses (id, organization_id, name, code, type, status, address, contact, settings, capacity, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [warehouse.id, warehouse.organizationId, warehouse.name, warehouse.code, warehouse.type,
             warehouse.status, warehouse.address, warehouse.contact, warehouse.settings,
             warehouse.capacity, warehouse.metadata, warehouse.createdAt]
        );

        return warehouse;
    }

    /**
     * Get warehouse by ID
     */
    async getWarehouse(warehouseId) {
        const result = await this.db.query(
            `SELECT * FROM warehouses WHERE id = $1`,
            [warehouseId]
        );
        return result.rows[0] || null;
    }

    /**
     * List warehouses for organization
     */
    async listWarehouses(orgId, filters = {}) {
        let query = `SELECT * FROM warehouses WHERE organization_id = $1`;
        const params = [orgId];
        let paramIndex = 2;

        if (filters.status) {
            query += ` AND status = $${paramIndex}`;
            params.push(filters.status);
            paramIndex++;
        }

        if (filters.type) {
            query += ` AND type = $${paramIndex}`;
            params.push(filters.type);
            paramIndex++;
        }

        query += ` ORDER BY (settings->>'priority')::int ASC, name ASC`;

        const result = await this.db.query(query, params);
        return result.rows;
    }

    /**
     * Update warehouse
     */
    async updateWarehouse(warehouseId, updates) {
        const fields = [];
        const values = [];
        let paramIndex = 1;

        const allowedFields = ['name', 'code', 'type', 'status', 'address', 'contact', 'settings', 'capacity', 'metadata'];
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                fields.push(`${key} = $${paramIndex}`);
                values.push(typeof value === 'object' ? JSON.stringify(value) : value);
                paramIndex++;
            }
        }

        if (fields.length === 0) return null;

        fields.push(`updated_at = $${paramIndex}`);
        values.push(new Date().toISOString());
        values.push(warehouseId);

        const result = await this.db.query(
            `UPDATE warehouses SET ${fields.join(', ')} WHERE id = $${paramIndex + 1} RETURNING *`,
            values
        );

        return result.rows[0];
    }

    // ==========================================
    // INVENTORY
    // ==========================================

    /**
     * Add or update inventory item
     */
    async upsertInventory(warehouseId, sku, data) {
        const inventory = {
            warehouseId,
            sku,
            productId: data.productId,
            productName: data.productName,
            quantity: data.quantity || 0,
            reserved: data.reserved || 0,
            available: (data.quantity || 0) - (data.reserved || 0),
            location: data.location || null, // bin/shelf location
            reorderPoint: data.reorderPoint || 0,
            reorderQuantity: data.reorderQuantity || 0,
            costPrice: data.costPrice || null,
            lastReceived: data.lastReceived || null,
            lastSold: data.lastSold || null,
            updatedAt: new Date().toISOString()
        };

        const result = await this.db.query(
            `INSERT INTO inventory (warehouse_id, sku, product_id, product_name, quantity, reserved, available, location, reorder_point, reorder_quantity, cost_price, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (warehouse_id, sku) 
             DO UPDATE SET quantity = $5, reserved = $6, available = $7, location = $8, updated_at = $12
             RETURNING *`,
            [inventory.warehouseId, inventory.sku, inventory.productId, inventory.productName,
             inventory.quantity, inventory.reserved, inventory.available, inventory.location,
             inventory.reorderPoint, inventory.reorderQuantity, inventory.costPrice, inventory.updatedAt]
        );

        return result.rows[0];
    }

    /**
     * Get inventory for a SKU across all warehouses
     */
    async getInventoryBySku(orgId, sku) {
        const result = await this.db.query(
            `SELECT i.*, w.name as warehouse_name, w.code as warehouse_code
             FROM inventory i
             JOIN warehouses w ON i.warehouse_id = w.id
             WHERE w.organization_id = $1 AND i.sku = $2`,
            [orgId, sku]
        );
        return result.rows;
    }

    /**
     * Get inventory for a warehouse
     */
    async getWarehouseInventory(warehouseId, options = {}) {
        let query = `SELECT * FROM inventory WHERE warehouse_id = $1`;
        const params = [warehouseId];
        let paramIndex = 2;

        if (options.search) {
            query += ` AND (sku ILIKE $${paramIndex} OR product_name ILIKE $${paramIndex})`;
            params.push(`%${options.search}%`);
            paramIndex++;
        }

        if (options.lowStock) {
            query += ` AND available <= reorder_point`;
        }

        if (options.outOfStock) {
            query += ` AND available = 0`;
        }

        query += ` ORDER BY ${options.sortBy || 'sku'} ${options.sortOrder || 'ASC'}`;

        if (options.limit) {
            query += ` LIMIT $${paramIndex}`;
            params.push(options.limit);
            paramIndex++;
        }

        if (options.offset) {
            query += ` OFFSET $${paramIndex}`;
            params.push(options.offset);
        }

        const result = await this.db.query(query, params);
        return result.rows;
    }

    /**
     * Reserve inventory for an order
     */
    async reserveInventory(warehouseId, items) {
        const results = [];

        for (const item of items) {
            // Check availability
            const current = await this.db.query(
                `SELECT available FROM inventory WHERE warehouse_id = $1 AND sku = $2`,
                [warehouseId, item.sku]
            );

            if (!current.rows[0] || current.rows[0].available < item.quantity) {
                results.push({
                    sku: item.sku,
                    success: false,
                    error: 'insufficient_stock',
                    available: current.rows[0]?.available || 0
                });
                continue;
            }

            // Reserve
            const result = await this.db.query(
                `UPDATE inventory 
                 SET reserved = reserved + $3, available = available - $3, updated_at = NOW()
                 WHERE warehouse_id = $1 AND sku = $2
                 RETURNING *`,
                [warehouseId, item.sku, item.quantity]
            );

            results.push({
                sku: item.sku,
                success: true,
                inventory: result.rows[0]
            });
        }

        return results;
    }

    /**
     * Release reserved inventory
     */
    async releaseInventory(warehouseId, items) {
        for (const item of items) {
            await this.db.query(
                `UPDATE inventory 
                 SET reserved = GREATEST(0, reserved - $3), available = available + $3, updated_at = NOW()
                 WHERE warehouse_id = $1 AND sku = $2`,
                [warehouseId, item.sku, item.quantity]
            );
        }
    }

    /**
     * Deduct inventory (after shipment)
     */
    async deductInventory(warehouseId, items) {
        for (const item of items) {
            await this.db.query(
                `UPDATE inventory 
                 SET quantity = quantity - $3, reserved = GREATEST(0, reserved - $3), last_sold = NOW(), updated_at = NOW()
                 WHERE warehouse_id = $1 AND sku = $2`,
                [warehouseId, item.sku, item.quantity]
            );
        }
    }

    // ==========================================
    // WAREHOUSE SELECTION
    // ==========================================

    /**
     * Find optimal warehouse for an order
     */
    async findOptimalWarehouse(orgId, order) {
        const warehouses = await this.listWarehouses(orgId, { status: 'active' });
        const scores = [];

        for (const warehouse of warehouses) {
            let score = 100;

            // Check inventory availability
            const inventoryCheck = await this.checkWarehouseAvailability(warehouse.id, order.items);
            if (!inventoryCheck.allAvailable) {
                continue; // Skip warehouses that can't fulfill
            }

            // Priority bonus
            score += (10 - warehouse.settings.priority) * 10;

            // Distance scoring (if coordinates available)
            if (warehouse.address.coordinates && order.shippingAddress?.coordinates) {
                const distance = this.calculateDistance(
                    warehouse.address.coordinates,
                    order.shippingAddress.coordinates
                );
                score -= distance / 100; // Reduce score based on distance
            }

            // Capacity scoring
            if (warehouse.capacity.maxOrders) {
                const utilization = warehouse.capacity.currentOrders / warehouse.capacity.maxOrders;
                if (utilization > 0.9) score -= 20; // Near capacity
            }

            // Carrier availability
            if (order.preferredCarrier && warehouse.settings.carriers.length > 0) {
                if (!warehouse.settings.carriers.includes(order.preferredCarrier)) {
                    score -= 15;
                }
            }

            scores.push({
                warehouse,
                score,
                inventory: inventoryCheck
            });
        }

        // Sort by score
        scores.sort((a, b) => b.score - a.score);

        return scores[0] || null;
    }

    /**
     * Check if warehouse can fulfill order
     */
    async checkWarehouseAvailability(warehouseId, items) {
        const results = [];
        let allAvailable = true;

        for (const item of items) {
            const inventory = await this.db.query(
                `SELECT available FROM inventory WHERE warehouse_id = $1 AND sku = $2`,
                [warehouseId, item.sku]
            );

            const available = inventory.rows[0]?.available || 0;
            const canFulfill = available >= item.quantity;

            if (!canFulfill) allAvailable = false;

            results.push({
                sku: item.sku,
                requested: item.quantity,
                available,
                canFulfill
            });
        }

        return { allAvailable, items: results };
    }

    // ==========================================
    // STOCK MOVEMENTS
    // ==========================================

    /**
     * Record stock movement
     */
    async recordMovement(data) {
        const movement = {
            id: this.generateId(),
            warehouseId: data.warehouseId,
            sku: data.sku,
            type: data.type, // receive, ship, adjust, transfer, return
            quantity: data.quantity,
            reference: data.reference, // order_id, purchase_order_id, etc.
            reason: data.reason,
            previousQuantity: data.previousQuantity,
            newQuantity: data.newQuantity,
            userId: data.userId,
            notes: data.notes,
            createdAt: new Date().toISOString()
        };

        await this.db.query(
            `INSERT INTO stock_movements (id, warehouse_id, sku, type, quantity, reference, reason, previous_quantity, new_quantity, user_id, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [movement.id, movement.warehouseId, movement.sku, movement.type, movement.quantity,
             movement.reference, movement.reason, movement.previousQuantity, movement.newQuantity,
             movement.userId, movement.notes, movement.createdAt]
        );

        return movement;
    }

    /**
     * Get movement history
     */
    async getMovementHistory(warehouseId, sku, options = {}) {
        let query = `SELECT * FROM stock_movements WHERE warehouse_id = $1`;
        const params = [warehouseId];
        let paramIndex = 2;

        if (sku) {
            query += ` AND sku = $${paramIndex}`;
            params.push(sku);
            paramIndex++;
        }

        if (options.type) {
            query += ` AND type = $${paramIndex}`;
            params.push(options.type);
            paramIndex++;
        }

        if (options.startDate) {
            query += ` AND created_at >= $${paramIndex}`;
            params.push(options.startDate);
            paramIndex++;
        }

        if (options.endDate) {
            query += ` AND created_at <= $${paramIndex}`;
            params.push(options.endDate);
            paramIndex++;
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
        params.push(options.limit || 100);

        const result = await this.db.query(query, params);
        return result.rows;
    }

    // ==========================================
    // ANALYTICS
    // ==========================================

    /**
     * Get inventory analytics
     */
    async getInventoryAnalytics(orgId) {
        const warehouses = await this.listWarehouses(orgId);
        const analytics = {
            totalWarehouses: warehouses.length,
            totalProducts: 0,
            totalValue: 0,
            lowStockItems: 0,
            outOfStockItems: 0,
            byWarehouse: []
        };

        for (const warehouse of warehouses) {
            const stats = await this.db.query(
                `SELECT 
                    COUNT(*) as total_items,
                    SUM(quantity) as total_quantity,
                    SUM(quantity * COALESCE(cost_price, 0)) as total_value,
                    SUM(CASE WHEN available <= reorder_point AND available > 0 THEN 1 ELSE 0 END) as low_stock,
                    SUM(CASE WHEN available = 0 THEN 1 ELSE 0 END) as out_of_stock
                 FROM inventory WHERE warehouse_id = $1`,
                [warehouse.id]
            );

            const warehouseStats = stats.rows[0];
            analytics.totalProducts += parseInt(warehouseStats.total_items) || 0;
            analytics.totalValue += parseFloat(warehouseStats.total_value) || 0;
            analytics.lowStockItems += parseInt(warehouseStats.low_stock) || 0;
            analytics.outOfStockItems += parseInt(warehouseStats.out_of_stock) || 0;

            analytics.byWarehouse.push({
                id: warehouse.id,
                name: warehouse.name,
                code: warehouse.code,
                items: parseInt(warehouseStats.total_items) || 0,
                value: parseFloat(warehouseStats.total_value) || 0,
                lowStock: parseInt(warehouseStats.low_stock) || 0,
                outOfStock: parseInt(warehouseStats.out_of_stock) || 0
            });
        }

        return analytics;
    }

    // ==========================================
    // HELPERS
    // ==========================================

    generateId() {
        return 'wh_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    generateCode(name) {
        return name.substring(0, 3).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();
    }

    calculateDistance(coord1, coord2) {
        // Haversine formula for distance in km
        const R = 6371;
        const dLat = this.toRad(coord2.lat - coord1.lat);
        const dLon = this.toRad(coord2.lon - coord1.lon);
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(this.toRad(coord1.lat)) * Math.cos(this.toRad(coord2.lat)) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    toRad(deg) {
        return deg * (Math.PI/180);
    }
}

module.exports = { WarehouseService };
