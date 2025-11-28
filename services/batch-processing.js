/**
 * Routz v4.0 - Batch Processing Service
 * Traitement massif d'expéditions avec queue et workers
 */

const { EventEmitter } = require('events');

class BatchProcessingService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.concurrency = config.concurrency || 5;
        this.retryAttempts = config.retryAttempts || 3;
        this.retryDelay = config.retryDelay || 1000;
        this.batchSize = config.batchSize || 100;
        
        this.queue = [];
        this.processing = new Map();
        this.completed = new Map();
        this.failed = new Map();
        this.workers = 0;
        this.paused = false;
        
        this.jobs = new Map(); // Job tracking
    }

    // ==========================================
    // JOB MANAGEMENT
    // ==========================================

    /**
     * Créer un nouveau batch job
     */
    createJob(type, items, options = {}) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const job = {
            id: jobId,
            type, // create_shipments, print_labels, update_tracking, export_data
            status: 'pending',
            items: items.map((item, index) => ({
                id: `${jobId}_item_${index}`,
                data: item,
                status: 'pending',
                attempts: 0,
                result: null,
                error: null
            })),
            options: {
                priority: options.priority || 'normal', // low, normal, high, critical
                notifyOnComplete: options.notifyOnComplete ?? true,
                stopOnError: options.stopOnError ?? false,
                ...options
            },
            stats: {
                total: items.length,
                pending: items.length,
                processing: 0,
                completed: 0,
                failed: 0
            },
            progress: 0,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            estimatedCompletion: null
        };

        this.jobs.set(jobId, job);
        this.emit('job:created', job);
        
        return job;
    }

    /**
     * Démarrer un job
     */
    async startJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Job not found');
        if (job.status !== 'pending') throw new Error('Job already started');

        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.emit('job:started', job);

        // Ajouter les items à la queue
        for (const item of job.items) {
            this.queue.push({ jobId, item });
        }

        // Trier par priorité
        this.sortQueue();

        // Démarrer le processing
        this.processQueue();

        return job;
    }

    /**
     * Mettre en pause un job
     */
    pauseJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Job not found');
        
        job.status = 'paused';
        this.emit('job:paused', job);
        
        return job;
    }

    /**
     * Reprendre un job
     */
    resumeJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Job not found');
        
        job.status = 'running';
        this.emit('job:resumed', job);
        this.processQueue();
        
        return job;
    }

    /**
     * Annuler un job
     */
    cancelJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('Job not found');

        // Retirer les items de la queue
        this.queue = this.queue.filter(q => q.jobId !== jobId);

        // Marquer les items pending comme cancelled
        for (const item of job.items) {
            if (item.status === 'pending') {
                item.status = 'cancelled';
            }
        }

        job.status = 'cancelled';
        job.completedAt = new Date().toISOString();
        this.updateJobStats(job);
        this.emit('job:cancelled', job);
        
        return job;
    }

    /**
     * Obtenir le statut d'un job
     */
    getJobStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return null;

        return {
            id: job.id,
            type: job.type,
            status: job.status,
            progress: job.progress,
            stats: job.stats,
            estimatedCompletion: job.estimatedCompletion,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            duration: job.startedAt ? 
                (job.completedAt ? 
                    new Date(job.completedAt) - new Date(job.startedAt) :
                    Date.now() - new Date(job.startedAt)) : null
        };
    }

    /**
     * Liste des jobs
     */
    listJobs(filters = {}) {
        let jobs = Array.from(this.jobs.values());

        if (filters.status) {
            jobs = jobs.filter(j => j.status === filters.status);
        }

        if (filters.type) {
            jobs = jobs.filter(j => j.type === filters.type);
        }

        jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (filters.limit) {
            jobs = jobs.slice(0, filters.limit);
        }

        return jobs.map(j => this.getJobStatus(j.id));
    }

    // ==========================================
    // QUEUE PROCESSING
    // ==========================================

    sortQueue() {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        
        this.queue.sort((a, b) => {
            const jobA = this.jobs.get(a.jobId);
            const jobB = this.jobs.get(b.jobId);
            return priorityOrder[jobA.options.priority] - priorityOrder[jobB.options.priority];
        });
    }

    async processQueue() {
        while (this.queue.length > 0 && this.workers < this.concurrency) {
            const task = this.queue.shift();
            if (!task) break;

            const job = this.jobs.get(task.jobId);
            if (!job || job.status !== 'running') continue;

            this.workers++;
            this.processItem(task.jobId, task.item)
                .finally(() => {
                    this.workers--;
                    this.processQueue();
                });
        }
    }

    async processItem(jobId, item) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        item.status = 'processing';
        item.attempts++;
        job.stats.pending--;
        job.stats.processing++;
        this.emit('item:processing', { jobId, item });

        try {
            const result = await this.executeItem(job.type, item.data, job.options);
            
            item.status = 'completed';
            item.result = result;
            job.stats.processing--;
            job.stats.completed++;
            this.emit('item:completed', { jobId, item, result });

        } catch (error) {
            if (item.attempts < this.retryAttempts) {
                // Retry
                item.status = 'pending';
                job.stats.processing--;
                job.stats.pending++;
                
                await this.delay(this.retryDelay * item.attempts);
                this.queue.push({ jobId, item });
                this.emit('item:retry', { jobId, item, attempt: item.attempts });
            } else {
                // Failed
                item.status = 'failed';
                item.error = error.message;
                job.stats.processing--;
                job.stats.failed++;
                this.emit('item:failed', { jobId, item, error });

                if (job.options.stopOnError) {
                    this.pauseJob(jobId);
                }
            }
        }

        this.updateJobProgress(job);
        this.checkJobCompletion(job);
    }

    async executeItem(type, data, options) {
        // Simuler le traitement selon le type
        const processors = {
            create_shipments: () => this.processCreateShipment(data, options),
            print_labels: () => this.processPrintLabel(data, options),
            update_tracking: () => this.processUpdateTracking(data, options),
            export_data: () => this.processExportData(data, options),
            import_orders: () => this.processImportOrder(data, options),
            bulk_cancel: () => this.processBulkCancel(data, options)
        };

        const processor = processors[type];
        if (!processor) throw new Error(`Unknown job type: ${type}`);

        return await processor();
    }

    // Processors
    async processCreateShipment(data, options) {
        await this.delay(200 + Math.random() * 300); // Simulate API call
        
        // Simulate occasional failures
        if (Math.random() < 0.05) {
            throw new Error('Carrier API timeout');
        }

        return {
            shipmentId: `SHP_${Date.now()}`,
            trackingNumber: `${data.carrier?.toUpperCase() || 'XX'}${Math.random().toString().substr(2, 10)}`,
            labelUrl: `https://labels.routz.com/${Date.now()}.pdf`,
            status: 'created'
        };
    }

    async processPrintLabel(data, options) {
        await this.delay(100 + Math.random() * 200);
        
        return {
            printed: true,
            printerId: options.printerId || 'default',
            timestamp: new Date().toISOString()
        };
    }

    async processUpdateTracking(data, options) {
        await this.delay(150 + Math.random() * 250);
        
        return {
            trackingNumber: data.trackingNumber,
            status: 'in_transit',
            lastUpdate: new Date().toISOString(),
            events: [{ status: 'update', timestamp: new Date().toISOString() }]
        };
    }

    async processExportData(data, options) {
        await this.delay(50 + Math.random() * 100);
        
        return {
            exported: true,
            format: options.format || 'csv',
            rowId: data.id
        };
    }

    async processImportOrder(data, options) {
        await this.delay(100 + Math.random() * 200);
        
        return {
            orderId: `ORD_${Date.now()}`,
            imported: true,
            source: options.source
        };
    }

    async processBulkCancel(data, options) {
        await this.delay(200 + Math.random() * 300);
        
        return {
            shipmentId: data.shipmentId,
            cancelled: true,
            refundInitiated: options.refund ?? false
        };
    }

    // ==========================================
    // JOB UTILITIES
    // ==========================================

    updateJobStats(job) {
        job.stats.pending = job.items.filter(i => i.status === 'pending').length;
        job.stats.processing = job.items.filter(i => i.status === 'processing').length;
        job.stats.completed = job.items.filter(i => i.status === 'completed').length;
        job.stats.failed = job.items.filter(i => i.status === 'failed').length;
    }

    updateJobProgress(job) {
        const processed = job.stats.completed + job.stats.failed;
        job.progress = Math.round((processed / job.stats.total) * 100);

        // Estimate completion time
        if (job.startedAt && processed > 0) {
            const elapsed = Date.now() - new Date(job.startedAt);
            const avgTimePerItem = elapsed / processed;
            const remaining = job.stats.pending + job.stats.processing;
            const estimatedMs = remaining * avgTimePerItem;
            job.estimatedCompletion = new Date(Date.now() + estimatedMs).toISOString();
        }

        this.emit('job:progress', {
            jobId: job.id,
            progress: job.progress,
            stats: job.stats,
            estimatedCompletion: job.estimatedCompletion
        });
    }

    checkJobCompletion(job) {
        if (job.stats.pending === 0 && job.stats.processing === 0) {
            job.status = job.stats.failed > 0 ? 'completed_with_errors' : 'completed';
            job.completedAt = new Date().toISOString();
            
            this.emit('job:completed', {
                jobId: job.id,
                status: job.status,
                stats: job.stats,
                duration: new Date(job.completedAt) - new Date(job.startedAt)
            });
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==========================================
    // BATCH HELPERS
    // ==========================================

    /**
     * Créer des expéditions en masse
     */
    async createBulkShipments(orders, options = {}) {
        const items = orders.map(order => ({
            orderId: order.id,
            carrier: options.carrier || order.carrier || 'colissimo',
            service: options.service || order.service || 'standard',
            recipient: order.shippingAddress,
            parcels: order.parcels || [{ weight: 1 }]
        }));

        const job = this.createJob('create_shipments', items, {
            priority: options.priority || 'normal',
            notifyOnComplete: true,
            ...options
        });

        return this.startJob(job.id);
    }

    /**
     * Imprimer des étiquettes en masse
     */
    async printBulkLabels(shipmentIds, options = {}) {
        const items = shipmentIds.map(id => ({ shipmentId: id }));

        const job = this.createJob('print_labels', items, {
            priority: 'high',
            printerId: options.printerId,
            ...options
        });

        return this.startJob(job.id);
    }

    /**
     * Mettre à jour le tracking en masse
     */
    async updateBulkTracking(trackingNumbers, options = {}) {
        const items = trackingNumbers.map(tn => ({ trackingNumber: tn }));

        const job = this.createJob('update_tracking', items, {
            priority: 'normal',
            ...options
        });

        return this.startJob(job.id);
    }

    /**
     * Exporter des données en masse
     */
    async exportData(data, options = {}) {
        const job = this.createJob('export_data', data, {
            priority: 'low',
            format: options.format || 'csv',
            ...options
        });

        return this.startJob(job.id);
    }

    /**
     * Annuler des expéditions en masse
     */
    async cancelBulkShipments(shipmentIds, options = {}) {
        const items = shipmentIds.map(id => ({ shipmentId: id }));

        const job = this.createJob('bulk_cancel', items, {
            priority: 'high',
            refund: options.refund ?? true,
            ...options
        });

        return this.startJob(job.id);
    }

    // ==========================================
    // CLEANUP
    // ==========================================

    /**
     * Nettoyer les vieux jobs
     */
    cleanupOldJobs(maxAgeDays = 7) {
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        let cleaned = 0;

        for (const [jobId, job] of this.jobs) {
            if (new Date(job.createdAt) < cutoff && 
                ['completed', 'completed_with_errors', 'cancelled'].includes(job.status)) {
                this.jobs.delete(jobId);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * Obtenir les statistiques globales
     */
    getGlobalStats() {
        const jobs = Array.from(this.jobs.values());
        
        return {
            totalJobs: jobs.length,
            byStatus: {
                pending: jobs.filter(j => j.status === 'pending').length,
                running: jobs.filter(j => j.status === 'running').length,
                paused: jobs.filter(j => j.status === 'paused').length,
                completed: jobs.filter(j => j.status === 'completed').length,
                completedWithErrors: jobs.filter(j => j.status === 'completed_with_errors').length,
                cancelled: jobs.filter(j => j.status === 'cancelled').length
            },
            queueLength: this.queue.length,
            activeWorkers: this.workers,
            maxConcurrency: this.concurrency
        };
    }
}

module.exports = { BatchProcessingService };
