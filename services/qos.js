/**
 * Routz v4.0 - Quality of Service & Carrier Performance Analytics
 * Analyse des retards, KPIs promis, alertes automatiques, SLA monitoring
 */

class QoSService {
    constructor(config = {}) {
        this.db = config.db;
        this.notifications = config.notifications;
        this.alertThresholds = config.alertThresholds || {
            deliveryDelay: 2,
            exceptionRate: 5,
            deliveryRateDrop: 5,
            slaBreachRisk: 24
        };
    }

    /**
     * Analyser les performances d'un transporteur
     */
    async analyzeCarrierPerformance(carrierId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const stats = await this.db.query(`
            SELECT 
                COUNT(*) as total_shipments,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
                COUNT(CASE WHEN status = 'exception' THEN 1 END) as exceptions,
                COUNT(CASE WHEN status = 'returned' THEN 1 END) as returned,
                AVG(CASE WHEN delivered_at IS NOT NULL THEN 
                    EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400 END) as avg_delivery_days,
                AVG(CASE WHEN delivered_at IS NOT NULL AND estimated_delivery IS NOT NULL THEN 
                    EXTRACT(EPOCH FROM (delivered_at - estimated_delivery))/86400 END) as avg_delay_days,
                COUNT(CASE WHEN delivered_at > estimated_delivery THEN 1 END) as late_deliveries,
                COUNT(CASE WHEN delivered_at <= estimated_delivery THEN 1 END) as on_time_deliveries
            FROM shipments WHERE carrier = $1 AND created_at >= $2
        `, [carrierId, startDate.toISOString()]);

        const data = stats.rows[0];
        const deliveryRate = data.total_shipments > 0 ? ((data.delivered / data.total_shipments) * 100).toFixed(2) : 0;
        const exceptionRate = data.total_shipments > 0 ? ((data.exceptions / data.total_shipments) * 100).toFixed(2) : 0;
        const onTimeRate = data.delivered > 0 ? ((data.on_time_deliveries / data.delivered) * 100).toFixed(2) : 0;

        const score = this.calculateCarrierScore({
            deliveryRate: parseFloat(deliveryRate),
            onTimeRate: parseFloat(onTimeRate),
            exceptionRate: parseFloat(exceptionRate),
            avgDeliveryDays: data.avg_delivery_days
        });

        const slaComparison = await this.compareSLAPromises(carrierId, startDate);

        return {
            carrierId,
            period: `${periodDays}d`,
            metrics: {
                totalShipments: parseInt(data.total_shipments),
                delivered: parseInt(data.delivered),
                exceptions: parseInt(data.exceptions),
                returned: parseInt(data.returned),
                lateDeliveries: parseInt(data.late_deliveries) || 0,
                onTimeDeliveries: parseInt(data.on_time_deliveries) || 0
            },
            kpis: {
                deliveryRate: parseFloat(deliveryRate),
                exceptionRate: parseFloat(exceptionRate),
                onTimeRate: parseFloat(onTimeRate),
                avgDeliveryDays: parseFloat(data.avg_delivery_days || 0).toFixed(1),
                avgDelayDays: parseFloat(data.avg_delay_days || 0).toFixed(1)
            },
            slaComparison,
            score,
            rating: this.getCarrierRating(score),
            alerts: await this.checkCarrierAlerts(carrierId, { deliveryRate, exceptionRate, onTimeRate })
        };
    }

