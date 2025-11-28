/**
 * Routz v4.0 - AI Predictions Service
 * Machine Learning pour prédictions logistiques
 */

class AIPredictionService {
    constructor(config = {}) {
        this.modelVersion = '1.0.0';
        this.cacheEnabled = config.cacheEnabled ?? true;
        this.cacheTTL = config.cacheTTL || 3600; // 1 hour
        this.cache = new Map();
        
        // Données d'entraînement historiques (simulées)
        this.historicalData = {
            carriers: {},
            routes: {},
            seasonal: {}
        };
    }

    // ==========================================
    // DELIVERY TIME PREDICTIONS
    // ==========================================

    /**
     * Prédire le délai de livraison
     */
    async predictDeliveryTime(params) {
        const {
            carrier,
            service,
            originPostalCode,
            destinationPostalCode,
            originCountry = 'FR',
            destinationCountry = 'FR',
            weight,
            dimensions,
            shipDate = new Date()
        } = params;

        const cacheKey = `delivery_${carrier}_${service}_${originPostalCode}_${destinationPostalCode}`;
        
        if (this.cacheEnabled && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTTL * 1000) {
                return cached.data;
            }
        }

        // Facteurs de prédiction
        const factors = await this.calculateDeliveryFactors({
            carrier,
            service,
            originPostalCode,
            destinationPostalCode,
            originCountry,
            destinationCountry,
            weight,
            shipDate
        });

        // Calcul du délai estimé
        const baseDeliveryDays = this.getBaseDeliveryDays(carrier, service, originCountry, destinationCountry);
        const adjustedDays = this.applyFactors(baseDeliveryDays, factors);
        
        // Calcul de l'intervalle de confiance
        const prediction = {
            estimatedDays: Math.round(adjustedDays),
            minDays: Math.max(1, Math.floor(adjustedDays * 0.8)),
            maxDays: Math.ceil(adjustedDays * 1.3),
            confidence: this.calculateConfidence(factors),
            estimatedDeliveryDate: this.calculateDeliveryDate(shipDate, Math.round(adjustedDays)),
            factors: {
                carrierPerformance: factors.carrierScore,
                routeEfficiency: factors.routeScore,
                seasonalImpact: factors.seasonalScore,
                weatherRisk: factors.weatherScore,
                capacityUtilization: factors.capacityScore
            },
            recommendations: this.generateRecommendations(factors, carrier, service)
        };

        // Cache result
        if (this.cacheEnabled) {
            this.cache.set(cacheKey, { data: prediction, timestamp: Date.now() });
        }

