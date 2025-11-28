/**
 * Routz v4.0 - AI Carrier Selection Service
 * Recommandation intelligente basée sur ML, historique, et règles métier
 */

class CarrierSelectionAI {
    constructor(config = {}) {
        this.db = config.db;
        this.qosService = config.qosService;
        this.pricingService = config.pricingService;
        
        // Poids des facteurs de décision
        this.weights = config.weights || {
            price: 0.30,
            speed: 0.25,
            reliability: 0.25,
            customerPreference: 0.10,
            zonePerformance: 0.10
        };

        // Cache des performances
        this.performanceCache = new Map();
        this.cacheExpiry = 3600000; // 1 heure
    }

    // ==========================================
    // MAIN RECOMMENDATION ENGINE
    // ==========================================

    /**
     * Recommander le meilleur transporteur pour une expédition
     */
    async recommendCarrier(shipmentData, options = {}) {
        const {
            orgId,
            origin,
            destination,
            weight,
            dimensions,
            value,
            deliveryType,
            customerPreferences,
            excludeCarriers = [],
            prioritize = null // 'price', 'speed', 'reliability'
        } = shipmentData;

        // 1. Obtenir les transporteurs disponibles
        const availableCarriers = await this.getAvailableCarriers(orgId, origin, destination, excludeCarriers);

        if (availableCarriers.length === 0) {
            return { success: false, error: 'No carriers available for this route' };
        }

        // 2. Calculer les scores pour chaque transporteur
        const scoredCarriers = await Promise.all(
            availableCarriers.map(carrier => this.scoreCarrier(carrier, shipmentData, options))
        );

        // 3. Ajuster les poids si priorité spécifiée
        const adjustedWeights = this.adjustWeights(prioritize);

        // 4. Calculer le score final
        const rankedCarriers = scoredCarriers
            .map(scored => ({
                ...scored,
                finalScore: this.calculateFinalScore(scored.scores, adjustedWeights)
            }))
            .sort((a, b) => b.finalScore - a.finalScore);

        // 5. Construire la recommandation
        const recommendation = this.buildRecommendation(rankedCarriers, shipmentData);

        // 6. Logger pour apprentissage futur
        await this.logRecommendation(orgId, shipmentData, recommendation);

        return recommendation;
    }

    /**
     * Recommandation batch pour plusieurs expéditions
     */
    async recommendCarriersBatch(shipments, options = {}) {
        const results = await Promise.all(
            shipments.map(shipment => this.recommendCarrier(shipment, options))
        );

        // Optimisation globale si demandée
        if (options.optimizeGlobally) {
            return this.optimizeGlobalSelection(results, options);
        }

        return results;
    }

    // ==========================================
    // SCORING ENGINE
    // ==========================================

    async scoreCarrier(carrier, shipmentData, options) {
        const { origin, destination, weight, deliveryType, value } = shipmentData;

        // Récupérer les données de performance
        const performance = await this.getCarrierPerformance(carrier.id, destination);
        
        // Calculer le prix estimé
        const pricing = await this.getCarrierPricing(carrier.id, shipmentData);

        // Scores individuels
        const scores = {
            price: this.scorePricing(pricing, options.budgetMax),
            speed: this.scoreSpeed(carrier, deliveryType, performance),
            reliability: this.scoreReliability(performance),
            customerPreference: this.scoreCustomerPreference(carrier, shipmentData.customerPreferences),
            zonePerformance: this.scoreZonePerformance(performance, destination)
        };

        return {
            carrier: {
                id: carrier.id,
                name: carrier.name,
                service: carrier.service,
                logo: carrier.logo
            },
            pricing,
            performance,
            scores,
            details: this.generateScoreDetails(scores, pricing, performance)
        };
    }