    async compareSLAPromises(carrierId, startDate) {
        const slaPromises = {
            colissimo: { standard: 3, express: 2 },
            chronopost: { standard: 2, express: 1, '13h': 1 },
            dhl: { standard: 3, express: 2 },
            ups: { standard: 3, express: 2 },
            fedex: { standard: 3, express: 2 },
            mondial_relay: { standard: 5, express: 3 }
        };

        const promises = slaPromises[carrierId] || { standard: 3 };

        const byService = await this.db.query(`
            SELECT service, COUNT(*) as total,
                AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as actual_days,
                COUNT(CASE WHEN delivered_at <= shipped_at + INTERVAL '${promises.standard || 3} days' THEN 1 END) as within_sla
            FROM shipments WHERE carrier = $1 AND created_at >= $2 AND delivered_at IS NOT NULL
            GROUP BY service
        `, [carrierId, startDate.toISOString()]);

        return byService.rows.map(row => ({
            service: row.service,
            promisedDays: promises[row.service] || promises.standard || 3,
            actualAvgDays: parseFloat(row.actual_days || 0).toFixed(1),
            slaComplianceRate: row.total > 0 ? ((row.within_sla / row.total) * 100).toFixed(1) : 0,
            variance: (parseFloat(row.actual_days || 0) - (promises[row.service] || 3)).toFixed(1)
        }));
    }

    calculateCarrierScore({ deliveryRate, onTimeRate, exceptionRate, avgDeliveryDays }) {
        const weights = { deliveryRate: 0.35, onTimeRate: 0.30, exceptionRate: 0.20, speed: 0.15 };
        const deliveryScore = Math.min(deliveryRate, 100);
        const onTimeScore = Math.min(onTimeRate, 100);
        const exceptionScore = Math.max(0, 100 - exceptionRate * 10);
        const speedScore = Math.max(0, 100 - (avgDeliveryDays - 2) * 15);

        return Math.round(
            deliveryScore * weights.deliveryRate +
            onTimeScore * weights.onTimeRate +
            exceptionScore * weights.exceptionRate +
            speedScore * weights.speed
        );
    }

    getCarrierRating(score) {
        if (score >= 90) return { rating: 'A+', label: 'Excellent', color: '#10b981' };
        if (score >= 80) return { rating: 'A', label: 'Très bon', color: '#22c55e' };
        if (score >= 70) return { rating: 'B', label: 'Bon', color: '#84cc16' };
        if (score >= 60) return { rating: 'C', label: 'Correct', color: '#eab308' };
        if (score >= 50) return { rating: 'D', label: 'À améliorer', color: '#f97316' };
        return { rating: 'F', label: 'Insuffisant', color: '#ef4444' };
    }

    // ==========================================
    // DELAY ANALYSIS & DETECTION
    // ==========================================

    /**
     * Analyser les retards en temps réel
     */
    async analyzeDelays(orgId, options = {}) {
        const { carrierId, period = '7d' } = options;
        const periodDays = parseInt(period) || 7;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        let query = `
            SELECT 
                s.id,
                s.tracking_number,
                s.carrier,
                s.service,
                s.status,
                s.shipped_at,
                s.estimated_delivery,
                s.delivered_at,
                s.recipient_city,
                s.recipient_postal_code,
                CASE 
                    WHEN s.status = 'delivered' THEN 
                        EXTRACT(EPOCH FROM (s.delivered_at - s.estimated_delivery))/86400
                    WHEN s.estimated_delivery < NOW() THEN 
                        EXTRACT(EPOCH FROM (NOW() - s.estimated_delivery))/86400
                    ELSE 0
                END as delay_days,
                CASE 
                    WHEN s.status = 'delivered' AND s.delivered_at > s.estimated_delivery THEN 'late_delivered'
                    WHEN s.status != 'delivered' AND s.estimated_delivery < NOW() THEN 'overdue'
                    WHEN s.estimated_delivery < NOW() + INTERVAL '1 day' THEN 'at_risk'
                    ELSE 'on_track'
                END as delay_status
            FROM shipments s
            WHERE s.organization_id = $1 
            AND s.created_at >= $2
        `;
        const params = [orgId, startDate.toISOString()];

        if (carrierId) {
            query += ` AND s.carrier = $3`;
            params.push(carrierId);
        }

        query += ` ORDER BY delay_days DESC`;

        const result = await this.db.query(query, params);
        const shipments = result.rows;

        // Catégoriser les retards
        const categorized = {
            overdue: shipments.filter(s => s.delay_status === 'overdue'),
            lateDelivered: shipments.filter(s => s.delay_status === 'late_delivered'),
            atRisk: shipments.filter(s => s.delay_status === 'at_risk'),
            onTrack: shipments.filter(s => s.delay_status === 'on_track')
        };

        // Analyse des causes
        const delayReasons = await this.analyzeDelayReasons(orgId, startDate, carrierId);

        // Zones géographiques problématiques
        const problemZones = await this.identifyProblemZones(orgId, startDate, carrierId);

        // Tendances horaires
        const hourlyPatterns = await this.analyzeHourlyPatterns(orgId, startDate);

        return {
            summary: {
                total: shipments.length,
                overdue: categorized.overdue.length,
                lateDelivered: categorized.lateDelivered.length,
                atRisk: categorized.atRisk.length,
                onTrack: categorized.onTrack.length,
                avgDelayDays: this.calculateAvgDelay(shipments),
                maxDelayDays: Math.max(...shipments.map(s => s.delay_days || 0), 0)
            },
            categorized: {
                overdue: categorized.overdue.slice(0, 50),
                atRisk: categorized.atRisk.slice(0, 50)
            },
            delayReasons,
            problemZones,
            hourlyPatterns,
            recommendations: this.generateDelayRecommendations(categorized, delayReasons, problemZones)
        };
    }