        return prediction;
    }

    /**
     * Calculer les facteurs de prédiction
     */
    async calculateDeliveryFactors(params) {
        const { carrier, service, originPostalCode, destinationPostalCode, shipDate } = params;

        // Score performance transporteur (basé sur historique)
        const carrierScore = this.getCarrierPerformanceScore(carrier, service);

        // Score efficacité route
        const routeScore = this.getRouteEfficiencyScore(originPostalCode, destinationPostalCode);

        // Impact saisonnier
        const seasonalScore = this.getSeasonalImpact(shipDate);

        // Risque météo (simulation)
        const weatherScore = this.getWeatherRiskScore(destinationPostalCode, shipDate);

        // Utilisation capacité
        const capacityScore = this.getCapacityScore(carrier, shipDate);

        return {
            carrierScore,
            routeScore,
            seasonalScore,
            weatherScore,
            capacityScore
        };
    }

    getBaseDeliveryDays(carrier, service, originCountry, destinationCountry) {
        const isInternational = originCountry !== destinationCountry;
        
        const baseDelays = {
            colissimo: { standard: 3, express: 2 },
            chronopost: { standard: 2, express: 1, '13h': 1 },
            mondial_relay: { standard: 4, express: 3 },
            dhl: { standard: isInternational ? 5 : 2, express: isInternational ? 3 : 1 },
            ups: { standard: isInternational ? 5 : 3, express: isInternational ? 2 : 1 },
            fedex: { standard: isInternational ? 5 : 3, express: isInternational ? 2 : 1 }
        };

        return baseDelays[carrier]?.[service] || 3;
    }

    getCarrierPerformanceScore(carrier, service) {
        // Simulé - en production, basé sur données réelles
        const scores = {
            colissimo: { standard: 0.92, express: 0.95 },
            chronopost: { standard: 0.96, express: 0.98, '13h': 0.97 },
            mondial_relay: { standard: 0.88, express: 0.91 },
            dhl: { standard: 0.94, express: 0.97 },
            ups: { standard: 0.93, express: 0.96 },
            fedex: { standard: 0.94, express: 0.97 }
        };
        return scores[carrier]?.[service] || 0.90;
    }

    getRouteEfficiencyScore(origin, destination) {
        // Simulé - basé sur zones géographiques
        const originZone = this.getPostalZone(origin);
        const destZone = this.getPostalZone(destination);
        
        if (originZone === destZone) return 1.0; // Même zone
        if (Math.abs(originZone - destZone) <= 2) return 0.95; // Zones proches
        return 0.85; // Zones éloignées
    }

    getPostalZone(postalCode) {
        if (!postalCode) return 5;
        const prefix = parseInt(postalCode.substring(0, 2));
        if (prefix <= 20) return 1; // Nord
        if (prefix <= 40) return 2; // Centre
        if (prefix <= 60) return 3; // Sud-Ouest
        if (prefix <= 80) return 4; // Sud-Est
        return 5; // Est/DOM-TOM
    }

    getSeasonalImpact(date) {
        const month = date.getMonth();
        const day = date.getDate();
        
        // Périodes critiques
        if (month === 11 && day >= 15) return 0.70; // Noël
        if (month === 10 && day >= 20) return 0.80; // Black Friday
        if (month === 0 && day <= 10) return 0.85; // Soldes hiver
        if (month === 6) return 0.90; // Soldes été
        if (month === 7) return 0.95; // Août
        
        return 1.0; // Normal
    }

    getWeatherRiskScore(postalCode, date) {
        const month = date.getMonth();
        const zone = this.getPostalZone(postalCode);
        
        // Risques hivernaux
        if ([11, 0, 1].includes(month)) {
            if (zone >= 4) return 0.90; // Montagnes
            return 0.95;
        }
        
        return 1.0;
    }

    getCapacityScore(carrier, date) {
        const dayOfWeek = date.getDay();
        
        // Lundi = forte demande
        if (dayOfWeek === 1) return 0.92;
        // Vendredi = pics
        if (dayOfWeek === 5) return 0.90;
        // Week-end = pas de traitement
        if (dayOfWeek === 0 || dayOfWeek === 6) return 0.85;
        
        return 1.0;
    }

    applyFactors(baseDays, factors) {
        let adjusted = baseDays;
        
        // Appliquer les facteurs (inversés car score < 1 = retard)
        adjusted /= factors.carrierScore;
        adjusted /= factors.routeScore;
        adjusted /= factors.seasonalScore;
        adjusted /= factors.weatherScore;
        adjusted /= factors.capacityScore;
        
        return adjusted;
    }

    calculateConfidence(factors) {
        const avgScore = Object.values(factors).reduce((a, b) => a + b, 0) / Object.keys(factors).length;
        return Math.round(avgScore * 100);
    }

    calculateDeliveryDate(shipDate, days) {
        const date = new Date(shipDate);
        let addedDays = 0;
        
        while (addedDays < days) {
            date.setDate(date.getDate() + 1);
            const dayOfWeek = date.getDay();
            if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
                addedDays++;
            }
        }
        
        return date.toISOString().split('T')[0];
    }

    generateRecommendations(factors, carrier, service) {
        const recommendations = [];
        
        if (factors.seasonalScore < 0.85) {
            recommendations.push({
                type: 'warning',
                message: 'Période de forte activité - Prévoyez des délais supplémentaires',
                action: 'Considérez un service express pour garantir la livraison'
            });
        }
        
        if (factors.carrierScore < 0.90) {
            recommendations.push({
                type: 'info',
                message: `Performance ${carrier} en dessous de la moyenne`,
                action: 'Comparez avec d\'autres transporteurs'
            });
        }
        
        if (factors.weatherScore < 0.95) {
            recommendations.push({
                type: 'alert',
                message: 'Risques météorologiques identifiés',
                action: 'Informez le client d\'un possible retard'
            });
        }
        
        return recommendations;
    }

    // ==========================================
    // CARRIER RECOMMENDATIONS
    // ==========================================

    /**
     * Recommander le meilleur transporteur
     */
    async recommendCarrier(params) {
        const {
            originPostalCode,
            destinationPostalCode,
            weight,
            dimensions,
            priority = 'balanced', // speed, cost, reliability, balanced
            shipDate = new Date()
        } = params;

        const carriers = ['colissimo', 'chronopost', 'mondial_relay', 'dhl'];
        const recommendations = [];

        for (const carrier of carriers) {
            const services = this.getCarrierServices(carrier);
            
            for (const service of services) {
                const prediction = await this.predictDeliveryTime({
                    carrier,
                    service,
                    originPostalCode,
                    destinationPostalCode,
                    weight,
                    dimensions,
                    shipDate
                });

                const cost = this.estimateCost(carrier, service, weight, destinationPostalCode);
                
                const score = this.calculateRecommendationScore(prediction, cost, priority);

                recommendations.push({
                    carrier,
                    service,
                    prediction,
                    cost,
                    score,
                    pros: this.getCarrierPros(carrier, service),
                    cons: this.getCarrierCons(carrier, service)
                });
            }
        }

        // Trier par score
        recommendations.sort((a, b) => b.score - a.score);

        return {
            recommended: recommendations[0],
            alternatives: recommendations.slice(1, 4),
            all: recommendations
        };
    }

    getCarrierServices(carrier) {
        const services = {
            colissimo: ['standard', 'express'],
            chronopost: ['standard', 'express', '13h'],
            mondial_relay: ['standard'],
            dhl: ['standard', 'express']
        };
        return services[carrier] || ['standard'];
    }

    estimateCost(carrier, service, weight, postalCode) {
        // Tarifs simulés
        const baseCosts = {
            colissimo: { standard: 6.50, express: 12.90 },
            chronopost: { standard: 9.90, express: 15.90, '13h': 18.90 },
            mondial_relay: { standard: 4.50 },
            dhl: { standard: 14.90, express: 24.90 }
        };

        let cost = baseCosts[carrier]?.[service] || 10;
        
        // Ajustement poids
        if (weight > 2) cost += (weight - 2) * 1.5;
        if (weight > 5) cost += (weight - 5) * 2;
        
        return Math.round(cost * 100) / 100;
    }

    calculateRecommendationScore(prediction, cost, priority) {
        let score = 0;
        
        const speedScore = (10 - prediction.estimatedDays) / 10;
        const costScore = (30 - cost) / 30;
        const reliabilityScore = prediction.confidence / 100;
        
        switch (priority) {
            case 'speed':
                score = speedScore * 0.6 + reliabilityScore * 0.3 + costScore * 0.1;
                break;
            case 'cost':
                score = costScore * 0.6 + reliabilityScore * 0.3 + speedScore * 0.1;
                break;
            case 'reliability':
                score = reliabilityScore * 0.6 + speedScore * 0.2 + costScore * 0.2;
                break;
            default: // balanced
                score = speedScore * 0.33 + costScore * 0.33 + reliabilityScore * 0.34;
        }
        
        return Math.round(score * 100);
    }

    getCarrierPros(carrier, service) {
        const pros = {
            colissimo: ['Réseau étendu', 'Suivi fiable', 'Points relais'],
            chronopost: ['Rapidité', 'Livraison garantie', 'Créneaux précis'],
            mondial_relay: ['Économique', 'Points relais nombreux', 'Écologique'],
            dhl: ['International', 'Express fiable', 'Suivi détaillé']
        };
        return pros[carrier] || [];
    }

    getCarrierCons(carrier, service) {
        const cons = {
            colissimo: ['Délais variables', 'SAV parfois lent'],
            chronopost: ['Prix élevé', 'Zones limitées'],
            mondial_relay: ['Délais plus longs', 'Pas de domicile'],
            dhl: ['Prix premium', 'Surtaxes possibles']
        };
        return cons[carrier] || [];
    }

    // ==========================================
    // DEMAND FORECASTING
    // ==========================================

    /**
     * Prévision de la demande
     */
    async forecastDemand(params) {
        const {
            organizationId,
            period = 30, // jours
            granularity = 'daily' // daily, weekly, monthly
        } = params;

        const historical = await this.getHistoricalDemand(organizationId, 90);
        const forecast = this.calculateForecast(historical, period, granularity);
        
        return {
            period,
            granularity,
            forecast: forecast.predictions,
            trends: forecast.trends,
            seasonality: forecast.seasonality,
            confidence: forecast.confidence,
            recommendations: this.generateDemandRecommendations(forecast)
        };
    }

    async getHistoricalDemand(orgId, days) {
        // Simulé - en production, requête BDD
        const data = [];
        const now = new Date();
        
        for (let i = days; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            
            // Simulation avec tendance et saisonnalité
            const dayOfWeek = date.getDay();
            const baseVolume = 100;
            const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.3 : 1;
            const trend = 1 + (days - i) * 0.002; // Croissance légère
            const noise = 0.8 + Math.random() * 0.4;
            
            data.push({
                date: date.toISOString().split('T')[0],
                volume: Math.round(baseVolume * weekendFactor * trend * noise)
            });
        }
        
        return data;
    }

    calculateForecast(historical, period, granularity) {
        // Simple moving average + trend
        const windowSize = 7;
        const recentData = historical.slice(-windowSize);
        const avgVolume = recentData.reduce((s, d) => s + d.volume, 0) / windowSize;
        
        // Calculer la tendance
        const firstHalf = historical.slice(0, Math.floor(historical.length / 2));
        const secondHalf = historical.slice(Math.floor(historical.length / 2));
        const firstAvg = firstHalf.reduce((s, d) => s + d.volume, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((s, d) => s + d.volume, 0) / secondHalf.length;
        const trendRate = (secondAvg - firstAvg) / firstAvg;

        const predictions = [];
        const now = new Date();
        
        for (let i = 1; i <= period; i++) {
            const date = new Date(now);
            date.setDate(date.getDate() + i);
            const dayOfWeek = date.getDay();
            
            const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.3 : 1;
            const trendFactor = 1 + trendRate * (i / 30);
            const predicted = Math.round(avgVolume * weekendFactor * trendFactor);
            
            predictions.push({
                date: date.toISOString().split('T')[0],
                predicted,
                lower: Math.round(predicted * 0.8),
                upper: Math.round(predicted * 1.2)
            });
        }

        return {
            predictions,
            trends: {
                direction: trendRate > 0.02 ? 'up' : trendRate < -0.02 ? 'down' : 'stable',
                rate: Math.round(trendRate * 100),
                description: trendRate > 0 ? `+${Math.round(trendRate * 100)}% de croissance` : `${Math.round(trendRate * 100)}% de décroissance`
            },
            seasonality: {
                weekendDrop: 70,
                peakDays: ['mardi', 'mercredi'],
                lowDays: ['samedi', 'dimanche']
            },
            confidence: 75
        };
    }

    generateDemandRecommendations(forecast) {
        const recommendations = [];
        
        if (forecast.trends.direction === 'up') {
            recommendations.push({
                type: 'capacity',
                priority: 'high',
                message: 'Augmentation de la demande prévue',
                action: 'Vérifiez vos stocks et capacité d\'expédition'
            });
        }
        
        const peakDays = forecast.predictions.filter(p => p.predicted > 150);
        if (peakDays.length > 0) {
            recommendations.push({
                type: 'staffing',
                priority: 'medium',
                message: `${peakDays.length} jours de forte activité prévus`,
                action: 'Planifiez des ressources supplémentaires'
            });
        }
        
        return recommendations;
    }

    // ==========================================
    // ANOMALY DETECTION
    // ==========================================

    /**
     * Détection d'anomalies dans les livraisons
     */
    async detectAnomalies(shipments) {
        const anomalies = [];
        
        for (const shipment of shipments) {
            const checks = [
                this.checkDeliveryTimeAnomaly(shipment),
                this.checkRouteAnomaly(shipment),
                this.checkStatusAnomaly(shipment),
                this.checkCostAnomaly(shipment)
            ];
            
            const issues = checks.filter(c => c.isAnomaly);
            
            if (issues.length > 0) {
                anomalies.push({
                    shipmentId: shipment.id,
                    trackingNumber: shipment.trackingNumber,
                    issues,
                    severity: Math.max(...issues.map(i => i.severity)),
                    recommendedAction: this.getAnomalyAction(issues)
                });
            }
        }
        
        return {
            totalAnalyzed: shipments.length,
            anomaliesFound: anomalies.length,
            anomalies,
            summary: this.summarizeAnomalies(anomalies)
        };
    }

    checkDeliveryTimeAnomaly(shipment) {
        if (!shipment.estimatedDays || !shipment.actualDays) {
            return { isAnomaly: false };
        }
        
        const deviation = (shipment.actualDays - shipment.estimatedDays) / shipment.estimatedDays;
        
        if (deviation > 0.5) {
            return {
                isAnomaly: true,
                type: 'delivery_delay',
                severity: deviation > 1 ? 3 : 2,
                message: `Retard de ${Math.round(deviation * 100)}% vs estimation`,
                details: {
                    estimated: shipment.estimatedDays,
                    actual: shipment.actualDays
                }
            };
        }
        
        return { isAnomaly: false };
    }

    checkRouteAnomaly(shipment) {
        // Vérifier si le colis suit une route inhabituelle
        const events = shipment.trackingEvents || [];
        const locations = events.map(e => e.location).filter(Boolean);
        
        if (locations.length > 10) {
            return {
                isAnomaly: true,
                type: 'unusual_route',
                severity: 2,
                message: 'Nombre de points de passage anormal',
                details: { stopsCount: locations.length }
            };
        }
        
        return { isAnomaly: false };
    }

    checkStatusAnomaly(shipment) {
        const status = shipment.status;
        const daysSinceShip = shipment.daysSinceShip || 0;
        
        if (status === 'in_transit' && daysSinceShip > 7) {
            return {
                isAnomaly: true,
                type: 'stuck_shipment',
                severity: 3,
                message: `Colis en transit depuis ${daysSinceShip} jours`,
                details: { status, daysSinceShip }
            };
        }
        
        return { isAnomaly: false };
    }

    checkCostAnomaly(shipment) {
        // Vérifier si le coût est anormal
        const expectedCost = this.estimateCost(
            shipment.carrier,
            shipment.service,
            shipment.weight,
            shipment.destinationPostalCode
        );
        
        if (shipment.cost && shipment.cost > expectedCost * 1.5) {
            return {
                isAnomaly: true,
                type: 'cost_overrun',
                severity: 1,
                message: `Coût supérieur de ${Math.round((shipment.cost / expectedCost - 1) * 100)}% à l'estimation`,
                details: { expected: expectedCost, actual: shipment.cost }
            };
        }
        
        return { isAnomaly: false };
    }

    getAnomalyAction(issues) {
        const severityActions = {
            3: 'Action immédiate requise - Contactez le transporteur',
            2: 'Surveillance recommandée - Vérifiez sous 24h',
            1: 'Information - À noter pour analyse future'
        };
        
        const maxSeverity = Math.max(...issues.map(i => i.severity));
        return severityActions[maxSeverity];
    }

    summarizeAnomalies(anomalies) {
        const byType = {};
        const bySeverity = { 1: 0, 2: 0, 3: 0 };
        
        for (const anomaly of anomalies) {
            for (const issue of anomaly.issues) {
                byType[issue.type] = (byType[issue.type] || 0) + 1;
                bySeverity[issue.severity]++;
            }
        }
        
        return {
            byType,
            bySeverity,
            criticalCount: bySeverity[3],
            warningCount: bySeverity[2],
            infoCount: bySeverity[1]
        };
    }
}

module.exports = { AIPredictionService };