    scorePricing(pricing, budgetMax) {
        if (!pricing || pricing.error) return 0;

        const price = pricing.totalPrice;

        // Score basé sur le prix (inversé - moins cher = meilleur score)
        if (budgetMax && price > budgetMax) {
            return 0; // Hors budget
        }

        // Normaliser sur une échelle 0-100
        // Prix de référence : 5€ = 100, 50€ = 0
        const score = Math.max(0, Math.min(100, 100 - (price - 5) * 2));
        return score;
    }

    scoreSpeed(carrier, deliveryType, performance) {
        const avgDays = performance?.avgDeliveryDays || carrier.estimatedDays || 3;
        
        // Score basé sur la vitesse
        const speedTargets = {
            express: { target: 1, max: 2 },
            standard: { target: 3, max: 5 },
            economy: { target: 5, max: 7 }
        };

        const target = speedTargets[deliveryType] || speedTargets.standard;

        if (avgDays <= target.target) return 100;
        if (avgDays >= target.max) return 20;

        // Interpolation linéaire
        return 100 - ((avgDays - target.target) / (target.max - target.target)) * 80;
    }

    scoreReliability(performance) {
        if (!performance) return 50; // Score neutre si pas de données

        const { deliveryRate, onTimeRate, exceptionRate } = performance;

        // Pondération des métriques de fiabilité
        const score = (
            (deliveryRate || 90) * 0.4 +
            (onTimeRate || 85) * 0.4 +
            (100 - (exceptionRate || 5) * 10) * 0.2
        );

        return Math.max(0, Math.min(100, score));
    }

    scoreCustomerPreference(carrier, preferences) {
        if (!preferences) return 50;

        let score = 50;

        // Préférence de point relais
        if (preferences.relayPoint && carrier.supportsRelayPoints) {
            score += 20;
        }

        // Préférence de créneau horaire
        if (preferences.timeSlot && carrier.supportsTimeSlots) {
            score += 15;
        }

        // Transporteur préféré du client
        if (preferences.preferredCarrier === carrier.id) {
            score += 30;
        }

        // Transporteur blacklisté
        if (preferences.blacklistedCarriers?.includes(carrier.id)) {
            score = 0;
        }

        return Math.min(100, score);
    }

    scoreZonePerformance(performance, destination) {
        if (!performance?.zonePerformance) return 50;

        const zone = this.getZoneFromPostalCode(destination.postalCode);
        const zoneData = performance.zonePerformance[zone];

        if (!zoneData) return 50;

        return Math.max(0, Math.min(100, zoneData.score || 50));
    }

    // ==========================================
    // PERFORMANCE DATA
    // ==========================================

    async getCarrierPerformance(carrierId, destination) {
        const cacheKey = `${carrierId}_${destination?.country || 'FR'}`;

        // Vérifier le cache
        if (this.performanceCache.has(cacheKey)) {
            const cached = this.performanceCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheExpiry) {
                return cached.data;
            }
        }