    /**
     * Analyser les causes de retard
     */
    async analyzeDelayReasons(orgId, startDate, carrierId) {
        let query = `
            SELECT 
                te.status_code,
                te.description,
                COUNT(*) as occurrence_count,
                AVG(EXTRACT(EPOCH FROM (s.delivered_at - s.estimated_delivery))/86400) as avg_added_delay
            FROM tracking_events te
            JOIN shipments s ON s.id = te.shipment_id
            WHERE s.organization_id = $1 
            AND te.created_at >= $2
            AND te.status_code IN ('exception', 'delay', 'customs_hold', 'weather_delay', 'address_issue', 'failed_delivery')
        `;
        const params = [orgId, startDate.toISOString()];

        if (carrierId) {
            query += ` AND s.carrier = $3`;
            params.push(carrierId);
        }

        query += ` GROUP BY te.status_code, te.description ORDER BY occurrence_count DESC LIMIT 10`;

        const result = await this.db.query(query, params);

        return result.rows.map(row => ({
            reason: row.status_code,
            description: row.description,
            occurrences: parseInt(row.occurrence_count),
            avgAddedDelay: parseFloat(row.avg_added_delay || 0).toFixed(1),
            impact: this.categorizeImpact(row.occurrence_count, row.avg_added_delay)
        }));
    }

    /**
     * Identifier les zones géographiques problématiques
     */
    async identifyProblemZones(orgId, startDate, carrierId) {
        let query = `
            SELECT 
                SUBSTRING(s.recipient_postal_code, 1, 2) as dept_code,
                s.recipient_city,
                COUNT(*) as total,
                COUNT(CASE WHEN s.delivered_at > s.estimated_delivery THEN 1 END) as late,
                AVG(CASE WHEN s.delivered_at > s.estimated_delivery THEN 
                    EXTRACT(EPOCH FROM (s.delivered_at - s.estimated_delivery))/86400 
                END) as avg_delay
            FROM shipments s
            WHERE s.organization_id = $1 
            AND s.created_at >= $2
            AND s.status = 'delivered'
        `;
        const params = [orgId, startDate.toISOString()];

        if (carrierId) {
            query += ` AND s.carrier = $3`;
            params.push(carrierId);
        }

        query += ` 
            GROUP BY SUBSTRING(s.recipient_postal_code, 1, 2), s.recipient_city
            HAVING COUNT(*) >= 5
            ORDER BY (COUNT(CASE WHEN s.delivered_at > s.estimated_delivery THEN 1 END)::float / COUNT(*)) DESC
            LIMIT 15
        `;

        const result = await this.db.query(query, params);

        return result.rows.map(row => ({
            deptCode: row.dept_code,
            city: row.recipient_city,
            totalShipments: parseInt(row.total),
            lateShipments: parseInt(row.late),
            lateRate: ((row.late / row.total) * 100).toFixed(1),
            avgDelay: parseFloat(row.avg_delay || 0).toFixed(1),
            severity: row.late / row.total > 0.3 ? 'high' : row.late / row.total > 0.15 ? 'medium' : 'low'
        }));
    }

