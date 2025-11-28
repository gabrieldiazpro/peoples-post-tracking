/**
 * ROUTZ - Intelligent Order Routing Service (OMS)
 * Moteur de règles pour dispatch automatique multi-entrepôts
 * Optimisation basée sur: stock, délai, coût, géographie
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// ============================================
// ROUTING STRATEGIES
// ============================================

const ROUTING_STRATEGIES = {
    // Closest warehouse with full stock
    CLOSEST_FULL_STOCK: {
        id: 'closest_full_stock',
        name: 'Entrepôt le plus proche (stock complet)',
        description: 'Sélectionne l\'entrepôt le plus proche qui a tous les articles en stock',
        priority: ['stock_availability', 'distance', 'capacity']
    },
    
    // Lowest shipping cost
    LOWEST_COST: {
        id: 'lowest_cost',
        name: 'Coût d\'expédition minimum',
        description: 'Minimise les frais de port même si ce n\'est pas le plus rapide',
        priority: ['shipping_cost', 'stock_availability', 'distance']
    },
    
    // Fastest delivery
    FASTEST_DELIVERY: {
        id: 'fastest_delivery',
        name: 'Livraison la plus rapide',
        description: 'Priorise le délai de livraison le plus court',
        priority: ['delivery_time', 'stock_availability', 'carrier_availability']
    },
    
    // Split shipment allowed
    SPLIT_ALLOWED: {
        id: 'split_allowed',
        name: 'Envois multiples autorisés',
        description: 'Permet de splitter la commande entre plusieurs entrepôts',
        priority: ['stock_availability', 'total_delivery_time', 'total_cost'],
        allowSplit: true
    },
    
    // Priority by warehouse
    WAREHOUSE_PRIORITY: {
        id: 'warehouse_priority',
        name: 'Priorité par entrepôt',
        description: 'Utilise les entrepôts selon leur priorité définie',
        priority: ['warehouse_priority', 'stock_availability', 'distance']
    },
    
    // Round robin (load balancing)
    ROUND_ROBIN: {
        id: 'round_robin',
        name: 'Répartition équilibrée',
        description: 'Distribue équitablement entre les entrepôts',
        priority: ['capacity_balance', 'stock_availability']
    },
    
    // Geographic zone
    GEOGRAPHIC: {
        id: 'geographic',
        name: 'Zone géographique',
        description: 'Route vers l\'entrepôt assigné à la zone de livraison',
        priority: ['zone_assignment', 'stock_availability', 'distance']
    }
};

// ============================================
// INTELLIGENT ROUTING SERVICE
// ============================================

class IntelligentRoutingService {
    constructor() {
        this.distanceCache = new Map();
    }

    // ----------------------------------------
    // MAIN ROUTING METHOD
    // ----------------------------------------

    /**
     * Route an order to optimal warehouse(s)
     */
    async routeOrder(params) {
        const {
            orgId,
            orderId,
            orderItems, // [{ sku, quantity }]
            deliveryAddress, // { country, postalCode, city, latitude, longitude }
            carrier,
            deliveryType, // 'standard', 'express', 'pickup'
            strategy,
            constraints = {}
        } = params;

        // Get organization routing config
        const config = await this.getRoutingConfig(orgId);
        const routingStrategy = strategy || config.default_strategy || 'CLOSEST_FULL_STOCK';
        const strategyConfig = ROUTING_STRATEGIES[routingStrategy];

        // Get all warehouses
        const warehouses = await this.getActiveWarehouses(orgId);
        
        if (warehouses.length === 0) {
            throw new Error('No active warehouses available');
        }

        // Get inventory for all items across all warehouses
        const inventory = await this.getInventoryMatrix(orgId, orderItems.map(i => i.sku));

        // Calculate scores for each warehouse
        const warehouseScores = await Promise.all(
            warehouses.map(async warehouse => {
                const score = await this.calculateWarehouseScore({
                    warehouse,
                    orderItems,
                    inventory,
                    deliveryAddress,
                    carrier,
                    deliveryType,
                    strategy: strategyConfig,
                    config,
                    constraints
                });
                return { warehouse, score };
            })
        );

        // Sort by score (highest first)
        warehouseScores.sort((a, b) => b.score.total - a.score.total);

        // Select warehouse(s)
        let routingResult;
        
        if (strategyConfig.allowSplit && !this.canFulfillFromSingle(warehouseScores, orderItems, inventory)) {
            // Try split fulfillment
            routingResult = await this.calculateSplitFulfillment({
                warehouseScores,
                orderItems,
                inventory,
                deliveryAddress,
                config
            });
        } else {
            // Single warehouse fulfillment
            const selected = warehouseScores.find(ws => 
                this.hasFullStock(ws.warehouse.id, orderItems, inventory)
            );
            
            if (!selected) {
                // No single warehouse has full stock
                if (config.allow_backorder) {
                    routingResult = this.handleBackorder(warehouseScores[0], orderItems, inventory);
                } else {
                    throw new Error('No warehouse has sufficient stock');
                }
            } else {
                routingResult = {
                    type: 'single',
                    shipments: [{
                        warehouseId: selected.warehouse.id,
                        warehouseName: selected.warehouse.name,
                        items: orderItems,
                        score: selected.score,
                        estimatedShipping: selected.score.details.shipping_cost,
                        estimatedDelivery: selected.score.details.delivery_days
                    }]
                };
            }
        }

        // Save routing decision
        await this.saveRoutingDecision(orgId, orderId, routingResult, {
            strategy: routingStrategy,
            warehouseScores: warehouseScores.map(ws => ({
                warehouseId: ws.warehouse.id,
                score: ws.score.total,
                details: ws.score.details
            }))
        });

        return routingResult;
    }

    /**
     * Route multiple orders in batch
     */
    async routeOrders(params) {
        const { orgId, orders, strategy } = params;

        const results = await Promise.allSettled(
            orders.map(order => this.routeOrder({
                orgId,
                orderId: order.id,
                orderItems: order.items,
                deliveryAddress: order.delivery_address,
                carrier: order.carrier,
                deliveryType: order.delivery_type,
                strategy
            }))
        );

        return {
            total: orders.length,
            routed: results.filter(r => r.status === 'fulfilled').length,
            failed: results.filter(r => r.status === 'rejected').length,
            results: results.map((r, i) => ({
                orderId: orders[i].id,
                status: r.status,
                routing: r.value,
                error: r.reason?.message
            }))
        };
    }

    // ----------------------------------------
    // SCORE CALCULATION
    // ----------------------------------------

    async calculateWarehouseScore(params) {
        const {
            warehouse,
            orderItems,
            inventory,
            deliveryAddress,
            carrier,
            deliveryType,
            strategy,
            config,
            constraints
        } = params;

        const scores = {
            stock_availability: 0,
            distance: 0,
            shipping_cost: 0,
            delivery_time: 0,
            capacity: 0,
            warehouse_priority: 0,
            zone_assignment: 0,
            capacity_balance: 0
        };

        const details = {};

        // 1. Stock Availability Score (0-100)
        const stockScore = this.calculateStockScore(warehouse.id, orderItems, inventory);
        scores.stock_availability = stockScore.score;
        details.stock_coverage = stockScore.coverage;
        details.missing_items = stockScore.missingItems;

        // 2. Distance Score (0-100)
        const distance = await this.calculateDistance(warehouse, deliveryAddress);
        scores.distance = Math.max(0, 100 - (distance / 10)); // Penalize 1 point per 10km
        details.distance_km = distance;

        // 3. Shipping Cost Score (0-100)
        const shippingCost = await this.estimateShippingCost({
            warehouse,
            deliveryAddress,
            items: orderItems,
            carrier,
            deliveryType
        });
        const maxCost = config.max_acceptable_shipping_cost || 50;
        scores.shipping_cost = Math.max(0, 100 - (shippingCost / maxCost * 100));
        details.shipping_cost = shippingCost;

        // 4. Delivery Time Score (0-100)
        const deliveryDays = this.estimateDeliveryDays({
            warehouse,
            deliveryAddress,
            carrier,
            deliveryType
        });
        const maxDays = deliveryType === 'express' ? 2 : 7;
        scores.delivery_time = Math.max(0, 100 - (deliveryDays / maxDays * 100));
        details.delivery_days = deliveryDays;

        // 5. Capacity Score (0-100)
        const capacityScore = await this.getWarehouseCapacityScore(warehouse.id);
        scores.capacity = capacityScore;
        details.current_load = 100 - capacityScore;

        // 6. Warehouse Priority Score (0-100)
        scores.warehouse_priority = warehouse.priority || 50;

        // 7. Zone Assignment Score (0-100)
        const zoneMatch = await this.checkZoneAssignment(warehouse.id, deliveryAddress);
        scores.zone_assignment = zoneMatch ? 100 : 0;
        details.zone_match = zoneMatch;

        // 8. Capacity Balance Score (for round robin)
        scores.capacity_balance = await this.getCapacityBalanceScore(warehouse.id);

        // Calculate weighted total based on strategy
        const weights = this.getStrategyWeights(strategy.priority);
        let totalScore = 0;
        let totalWeight = 0;

        for (const [factor, weight] of Object.entries(weights)) {
            totalScore += scores[factor] * weight;
            totalWeight += weight;
        }

        // Apply constraints
        if (constraints.exclude_warehouses?.includes(warehouse.id)) {
            totalScore = 0;
        }
        if (constraints.prefer_warehouses?.includes(warehouse.id)) {
            totalScore *= 1.2;
        }
        if (constraints.max_distance && distance > constraints.max_distance) {
            totalScore = 0;
        }

        return {
            total: totalWeight > 0 ? totalScore / totalWeight : 0,
            scores,
            details
        };
    }

    calculateStockScore(warehouseId, orderItems, inventory) {
        let totalRequired = 0;
        let totalAvailable = 0;
        const missingItems = [];

        for (const item of orderItems) {
            const available = inventory[item.sku]?.[warehouseId] || 0;
            const required = item.quantity;
            
            totalRequired += required;
            totalAvailable += Math.min(available, required);

            if (available < required) {
                missingItems.push({
                    sku: item.sku,
                    required,
                    available,
                    shortage: required - available
                });
            }
        }

        const coverage = totalRequired > 0 ? totalAvailable / totalRequired : 0;
        
        // Full stock = 100, partial = proportional, none = 0
        return {
            score: coverage * 100,
            coverage,
            missingItems
        };
    }

    async calculateDistance(warehouse, deliveryAddress) {
        // Check cache
        const cacheKey = `dist:${warehouse.id}:${deliveryAddress.postalCode}`;
        if (this.distanceCache.has(cacheKey)) {
            return this.distanceCache.get(cacheKey);
        }

        let distance;

        // If coordinates available, use Haversine
        if (warehouse.latitude && warehouse.longitude && 
            deliveryAddress.latitude && deliveryAddress.longitude) {
            distance = this.haversineDistance(
                warehouse.latitude, warehouse.longitude,
                deliveryAddress.latitude, deliveryAddress.longitude
            );
        } else {
            // Estimate from postal codes (France specific)
            distance = this.estimateDistanceFromPostalCodes(
                warehouse.postal_code,
                deliveryAddress.postalCode,
                warehouse.country,
                deliveryAddress.country
            );
        }

        this.distanceCache.set(cacheKey, distance);
        return distance;
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in km
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    toRad(deg) {
        return deg * Math.PI / 180;
    }

    estimateDistanceFromPostalCodes(from, to, fromCountry, toCountry) {
        // Simplified estimation based on postal code regions
        if (fromCountry !== toCountry) {
            return 1000; // International
        }

        const fromRegion = from?.substring(0, 2);
        const toRegion = to?.substring(0, 2);

        if (fromRegion === toRegion) {
            return 50; // Same department
        }

        // France department distances (simplified)
        const regions = {
            '75': { lat: 48.86, lon: 2.35 },  // Paris
            '69': { lat: 45.76, lon: 4.84 },  // Lyon
            '13': { lat: 43.30, lon: 5.37 },  // Marseille
            '33': { lat: 44.84, lon: -0.58 }, // Bordeaux
            '31': { lat: 43.60, lon: 1.44 },  // Toulouse
            '59': { lat: 50.63, lon: 3.06 },  // Lille
            '67': { lat: 48.57, lon: 7.75 },  // Strasbourg
            '44': { lat: 47.22, lon: -1.55 }, // Nantes
        };

        const fromCoord = regions[fromRegion] || { lat: 47, lon: 2 };
        const toCoord = regions[toRegion] || { lat: 47, lon: 2 };

        return this.haversineDistance(fromCoord.lat, fromCoord.lon, toCoord.lat, toCoord.lon);
    }

    async estimateShippingCost({ warehouse, deliveryAddress, items, carrier, deliveryType }) {
        // This would integrate with actual carrier rate APIs
        // For now, use distance-based estimation
        
        const distance = await this.calculateDistance(warehouse, deliveryAddress);
        const totalWeight = items.reduce((sum, item) => sum + (item.weight || 0.5) * item.quantity, 0);
        
        // Base cost
        let cost = 4.99;
        
        // Weight surcharge
        if (totalWeight > 2) {
            cost += (totalWeight - 2) * 0.5;
        }
        
        // Distance surcharge
        if (distance > 300) {
            cost += (distance - 300) * 0.01;
        }
        
        // Express surcharge
        if (deliveryType === 'express') {
            cost *= 1.8;
        }
        
        return Math.round(cost * 100) / 100;
    }

    estimateDeliveryDays({ warehouse, deliveryAddress, carrier, deliveryType }) {
        // Base delivery days
        let days = deliveryType === 'express' ? 1 : 3;
        
        // Add for different country
        if (warehouse.country !== deliveryAddress.country) {
            days += 3;
        }
        
        // Add for distance
        const distance = this.estimateDistanceFromPostalCodes(
            warehouse.postal_code,
            deliveryAddress.postalCode,
            warehouse.country,
            deliveryAddress.country
        );
        
        if (distance > 500) {
            days += 1;
        }
        
        return days;
    }

    async getWarehouseCapacityScore(warehouseId) {
        const result = await db.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'pending_fulfillment') as pending,
                (SELECT daily_capacity FROM warehouses WHERE id = $1) as capacity
            FROM orders
            WHERE warehouse_id = $1
            AND DATE(created_at) = CURRENT_DATE
        `, [warehouseId]);

        const { pending, capacity } = result.rows[0];
        const maxCapacity = capacity || 100;
        const load = (pending / maxCapacity) * 100;

        return Math.max(0, 100 - load);
    }

    async getCapacityBalanceScore(warehouseId) {
        // Get relative load compared to other warehouses
        const result = await db.query(`
            SELECT 
                w.id,
                COUNT(o.id) FILTER (WHERE DATE(o.created_at) = CURRENT_DATE) as today_orders
            FROM warehouses w
            LEFT JOIN orders o ON o.warehouse_id = w.id
            WHERE w.active = true
            GROUP BY w.id
        `);

        const loads = result.rows.map(r => ({ id: r.id, orders: parseInt(r.today_orders) }));
        const avgLoad = loads.reduce((s, l) => s + l.orders, 0) / loads.length;
        const thisLoad = loads.find(l => l.id === warehouseId)?.orders || 0;

        // Score higher if below average
        if (avgLoad === 0) return 100;
        return Math.max(0, 100 - ((thisLoad / avgLoad) * 50));
    }

    async checkZoneAssignment(warehouseId, deliveryAddress) {
        const result = await db.query(`
            SELECT 1 FROM warehouse_zones
            WHERE warehouse_id = $1
            AND (
                country = $2
                OR postal_prefix = $3
                OR (latitude_min <= $4 AND latitude_max >= $4 AND longitude_min <= $5 AND longitude_max >= $5)
            )
            LIMIT 1
        `, [
            warehouseId,
            deliveryAddress.country,
            deliveryAddress.postalCode?.substring(0, 2),
            deliveryAddress.latitude,
            deliveryAddress.longitude
        ]);

        return result.rows.length > 0;
    }

    getStrategyWeights(priority) {
        const weights = {};
        priority.forEach((factor, index) => {
            weights[factor] = (priority.length - index) * 10;
        });
        return weights;
    }

    // ----------------------------------------
    // FULFILLMENT HELPERS
    // ----------------------------------------

    canFulfillFromSingle(warehouseScores, orderItems, inventory) {
        return warehouseScores.some(ws => 
            this.hasFullStock(ws.warehouse.id, orderItems, inventory)
        );
    }

    hasFullStock(warehouseId, orderItems, inventory) {
        return orderItems.every(item => {
            const available = inventory[item.sku]?.[warehouseId] || 0;
            return available >= item.quantity;
        });
    }

    async calculateSplitFulfillment({ warehouseScores, orderItems, inventory, deliveryAddress, config }) {
        const shipments = [];
        const remainingItems = orderItems.map(item => ({ ...item }));
        
        // Greedy allocation
        for (const ws of warehouseScores) {
            if (remainingItems.every(item => item.quantity === 0)) break;

            const shipmentItems = [];

            for (const item of remainingItems) {
                if (item.quantity === 0) continue;

                const available = inventory[item.sku]?.[ws.warehouse.id] || 0;
                const toAllocate = Math.min(available, item.quantity);

                if (toAllocate > 0) {
                    shipmentItems.push({
                        sku: item.sku,
                        quantity: toAllocate
                    });
                    item.quantity -= toAllocate;
                }
            }

            if (shipmentItems.length > 0) {
                const shippingCost = await this.estimateShippingCost({
                    warehouse: ws.warehouse,
                    deliveryAddress,
                    items: shipmentItems,
                    carrier: null,
                    deliveryType: 'standard'
                });

                shipments.push({
                    warehouseId: ws.warehouse.id,
                    warehouseName: ws.warehouse.name,
                    items: shipmentItems,
                    score: ws.score,
                    estimatedShipping: shippingCost,
                    estimatedDelivery: ws.score.details.delivery_days
                });
            }
        }

        // Check if all items allocated
        const unallocated = remainingItems.filter(item => item.quantity > 0);
        
        return {
            type: 'split',
            shipments,
            unallocated: unallocated.length > 0 ? unallocated : null,
            totalShipments: shipments.length,
            totalShippingCost: shipments.reduce((s, sh) => s + sh.estimatedShipping, 0)
        };
    }

    handleBackorder(bestWarehouse, orderItems, inventory) {
        const stockScore = this.calculateStockScore(bestWarehouse.warehouse.id, orderItems, inventory);
        
        return {
            type: 'backorder',
            shipments: [{
                warehouseId: bestWarehouse.warehouse.id,
                warehouseName: bestWarehouse.warehouse.name,
                items: orderItems,
                score: bestWarehouse.score,
                backordered: stockScore.missingItems
            }],
            warning: 'Some items are backordered'
        };
    }

    // ----------------------------------------
    // DATA ACCESS
    // ----------------------------------------

    async getRoutingConfig(orgId) {
        const cached = await redis.get(`routing_config:${orgId}`);
        if (cached) return JSON.parse(cached);

        const result = await db.query(
            'SELECT routing_config FROM organization_settings WHERE organization_id = $1',
            [orgId]
        );

        const config = result.rows[0]?.routing_config || this.getDefaultConfig();
        await redis.setex(`routing_config:${orgId}`, 3600, JSON.stringify(config));

        return config;
    }

    getDefaultConfig() {
        return {
            default_strategy: 'CLOSEST_FULL_STOCK',
            allow_split: false,
            allow_backorder: false,
            max_acceptable_shipping_cost: 30,
            max_split_shipments: 3
        };
    }

    async getActiveWarehouses(orgId) {
        const result = await db.query(`
            SELECT w.*, 
                   COALESCE(ws.daily_capacity, 100) as daily_capacity,
                   COALESCE(ws.priority, 50) as priority
            FROM warehouses w
            LEFT JOIN warehouse_settings ws ON w.id = ws.warehouse_id
            WHERE w.organization_id = $1 
            AND w.active = true
            ORDER BY ws.priority DESC NULLS LAST
        `, [orgId]);

        return result.rows;
    }

    async getInventoryMatrix(orgId, skus) {
        const result = await db.query(`
            SELECT sku, warehouse_id, SUM(available_quantity) as quantity
            FROM inventory
            WHERE organization_id = $1 
            AND sku = ANY($2)
            GROUP BY sku, warehouse_id
        `, [orgId, skus]);

        // Build matrix: { sku: { warehouseId: quantity } }
        const matrix = {};
        for (const row of result.rows) {
            if (!matrix[row.sku]) matrix[row.sku] = {};
            matrix[row.sku][row.warehouse_id] = parseInt(row.quantity);
        }

        return matrix;
    }

    async saveRoutingDecision(orgId, orderId, result, metadata) {
        await db.query(`
            INSERT INTO routing_decisions (
                organization_id, order_id, routing_type, 
                selected_warehouses, metadata, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
            orgId,
            orderId,
            result.type,
            JSON.stringify(result.shipments),
            JSON.stringify(metadata)
        ]);

        // Update order with routing
        if (result.shipments.length === 1) {
            await db.query(`
                UPDATE orders SET 
                    warehouse_id = $1,
                    routing_decision = $2,
                    routed_at = NOW()
                WHERE id = $3
            `, [result.shipments[0].warehouseId, JSON.stringify(result), orderId]);
        } else {
            // Split shipment - create separate fulfillment records
            for (const shipment of result.shipments) {
                await db.query(`
                    INSERT INTO order_fulfillments (
                        order_id, warehouse_id, items, status
                    ) VALUES ($1, $2, $3, 'pending')
                `, [orderId, shipment.warehouseId, JSON.stringify(shipment.items)]);
            }

            await db.query(`
                UPDATE orders SET 
                    is_split = true,
                    routing_decision = $1,
                    routed_at = NOW()
                WHERE id = $2
            `, [JSON.stringify(result), orderId]);
        }
    }

    // ----------------------------------------
    // ROUTING RULES ENGINE
    // ----------------------------------------

    async evaluateRoutingRules(orgId, order) {
        // Get custom rules
        const rules = await this.getRoutingRules(orgId);
        
        for (const rule of rules) {
            if (this.matchesRule(order, rule)) {
                return {
                    matched: true,
                    rule: rule.name,
                    warehouse: rule.target_warehouse,
                    strategy: rule.strategy
                };
            }
        }

        return { matched: false };
    }

    async getRoutingRules(orgId) {
        const result = await db.query(`
            SELECT * FROM routing_rules
            WHERE organization_id = $1 
            AND active = true
            ORDER BY priority DESC
        `, [orgId]);

        return result.rows;
    }

    matchesRule(order, rule) {
        const conditions = rule.conditions;
        
        for (const [field, condition] of Object.entries(conditions)) {
            const value = this.getOrderField(order, field);
            
            if (!this.evaluateCondition(value, condition)) {
                return false;
            }
        }

        return true;
    }

    getOrderField(order, field) {
        const fieldMap = {
            'carrier': order.carrier,
            'country': order.delivery_address?.country,
            'postal_code': order.delivery_address?.postalCode,
            'total_value': order.total,
            'item_count': order.items?.length,
            'priority': order.priority,
            'customer_type': order.customer?.type,
            'delivery_type': order.delivery_type
        };

        return fieldMap[field];
    }

    evaluateCondition(value, condition) {
        const { operator, target } = condition;

        switch (operator) {
            case 'equals': return value === target;
            case 'not_equals': return value !== target;
            case 'in': return target.includes(value);
            case 'not_in': return !target.includes(value);
            case 'starts_with': return String(value).startsWith(target);
            case 'greater_than': return value > target;
            case 'less_than': return value < target;
            case 'between': return value >= target[0] && value <= target[1];
            default: return false;
        }
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    IntelligentRoutingService,
    ROUTING_STRATEGIES
};