        // Récupérer depuis la base
        const result = await this.db.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
                AVG(CASE WHEN delivered_at IS NOT NULL THEN 
                    EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400 END) as avg_days,
                COUNT(CASE WHEN delivered_at <= estimated_delivery THEN 1 END) as on_time,
                COUNT(CASE WHEN status = 'exception' THEN 1 END) as exceptions
            FROM shipments 
            WHERE carrier = $1 
            AND created_at >= NOW() - INTERVAL '90 days'
            AND ($2::text IS NULL OR recipient_country = $2)
        `, [carrierId, destination?.country]);

        const data = result.rows[0];
        const performance = {
            totalShipments: parseInt(data.total) || 0,
            deliveryRate: data.total > 0 ? (data.delivered / data.total * 100) : 90,
            avgDeliveryDays: parseFloat(data.avg_days) || 3,
            onTimeRate: data.delivered > 0 ? (data.on_time / data.delivered * 100) : 85,
            exceptionRate: data.total > 0 ? (data.exceptions / data.total * 100) : 2
        };

        // Ajouter les performances par zone
        performance.zonePerformance = await this.getZonePerformance(carrierId);

        // Mettre en cache
        this.performanceCache.set(cacheKey, { data: performance, timestamp: Date.now() });

        return performance;
    }

    async getZonePerformance(carrierId) {
        const result = await this.db.query(`
            SELECT 
                SUBSTRING(recipient_postal_code, 1, 2) as zone,
                COUNT(*) as total,
                AVG(CASE WHEN delivered_at IS NOT NULL THEN 
                    EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400 END) as avg_days,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) * 100.0 / COUNT(*) as delivery_rate
            FROM shipments 
            WHERE carrier = $1 
            AND created_at >= NOW() - INTERVAL '90 days'
            AND recipient_country = 'FR'
            GROUP BY SUBSTRING(recipient_postal_code, 1, 2)
            HAVING COUNT(*) >= 10
        `, [carrierId]);

        const zones = {};
        for (const row of result.rows) {
            zones[row.zone] = {
                avgDays: parseFloat(row.avg_days) || 3,
                deliveryRate: parseFloat(row.delivery_rate) || 90,
                score: Math.min(100, parseFloat(row.delivery_rate) * 0.7 + (5 - Math.min(5, parseFloat(row.avg_days))) * 6)
            };
        }

        return zones;
    }

    async getCarrierPricing(carrierId, shipmentData) {
        if (!this.pricingService) {
            return this.estimatePricing(carrierId, shipmentData);
        }

        try {
            const quote = await this.pricingService.getQuote(carrierId, shipmentData);
            return quote;
        } catch (error) {
            return this.estimatePricing(carrierId, shipmentData);
        }
    }

    estimatePricing(carrierId, shipmentData) {
        const { weight, destination } = shipmentData;
        
        // Tarifs estimés par transporteur
        const basePrices = {
            colissimo: { base: 4.95, perKg: 0.50 },
            chronopost: { base: 9.90, perKg: 0.80 },
            mondial_relay: { base: 3.50, perKg: 0.30 },
            dhl: { base: 12.00, perKg: 1.00 },
            ups: { base: 11.50, perKg: 0.95 },
            fedex: { base: 13.00, perKg: 1.10 },
            gls: { base: 5.50, perKg: 0.55 },
            dpd: { base: 5.20, perKg: 0.50 }
        };

        const pricing = basePrices[carrierId] || { base: 6.00, perKg: 0.60 };
        const totalPrice = pricing.base + (weight || 1) * pricing.perKg;

        // Surcharge international
        const internationalSurcharge = destination?.country !== 'FR' ? 5.00 : 0;

        return {
            basePrice: pricing.base,
            weightPrice: (weight || 1) * pricing.perKg,
            surcharges: internationalSurcharge,
            totalPrice: totalPrice + internationalSurcharge,
            currency: 'EUR',
            estimated: true
        };
    }

    // ==========================================
    // WEIGHT ADJUSTMENT & FINAL SCORE
    // ==========================================

    adjustWeights(prioritize) {
        if (!prioritize) return this.weights;

        const adjusted = { ...this.weights };

        switch (prioritize) {
            case 'price':
                adjusted.price = 0.50;
                adjusted.speed = 0.15;
                adjusted.reliability = 0.20;
                break;
            case 'speed':
                adjusted.price = 0.15;
                adjusted.speed = 0.50;
                adjusted.reliability = 0.20;
                break;
            case 'reliability':
                adjusted.price = 0.15;
                adjusted.speed = 0.15;
                adjusted.reliability = 0.50;
                break;
        }

        return adjusted;
    }

    calculateFinalScore(scores, weights) {
        let totalScore = 0;
        let totalWeight = 0;

        for (const [factor, weight] of Object.entries(weights)) {
            if (scores[factor] !== undefined) {
                totalScore += scores[factor] * weight;
                totalWeight += weight;
            }
        }

        return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
    }

    // ==========================================
    // RECOMMENDATION BUILDING
    // ==========================================

    buildRecommendation(rankedCarriers, shipmentData) {
        const best = rankedCarriers[0];
        const alternatives = rankedCarriers.slice(1, 4);

        return {
            success: true,
            recommended: {
                carrier: best.carrier,
                score: best.finalScore,
                pricing: best.pricing,
                estimatedDelivery: this.calculateEstimatedDelivery(best),
                confidence: this.calculateConfidence(best),
                reasons: this.generateReasons(best)
            },
            alternatives: alternatives.map(alt => ({
                carrier: alt.carrier,
                score: alt.finalScore,
                pricing: alt.pricing,
                estimatedDelivery: this.calculateEstimatedDelivery(alt),
                comparedToBest: this.compareToRecommended(alt, best)
            })),
            factors: this.explainFactors(best, shipmentData),
            metadata: {
                analyzedCarriers: rankedCarriers.length,
                analysisDate: new Date().toISOString(),
                dataPoints: best.performance?.totalShipments || 0
            }
        };
    }

    calculateEstimatedDelivery(scoredCarrier) {
        const avgDays = scoredCarrier.performance?.avgDeliveryDays || 3;
        const deliveryDate = new Date();
        deliveryDate.setDate(deliveryDate.getDate() + Math.ceil(avgDays));

        // Ajuster pour les weekends
        if (deliveryDate.getDay() === 0) deliveryDate.setDate(deliveryDate.getDate() + 1);
        if (deliveryDate.getDay() === 6) deliveryDate.setDate(deliveryDate.getDate() + 2);

        return {
            date: deliveryDate.toISOString().split('T')[0],
            daysRange: `${Math.floor(avgDays)}-${Math.ceil(avgDays) + 1} jours`,
            confidence: scoredCarrier.performance?.totalShipments > 100 ? 'high' : 'medium'
        };
    }

    calculateConfidence(scoredCarrier) {
        const dataPoints = scoredCarrier.performance?.totalShipments || 0;

        if (dataPoints >= 500) return { level: 'high', percentage: 95 };
        if (dataPoints >= 100) return { level: 'medium', percentage: 80 };
        if (dataPoints >= 20) return { level: 'low', percentage: 60 };
        return { level: 'very_low', percentage: 40 };
    }

    generateReasons(scoredCarrier) {
        const reasons = [];
        const { scores, pricing, performance } = scoredCarrier;

        if (scores.reliability >= 85) {
            reasons.push(`Taux de livraison excellent (${performance?.deliveryRate?.toFixed(1)}%)`);
        }

        if (scores.price >= 80) {
            reasons.push(`Prix compétitif (${pricing?.totalPrice?.toFixed(2)}€)`);
        }

        if (scores.speed >= 85) {
            reasons.push(`Délai rapide (~${performance?.avgDeliveryDays?.toFixed(1)} jours)`);
        }

        if (scores.zonePerformance >= 80) {
            reasons.push('Excellentes performances dans cette zone');
        }

        return reasons.length > 0 ? reasons : ['Meilleur équilibre prix/qualité/délai'];
    }

    compareToRecommended(alt, best) {
        const priceDiff = alt.pricing?.totalPrice - best.pricing?.totalPrice;
        const scoreDiff = alt.finalScore - best.finalScore;

        return {
            priceDifference: priceDiff ? `${priceDiff > 0 ? '+' : ''}${priceDiff.toFixed(2)}€` : 'N/A',
            scoreDifference: scoreDiff,
            tradeoffs: this.identifyTradeoffs(alt, best)
        };
    }

    identifyTradeoffs(alt, best) {
        const tradeoffs = [];

        if (alt.scores.price > best.scores.price) {
            tradeoffs.push('Moins cher');
        }
        if (alt.scores.speed > best.scores.speed) {
            tradeoffs.push('Plus rapide');
        }
        if (alt.scores.reliability > best.scores.reliability) {
            tradeoffs.push('Plus fiable');
        }

        return tradeoffs;
    }

    explainFactors(scoredCarrier, shipmentData) {
        return {
            price: {
                weight: `${this.weights.price * 100}%`,
                score: scoredCarrier.scores.price,
                value: `${scoredCarrier.pricing?.totalPrice?.toFixed(2)}€`
            },
            speed: {
                weight: `${this.weights.speed * 100}%`,
                score: scoredCarrier.scores.speed,
                value: `~${scoredCarrier.performance?.avgDeliveryDays?.toFixed(1)} jours`
            },
            reliability: {
                weight: `${this.weights.reliability * 100}%`,
                score: scoredCarrier.scores.reliability,
                value: `${scoredCarrier.performance?.deliveryRate?.toFixed(1)}% livraison`
            }
        };
    }

    generateScoreDetails(scores, pricing, performance) {
        return {
            priceDetail: pricing?.totalPrice ? `${pricing.totalPrice.toFixed(2)}€` : 'N/A',
            speedDetail: performance?.avgDeliveryDays ? `${performance.avgDeliveryDays.toFixed(1)}j` : 'N/A',
            reliabilityDetail: performance?.deliveryRate ? `${performance.deliveryRate.toFixed(1)}%` : 'N/A'
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getAvailableCarriers(orgId, origin, destination, excludeCarriers) {
        const result = await this.db.query(`
            SELECT c.* FROM carriers c
            JOIN organization_carriers oc ON c.id = oc.carrier_id
            WHERE oc.organization_id = $1 
            AND oc.active = true
            AND c.id NOT IN (SELECT unnest($2::text[]))
            AND (c.countries_served IS NULL OR $3 = ANY(c.countries_served))
        `, [orgId, excludeCarriers, destination?.country || 'FR']);

        return result.rows;
    }

    getZoneFromPostalCode(postalCode) {
        if (!postalCode) return '75';
        return postalCode.toString().substring(0, 2);
    }

    async logRecommendation(orgId, shipmentData, recommendation) {
        try {
            await this.db.query(`
                INSERT INTO carrier_recommendations 
                (organization_id, shipment_data, recommended_carrier, score, alternatives, created_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
            `, [
                orgId,
                JSON.stringify(shipmentData),
                recommendation.recommended?.carrier?.id,
                recommendation.recommended?.score,
                JSON.stringify(recommendation.alternatives?.map(a => a.carrier.id))
            ]);
        } catch (error) {
            console.error('Error logging recommendation:', error);
        }
    }

    // ==========================================
    // GLOBAL OPTIMIZATION
    // ==========================================

    async optimizeGlobalSelection(recommendations, options) {
        // Optimisation pour minimiser le coût total ou équilibrer la charge
        const { optimizeFor = 'cost' } = options;

        if (optimizeFor === 'cost') {
            return this.optimizeForCost(recommendations);
        }

        if (optimizeFor === 'balance') {
            return this.optimizeForBalance(recommendations);
        }

        return recommendations;
    }

    optimizeForCost(recommendations) {
        // Déjà optimisé par défaut
        return {
            recommendations,
            totalCost: recommendations.reduce((sum, r) => sum + (r.recommended?.pricing?.totalPrice || 0), 0),
            optimization: 'cost'
        };
    }

    optimizeForBalance(recommendations) {
        // Redistribuer pour éviter de surcharger un transporteur
        const carrierCounts = {};

        const balanced = recommendations.map(rec => {
            const carrierId = rec.recommended?.carrier?.id;
            carrierCounts[carrierId] = (carrierCounts[carrierId] || 0) + 1;

            // Si un transporteur est trop sollicité, prendre une alternative
            if (carrierCounts[carrierId] > 10 && rec.alternatives?.length > 0) {
                const alt = rec.alternatives[0];
                carrierCounts[alt.carrier.id] = (carrierCounts[alt.carrier.id] || 0) + 1;
                carrierCounts[carrierId]--;
                return { ...rec, recommended: alt, switched: true };
            }

            return rec;
        });

        return {
            recommendations: balanced,
            carrierDistribution: carrierCounts,
            optimization: 'balance'
        };
    }
}

module.exports = { CarrierSelectionAI };