    /**
     * Patterns horaires d'expédition
     */
    async analyzeHourlyPatterns(orgId, startDate) {
        const result = await this.db.query(`
            SELECT 
                EXTRACT(HOUR FROM shipped_at) as hour,
                COUNT(*) as shipments,
                AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as avg_delivery_days
            FROM shipments
            WHERE organization_id = $1 
            AND created_at >= $2
            AND delivered_at IS NOT NULL
            GROUP BY EXTRACT(HOUR FROM shipped_at)
            ORDER BY hour
        `, [orgId, startDate.toISOString()]);

        return result.rows.map(row => ({
            hour: parseInt(row.hour),
            shipments: parseInt(row.shipments),
            avgDeliveryDays: parseFloat(row.avg_delivery_days || 0).toFixed(2)
        }));
    }

    // ==========================================
    // SLA MONITORING
    // ==========================================

    /**
     * Monitorer les SLA en temps réel
     */
    async monitorSLA(orgId) {
        // Expéditions à risque de breach SLA
        const atRisk = await this.db.query(`
            SELECT 
                s.*,
                EXTRACT(EPOCH FROM (s.estimated_delivery - NOW()))/3600 as hours_remaining
            FROM shipments s
            WHERE s.organization_id = $1
            AND s.status IN ('shipped', 'in_transit', 'out_for_delivery')
            AND s.estimated_delivery IS NOT NULL
            AND s.estimated_delivery < NOW() + INTERVAL '${this.alertThresholds.slaBreachRisk} hours'
            ORDER BY s.estimated_delivery ASC
        `, [orgId]);

        // SLA déjà en breach
        const breached = await this.db.query(`
            SELECT 
                s.*,
                EXTRACT(EPOCH FROM (NOW() - s.estimated_delivery))/3600 as hours_overdue
            FROM shipments s
            WHERE s.organization_id = $1
            AND s.status IN ('shipped', 'in_transit', 'out_for_delivery')
            AND s.estimated_delivery < NOW()
        `, [orgId]);

        // Stats par transporteur
        const byCarrier = await this.db.query(`
            SELECT 
                carrier,
                COUNT(*) as at_risk_count
            FROM shipments
            WHERE organization_id = $1
            AND status IN ('shipped', 'in_transit', 'out_for_delivery')
            AND estimated_delivery < NOW() + INTERVAL '${this.alertThresholds.slaBreachRisk} hours'
            GROUP BY carrier
        `, [orgId]);

        return {
            atRisk: {
                count: atRisk.rows.length,
                shipments: atRisk.rows.slice(0, 50).map(s => ({
                    ...s,
                    urgency: s.hours_remaining < 6 ? 'critical' : s.hours_remaining < 12 ? 'high' : 'medium'
                }))
            },
            breached: {
                count: breached.rows.length,
                shipments: breached.rows.slice(0, 50)
            },
            byCarrier: byCarrier.rows,
            alerts: await this.generateSLAAlerts(orgId, atRisk.rows, breached.rows)
        };
    }

    /**
     * Générer des alertes SLA
     */
    async generateSLAAlerts(orgId, atRisk, breached) {
        const alerts = [];

        // Alertes critiques pour les breaches
        if (breached.length > 0) {
            alerts.push({
                level: 'critical',
                type: 'sla_breach',
                message: `${breached.length} expédition(s) en dépassement SLA`,
                count: breached.length,
                action: 'contact_carrier'
            });
        }

        // Alertes pour les expéditions à risque
        const criticalRisk = atRisk.filter(s => s.hours_remaining < 6);
        if (criticalRisk.length > 0) {
            alerts.push({
                level: 'warning',
                type: 'sla_at_risk',
                message: `${criticalRisk.length} expédition(s) à risque imminent (<6h)`,
                count: criticalRisk.length,
                action: 'monitor_closely'
            });
        }

        return alerts;
    }

    // ==========================================
    // AUTOMATED ALERTS
    // ==========================================

    /**
     * Vérifier et envoyer les alertes automatiques
     */
    async checkAndSendAlerts(orgId) {
        const alerts = [];

        // 1. Vérifier les retards par transporteur
        const carriers = await this.getActiveCarriers(orgId);
        for (const carrier of carriers) {
            const perf = await this.analyzeCarrierPerformance(carrier, '7d');
            
            if (perf.kpis.deliveryRate < 90) {
                alerts.push({
                    type: 'carrier_performance',
                    level: perf.kpis.deliveryRate < 80 ? 'critical' : 'warning',
                    carrier,
                    message: `Taux de livraison ${carrier}: ${perf.kpis.deliveryRate}%`,
                    metric: 'delivery_rate',
                    value: perf.kpis.deliveryRate
                });
            }

            if (perf.kpis.exceptionRate > this.alertThresholds.exceptionRate) {
                alerts.push({
                    type: 'exception_rate',
                    level: 'warning',
                    carrier,
                    message: `Taux d'exceptions élevé ${carrier}: ${perf.kpis.exceptionRate}%`,
                    metric: 'exception_rate',
                    value: perf.kpis.exceptionRate
                });
            }
        }

        // 2. Vérifier les SLA
        const slaStatus = await this.monitorSLA(orgId);
        alerts.push(...slaStatus.alerts);

        // 3. Envoyer les notifications
        for (const alert of alerts) {
            await this.sendAlert(orgId, alert);
        }

        return alerts;
    }

    async sendAlert(orgId, alert) {
        // Log l'alerte
        await this.db.query(
            `INSERT INTO qos_alerts (organization_id, type, level, carrier, message, data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [orgId, alert.type, alert.level, alert.carrier, alert.message, JSON.stringify(alert)]
        );

        // Envoyer notification si critique
        if (alert.level === 'critical') {
            await this.notifications.send({
                type: 'qos_alert',
                level: alert.level,
                data: alert
            });
        }
    }

    async checkCarrierAlerts(carrierId, kpis) {
        const alerts = [];
        
        if (parseFloat(kpis.deliveryRate) < 85) {
            alerts.push({ type: 'low_delivery_rate', level: 'warning', message: 'Taux de livraison en dessous de 85%' });
        }
        if (parseFloat(kpis.exceptionRate) > 5) {
            alerts.push({ type: 'high_exception_rate', level: 'warning', message: 'Taux d\'exceptions supérieur à 5%' });
        }
        if (parseFloat(kpis.onTimeRate) < 80) {
            alerts.push({ type: 'low_on_time_rate', level: 'warning', message: 'Taux de ponctualité en dessous de 80%' });
        }

        return alerts;
    }

    // ==========================================
    // BENCHMARKING
    // ==========================================

    /**
     * Comparer les transporteurs entre eux
     */
    async benchmarkCarriers(orgId, period = '30d') {
        const carriers = await this.getActiveCarriers(orgId);
        const benchmarks = [];

        for (const carrier of carriers) {
            const perf = await this.analyzeCarrierPerformance(carrier, period);
            benchmarks.push({
                carrier,
                ...perf.kpis,
                score: perf.score,
                rating: perf.rating
            });
        }

        // Trier par score
        benchmarks.sort((a, b) => b.score - a.score);

        // Calculer les moyennes
        const avgDeliveryRate = benchmarks.reduce((sum, b) => sum + parseFloat(b.deliveryRate), 0) / benchmarks.length;
        const avgOnTimeRate = benchmarks.reduce((sum, b) => sum + parseFloat(b.onTimeRate), 0) / benchmarks.length;

        return {
            carriers: benchmarks,
            averages: {
                deliveryRate: avgDeliveryRate.toFixed(1),
                onTimeRate: avgOnTimeRate.toFixed(1)
            },
            best: benchmarks[0],
            worst: benchmarks[benchmarks.length - 1],
            recommendations: this.generateCarrierRecommendations(benchmarks)
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    async getActiveCarriers(orgId) {
        const result = await this.db.query(`
            SELECT DISTINCT carrier FROM shipments 
            WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        `, [orgId]);
        return result.rows.map(r => r.carrier);
    }

    calculateAvgDelay(shipments) {
        const delayed = shipments.filter(s => s.delay_days > 0);
        if (delayed.length === 0) return 0;
        return (delayed.reduce((sum, s) => sum + s.delay_days, 0) / delayed.length).toFixed(1);
    }

    categorizeImpact(occurrences, avgDelay) {
        if (occurrences > 50 || avgDelay > 3) return 'high';
        if (occurrences > 20 || avgDelay > 1.5) return 'medium';
        return 'low';
    }

    generateDelayRecommendations(categorized, delayReasons, problemZones) {
        const recommendations = [];

        if (categorized.overdue.length > 10) {
            recommendations.push({
                priority: 'high',
                action: 'contact_carriers',
                message: 'Contacter les transporteurs pour les colis en retard significatif'
            });
        }

        const highImpactReasons = delayReasons.filter(r => r.impact === 'high');
        if (highImpactReasons.length > 0) {
            recommendations.push({
                priority: 'medium',
                action: 'address_root_causes',
                message: `Adresser les causes principales: ${highImpactReasons.map(r => r.reason).join(', ')}`
            });
        }

        const severeZones = problemZones.filter(z => z.severity === 'high');
        if (severeZones.length > 0) {
            recommendations.push({
                priority: 'medium',
                action: 'review_zones',
                message: `Revoir la stratégie pour les zones: ${severeZones.map(z => z.deptCode).join(', ')}`
            });
        }

        return recommendations;
    }

    generateCarrierRecommendations(benchmarks) {
        const recommendations = [];
        
        const underperformers = benchmarks.filter(b => b.score < 60);
        if (underperformers.length > 0) {
            recommendations.push({
                type: 'review_carriers',
                message: `Envisager de revoir les contrats avec: ${underperformers.map(u => u.carrier).join(', ')}`
            });
        }

        const bestPerformer = benchmarks[0];
        if (bestPerformer && bestPerformer.score > 80) {
            recommendations.push({
                type: 'increase_volume',
                message: `Augmenter le volume avec ${bestPerformer.carrier} (score: ${bestPerformer.score})`
            });
        }

        return recommendations;
    }
}

module.exports = { QoSService }; 90) return { rating: 'A+', label: 'Excellent', color: '#10B981' };
        if (score >= 80) return { rating: 'A', label: 'Très bon', color: '#34D399' };
        if (score >= 70) return { rating: 'B', label: 'Bon', color: '#FBBF24' };
        if (score >= 60) return { rating: 'C', label: 'Moyen', color: '#F97316' };
        if (score >= 50) return { rating: 'D', label: 'Insuffisant', color: '#EF4444' };
        return { rating: 'F', label: 'Critique', color: '#DC2626' };
    }

    async detectDelays(orgId) {
        const delays = await this.db.query(`
            SELECT s.*, EXTRACT(EPOCH FROM (NOW() - s.estimated_delivery))/86400 as delay_days,
                EXTRACT(EPOCH FROM (NOW() - s.last_tracking_update))/3600 as hours_since_update
            FROM shipments s WHERE s.organization_id = $1
            AND s.status IN ('in_transit', 'shipped', 'out_for_delivery')
            AND (s.estimated_delivery < NOW() OR s.last_tracking_update < NOW() - INTERVAL '48 hours')
            ORDER BY delay_days DESC
        `, [orgId]);

        return delays.rows.map(shipment => ({
            shipmentId: shipment.id,
            trackingNumber: shipment.tracking_number,
            carrier: shipment.carrier,
            status: shipment.status,
            delayDays: Math.max(0, Math.round(shipment.delay_days * 10) / 10),
            hoursSinceUpdate: Math.round(shipment.hours_since_update),
            riskLevel: this.calculateDelayRisk(shipment),
            suggestedAction: this.suggestDelayAction(shipment)
        }));
    }

    calculateDelayRisk(shipment) {
        const delayDays = shipment.delay_days || 0;
        const hoursSinceUpdate = shipment.hours_since_update || 0;
        if (delayDays > 5 || hoursSinceUpdate > 96) return 'critical';
        if (delayDays > 3 || hoursSinceUpdate > 72) return 'high';
        if (delayDays > 1 || hoursSinceUpdate > 48) return 'medium';
        return 'low';
    }

    suggestDelayAction(shipment) {
        const risk = this.calculateDelayRisk(shipment);
        const actions = {
            critical: { action: 'contact_carrier_urgent', message: 'Contacter le transporteur en urgence', autoNotify: true },
            high: { action: 'contact_carrier', message: 'Ouvrir un ticket transporteur', autoNotify: true },
            medium: { action: 'monitor', message: 'Surveiller et préparer communication', autoNotify: false },
            low: { action: 'watch', message: 'Continuer la surveillance', autoNotify: false }
        };
        return actions[risk];
    }

    async analyzeDelayCauses(orgId, period = '30d') {
        const periodDays = parseInt(period) || 30;
        const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

        const byCarrier = await this.db.query(`
            SELECT carrier, COUNT(*) as total_delays,
                AVG(EXTRACT(EPOCH FROM (delivered_at - estimated_delivery))/86400) as avg_delay
            FROM shipments WHERE organization_id = $1 AND created_at >= $2 AND delivered_at > estimated_delivery
            GROUP BY carrier ORDER BY total_delays DESC
        `, [orgId, startDate.toISOString()]);

        const byZone = await this.db.query(`
            SELECT SUBSTRING(recipient_postal_code, 1, 2) as zone, COUNT(*) as total_delays,
                AVG(EXTRACT(EPOCH FROM (delivered_at - estimated_delivery))/86400) as avg_delay
            FROM shipments WHERE organization_id = $1 AND created_at >= $2 AND delivered_at > estimated_delivery
            GROUP BY SUBSTRING(recipient_postal_code, 1, 2) ORDER BY total_delays DESC LIMIT 10
        `, [orgId, startDate.toISOString()]);

        return {
            byCarrier: byCarrier.rows.map(r => ({ carrier: r.carrier, totalDelays: parseInt(r.total_delays), avgDelayDays: parseFloat(r.avg_delay || 0).toFixed(1) })),
            byZone: byZone.rows.map(r => ({ zone: r.zone, totalDelays: parseInt(r.total_delays), avgDelayDays: parseFloat(r.avg_delay || 0).toFixed(1) })),
            insights: this.generateDelayInsights(byCarrier.rows, byZone.rows)
        };
    }

    generateDelayInsights(byCarrier, byZone) {
        const insights = [];
        if (byCarrier.length > 0 && byCarrier[0].total_delays > 10) {
            insights.push({ type: 'carrier_issue', severity: 'high', message: `${byCarrier[0].carrier} concentre le plus de retards`, recommendation: 'Envisager un transporteur alternatif' });
        }
        if (byZone.length > 0) {
            insights.push({ type: 'zone_issue', severity: 'medium', message: `Le département ${byZone[0].zone} a le plus de retards`, recommendation: 'Vérifier les options pour cette zone' });
        }
        return insights;
    }

    async monitorSLAs(orgId) {
        const atRisk = await this.db.query(`
            SELECT s.*, EXTRACT(EPOCH FROM (s.estimated_delivery - NOW()))/3600 as hours_remaining
            FROM shipments s WHERE s.organization_id = $1
            AND s.status IN ('in_transit', 'shipped', 'out_for_delivery')
            AND s.estimated_delivery BETWEEN NOW() AND NOW() + INTERVAL '${this.alertThresholds.slaBreachRisk} hours'
            ORDER BY hours_remaining ASC
        `, [orgId]);

        const breached = await this.db.query(`
            SELECT COUNT(*) as count FROM shipments 
            WHERE organization_id = $1 AND status NOT IN ('delivered', 'returned', 'cancelled') AND estimated_delivery < NOW()
        `, [orgId]);

        return {
            atRiskShipments: atRisk.rows.map(s => ({
                id: s.id, trackingNumber: s.tracking_number, carrier: s.carrier,
                hoursRemaining: Math.max(0, Math.round(s.hours_remaining))
            })),
            breachedCount: parseInt(breached.rows[0].count),
            alerts: this.generateSLAAlerts(atRisk.rows, breached.rows[0].count)
        };
    }

    generateSLAAlerts(atRisk, breachedCount) {
        const alerts = [];
        if (breachedCount > 0) alerts.push({ type: 'sla_breach', severity: 'critical', message: `${breachedCount} expédition(s) en dépassement SLA` });
        const criticalRisk = atRisk.filter(s => s.hours_remaining < 4);
        if (criticalRisk.length > 0) alerts.push({ type: 'sla_risk_critical', severity: 'high', message: `${criticalRisk.length} expédition(s) à risque critique (<4h)` });
        return alerts;
    }

    async compareCarriers(orgId, period = '30d') {
        const carriers = ['colissimo', 'chronopost', 'mondial_relay', 'dhl', 'ups', 'fedex'];
        const comparisons = [];

        for (const carrier of carriers) {
            try {
                const perf = await this.analyzeCarrierPerformance(carrier, period);
                if (perf.metrics.totalShipments > 0) {
                    comparisons.push({ carrier, ...perf.kpis, score: perf.score, rating: perf.rating, volume: perf.metrics.totalShipments });
                }
            } catch (e) { /* Carrier not used */ }
        }

        comparisons.sort((a, b) => b.score - a.score);

        return {
            ranking: comparisons,
            bestOverall: comparisons[0]?.carrier,
            recommendations: this.generateCarrierRecommendations(comparisons)
        };
    }

    generateCarrierRecommendations(comparisons) {
        const recommendations = [];
        if (comparisons.length < 2) recommendations.push({ type: 'diversification', message: 'Diversifiez vos transporteurs pour réduire les risques' });
        
        const lowPerformers = comparisons.filter(c => c.score < 70);
        for (const carrier of lowPerformers) {
            recommendations.push({ type: 'performance_review', carrier: carrier.carrier, message: `${carrier.carrier} a un score de ${carrier.score}/100 - Envisagez une alternative` });
        }
        return recommendations;
    }

    async checkCarrierAlerts(carrierId, metrics) {
        const alerts = [];
        if (parseFloat(metrics.deliveryRate) < 90) alerts.push({ type: 'low_delivery_rate', severity: metrics.deliveryRate < 80 ? 'critical' : 'warning', message: `Taux de livraison bas: ${metrics.deliveryRate}%` });
        if (parseFloat(metrics.exceptionRate) > this.alertThresholds.exceptionRate) alerts.push({ type: 'high_exception_rate', severity: 'warning', message: `Taux d'exceptions élevé: ${metrics.exceptionRate}%` });
        if (parseFloat(metrics.onTimeRate) < 80) alerts.push({ type: 'low_on_time_rate', severity: 'warning', message: `Taux de ponctualité faible: ${metrics.onTimeRate}%` });
        return alerts;
    }

    async generateQoSReport(orgId, period = '30d') {
        const carrierComparison = await this.compareCarriers(orgId, period);
        const delays = await this.detectDelays(orgId);
        const delayCauses = await this.analyzeDelayCauses(orgId, period);
        const slaStatus = await this.monitorSLAs(orgId);

        return {
            generatedAt: new Date().toISOString(),
            period,
            summary: {
                totalCarriers: carrierComparison.ranking.length,
                avgScore: carrierComparison.ranking.length > 0 ? Math.round(carrierComparison.ranking.reduce((s, c) => s + c.score, 0) / carrierComparison.ranking.length) : 0,
                activeDelays: delays.length,
                slaBreaches: slaStatus.breachedCount
            },
            carrierPerformance: carrierComparison,
            activeDelays: delays.slice(0, 20),
            delayCauses,
            slaStatus,
            recommendations: [...carrierComparison.recommendations, ...delayCauses.insights]
        };
    }
}

module.exports = { QoSService };
