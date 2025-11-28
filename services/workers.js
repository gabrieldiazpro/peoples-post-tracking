/**
 * ROUTZ - Background Workers
 * Queues Redis/BullMQ for webhooks, tracking polling, emails, batch processing
 */

const { Queue, Worker, QueueScheduler, QueueEvents } = require('bullmq');
const { Redis } = require('ioredis');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { EventEmitter } = require('events');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    },
    queues: {
        webhooks: {
            name: 'webhooks',
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            timeout: 30000
        },
        tracking: {
            name: 'tracking',
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            timeout: 60000
        },
        emails: {
            name: 'emails',
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            timeout: 30000
        },
        labels: {
            name: 'labels',
            attempts: 3,
            backoff: { type: 'exponential', delay: 3000 },
            timeout: 120000
        },
        reports: {
            name: 'reports',
            attempts: 2,
            backoff: { type: 'fixed', delay: 5000 },
            timeout: 300000
        },
        imports: {
            name: 'imports',
            attempts: 2,
            backoff: { type: 'fixed', delay: 10000 },
            timeout: 600000
        },
        notifications: {
            name: 'notifications',
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            timeout: 15000
        },
        cleanup: {
            name: 'cleanup',
            attempts: 1,
            timeout: 60000
        }
    },
    email: {
        host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER || 'apikey',
            pass: process.env.SMTP_PASSWORD
        },
        from: process.env.EMAIL_FROM || 'Routz <notifications@routz.io>'
    },
    tracking: {
        pollingInterval: 15 * 60 * 1000, // 15 minutes
        batchSize: 100,
        maxConcurrent: 10
    },
    workers: {
        concurrency: {
            webhooks: 10,
            tracking: 5,
            emails: 20,
            labels: 5,
            reports: 2,
            imports: 2,
            notifications: 50,
            cleanup: 1
        }
    }
};

// ============================================
// DATABASE & REDIS CONNECTIONS
// ============================================

const redis = new Redis(config.redis);
const subscriberRedis = new Redis(config.redis);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000
});

// ============================================
// EMAIL TRANSPORTER
// ============================================

const emailTransporter = nodemailer.createTransport(config.email);

// ============================================
// QUEUE MANAGER
// ============================================

class QueueManager {
    constructor() {
        this.queues = new Map();
        this.workers = new Map();
        this.schedulers = new Map();
        this.events = new Map();
        this.metrics = new Map();
    }

    createQueue(name, options = {}) {
        const queueConfig = config.queues[name] || { name };
        
        const queue = new Queue(queueConfig.name, {
            connection: config.redis,
            defaultJobOptions: {
                attempts: queueConfig.attempts || 3,
                backoff: queueConfig.backoff || { type: 'exponential', delay: 1000 },
                timeout: queueConfig.timeout || 30000,
                removeOnComplete: { count: 1000, age: 24 * 3600 },
                removeOnFail: { count: 5000, age: 7 * 24 * 3600 }
            },
            ...options
        });

        const scheduler = new QueueScheduler(queueConfig.name, { connection: config.redis });
        const events = new QueueEvents(queueConfig.name, { connection: config.redis });

        // Initialize metrics
        this.metrics.set(name, {
            processed: 0,
            failed: 0,
            completed: 0,
            delayed: 0,
            totalProcessingTime: 0
        });

        // Event handlers
        events.on('completed', ({ jobId }) => {
            const metrics = this.metrics.get(name);
            metrics.completed++;
            console.log(`[${name}] Job ${jobId} completed`);
        });

        events.on('failed', ({ jobId, failedReason }) => {
            const metrics = this.metrics.get(name);
            metrics.failed++;
            console.error(`[${name}] Job ${jobId} failed: ${failedReason}`);
        });

        events.on('delayed', ({ jobId }) => {
            const metrics = this.metrics.get(name);
            metrics.delayed++;
        });

        this.queues.set(name, queue);
        this.schedulers.set(name, scheduler);
        this.events.set(name, events);

        return queue;
    }

    createWorker(name, processor, options = {}) {
        const queueConfig = config.queues[name] || { name };
        const concurrency = config.workers.concurrency[name] || 5;

        const worker = new Worker(
            queueConfig.name,
            processor,
            {
                connection: config.redis,
                concurrency,
                ...options
            }
        );

        worker.on('completed', (job, result) => {
            const metrics = this.metrics.get(name);
            metrics.processed++;
            if (job.processedOn && job.finishedOn) {
                metrics.totalProcessingTime += job.finishedOn - job.processedOn;
            }
        });

        worker.on('failed', (job, err) => {
            console.error(`[${name}] Job ${job?.id} failed:`, err.message);
        });

        worker.on('error', (err) => {
            console.error(`[${name}] Worker error:`, err.message);
        });

        this.workers.set(name, worker);
        return worker;
    }

    getQueue(name) {
        return this.queues.get(name);
    }

    async getQueueStats(name) {
        const queue = this.queues.get(name);
        if (!queue) return null;

        const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount()
        ]);

        const metrics = this.metrics.get(name) || {};

        return {
            name,
            counts: { waiting, active, completed, failed, delayed },
            metrics: {
                processed: metrics.processed || 0,
                failed: metrics.failed || 0,
                averageProcessingTime: metrics.processed > 0 
                    ? Math.round(metrics.totalProcessingTime / metrics.processed) 
                    : 0
            }
        };
    }

    async getAllStats() {
        const stats = {};
        for (const name of this.queues.keys()) {
            stats[name] = await this.getQueueStats(name);
        }
        return stats;
    }

    async shutdown() {
        console.log('Shutting down queue manager...');
        
        for (const worker of this.workers.values()) {
            await worker.close();
        }
        
        for (const scheduler of this.schedulers.values()) {
            await scheduler.close();
        }
        
        for (const events of this.events.values()) {
            await events.close();
        }
        
        for (const queue of this.queues.values()) {
            await queue.close();
        }

        await redis.quit();
        await subscriberRedis.quit();
        
        console.log('Queue manager shut down complete');
    }
}

const queueManager = new QueueManager();

// ============================================
// WEBHOOK WORKER
// ============================================

const webhookProcessor = async (job) => {
    const { webhookId, url, event, payload, secret, retryCount = 0 } = job.data;

    console.log(`[webhooks] Processing webhook ${webhookId} to ${url}`);

    // Generate signature
    const timestamp = Date.now();
    const signaturePayload = `${timestamp}.${JSON.stringify(payload)}`;
    const signature = crypto
        .createHmac('sha256', secret)
        .update(signaturePayload)
        .digest('hex');

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Routz-Signature': signature,
                'X-Routz-Timestamp': timestamp.toString(),
                'X-Routz-Event': event,
                'X-Routz-Delivery-ID': job.id,
                'User-Agent': 'Routz-Webhooks/1.0'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000)
        });

        const responseBody = await response.text().catch(() => '');

        // Log delivery
        await pool.query(`
            INSERT INTO webhook_deliveries (webhook_id, event, status_code, response_body, delivered_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [webhookId, event, response.status, responseBody.substring(0, 1000)]);

        if (!response.ok) {
            // 4xx errors (except 429) are not retryable
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                // Mark webhook as disabled if too many client errors
                await pool.query(`
                    UPDATE webhooks 
                    SET consecutive_failures = consecutive_failures + 1,
                        disabled_at = CASE WHEN consecutive_failures >= 10 THEN NOW() ELSE NULL END
                    WHERE id = $1
                `, [webhookId]);
                
                throw new Error(`Webhook failed with status ${response.status}: ${responseBody}`);
            }
            throw new Error(`Webhook failed with status ${response.status}`);
        }

        // Reset consecutive failures on success
        await pool.query(`
            UPDATE webhooks SET consecutive_failures = 0, last_triggered_at = NOW() WHERE id = $1
        `, [webhookId]);

        return { status: response.status, delivered: true };

    } catch (error) {
        console.error(`[webhooks] Failed to deliver webhook ${webhookId}:`, error.message);

        await pool.query(`
            INSERT INTO webhook_deliveries (webhook_id, event, error, attempted_at)
            VALUES ($1, $2, $3, NOW())
        `, [webhookId, event, error.message]);

        throw error;
    }
};

// ============================================
// TRACKING POLLING WORKER
// ============================================

const trackingProcessor = async (job) => {
    const { shipmentIds, carrier, batchId } = job.data;
    const limit = pLimit(config.tracking.maxConcurrent);

    console.log(`[tracking] Processing batch ${batchId} with ${shipmentIds.length} shipments`);

    // Dynamic import of carrier connector
    let connector;
    switch (carrier) {
        case 'colissimo':
            connector = require('../connectors/colissimo').ColissimoClient;
            break;
        case 'chronopost':
            connector = require('../connectors/chronopost').ChronopostClient;
            break;
        // Add more carriers...
        default:
            throw new Error(`Unknown carrier: ${carrier}`);
    }

    const client = new connector();
    const results = { updated: 0, delivered: 0, exceptions: 0, errors: 0 };

    const tasks = shipmentIds.map(shipmentId => limit(async () => {
        try {
            // Get shipment tracking number
            const shipment = await pool.query(
                'SELECT id, tracking_number, status FROM shipments WHERE id = $1',
                [shipmentId]
            );

            if (shipment.rows.length === 0) return;

            const { tracking_number, status: currentStatus } = shipment.rows[0];

            // Get tracking info from carrier
            const tracking = await client.getTracking(tracking_number);

            // Update if status changed
            if (tracking.status !== currentStatus) {
                await pool.query(`
                    UPDATE shipments 
                    SET status = $1, 
                        status_description = $2,
                        delivered_at = $3,
                        last_tracking_update = NOW()
                    WHERE id = $4
                `, [tracking.status, tracking.statusDescription, tracking.deliveredAt, shipmentId]);

                // Store tracking events
                for (const event of tracking.events) {
                    await pool.query(`
                        INSERT INTO shipment_events (shipment_id, event_code, description, location, timestamp)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (shipment_id, event_code, timestamp) DO NOTHING
                    `, [shipmentId, event.code, event.description, event.location, event.timestamp]);
                }

                results.updated++;

                if (tracking.delivered) {
                    results.delivered++;
                    // Queue notification
                    await queueManager.getQueue('notifications').add('delivery', {
                        shipmentId,
                        type: 'delivered',
                        tracking
                    });
                }

                if (tracking.status === 'exception') {
                    results.exceptions++;
                    await queueManager.getQueue('notifications').add('exception', {
                        shipmentId,
                        type: 'exception',
                        tracking
                    });
                }

                // Trigger webhooks for status change
                const webhooks = await pool.query(`
                    SELECT w.* FROM webhooks w
                    JOIN shipments s ON s.organization_id = w.organization_id
                    WHERE s.id = $1 AND w.enabled = true AND $2 = ANY(w.events)
                `, [shipmentId, `shipment.${tracking.status}`]);

                for (const webhook of webhooks.rows) {
                    await queueManager.getQueue('webhooks').add('delivery', {
                        webhookId: webhook.id,
                        url: webhook.url,
                        event: `shipment.${tracking.status}`,
                        payload: { shipment_id: shipmentId, tracking },
                        secret: webhook.secret
                    });
                }
            }

        } catch (error) {
            results.errors++;
            console.error(`[tracking] Error updating shipment ${shipmentId}:`, error.message);
        }
    }));

    await Promise.all(tasks);

    console.log(`[tracking] Batch ${batchId} completed: ${results.updated} updated, ${results.delivered} delivered, ${results.exceptions} exceptions, ${results.errors} errors`);

    return results;
};

// Schedule tracking polling
const scheduleTrackingPolling = async () => {
    const queue = queueManager.getQueue('tracking');

    // Get active shipments grouped by carrier
    const activeShipments = await pool.query(`
        SELECT id, carrier FROM shipments 
        WHERE status NOT IN ('delivered', 'cancelled', 'returned')
        AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY carrier, created_at DESC
    `);

    const byCarrier = {};
    for (const shipment of activeShipments.rows) {
        if (!byCarrier[shipment.carrier]) {
            byCarrier[shipment.carrier] = [];
        }
        byCarrier[shipment.carrier].push(shipment.id);
    }

    // Create batched jobs per carrier
    for (const [carrier, ids] of Object.entries(byCarrier)) {
        const batches = [];
        for (let i = 0; i < ids.length; i += config.tracking.batchSize) {
            batches.push(ids.slice(i, i + config.tracking.batchSize));
        }

        for (let i = 0; i < batches.length; i++) {
            await queue.add('poll', {
                carrier,
                shipmentIds: batches[i],
                batchId: `${carrier}-${Date.now()}-${i}`
            }, {
                delay: i * 5000 // Stagger batches
            });
        }
    }

    console.log(`[tracking] Scheduled ${activeShipments.rows.length} shipments for tracking update`);
};

// ============================================
// EMAIL WORKER
// ============================================

const emailTemplates = {
    shipment_created: {
        subject: 'Votre colis {{tracking_number}} a été expédié',
        html: `
            <h2>Votre commande a été expédiée !</h2>
            <p>Bonjour {{recipient_name}},</p>
            <p>Votre colis avec le numéro de suivi <strong>{{tracking_number}}</strong> a été confié à {{carrier}}.</p>
            <p><a href="{{tracking_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Suivre mon colis</a></p>
            <p>Cordialement,<br>{{sender_name}}</p>
        `
    },
    shipment_delivered: {
        subject: 'Votre colis {{tracking_number}} a été livré',
        html: `
            <h2>Votre colis a été livré !</h2>
            <p>Bonjour {{recipient_name}},</p>
            <p>Votre colis avec le numéro de suivi <strong>{{tracking_number}}</strong> a été livré le {{delivery_date}}.</p>
            <p>Merci pour votre confiance !</p>
            <p>Cordialement,<br>{{sender_name}}</p>
        `
    },
    shipment_exception: {
        subject: '⚠️ Problème de livraison - Colis {{tracking_number}}',
        html: `
            <h2>Problème de livraison</h2>
            <p>Bonjour {{recipient_name}},</p>
            <p>Un problème est survenu lors de la livraison de votre colis <strong>{{tracking_number}}</strong>.</p>
            <p><strong>Détail :</strong> {{exception_reason}}</p>
            <p><a href="{{tracking_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Suivre mon colis</a></p>
            <p>Cordialement,<br>{{sender_name}}</p>
        `
    },
    return_created: {
        subject: 'Votre demande de retour {{return_number}}',
        html: `
            <h2>Votre demande de retour a été créée</h2>
            <p>Bonjour {{recipient_name}},</p>
            <p>Votre demande de retour <strong>{{return_number}}</strong> a été enregistrée.</p>
            <p>Vous trouverez ci-joint l'étiquette de retour à imprimer et coller sur votre colis.</p>
            <p><a href="{{return_label_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Télécharger l'étiquette</a></p>
            <p>Cordialement,<br>{{sender_name}}</p>
        `
    },
    password_reset: {
        subject: 'Réinitialisation de votre mot de passe Routz',
        html: `
            <h2>Réinitialisation de mot de passe</h2>
            <p>Bonjour {{first_name}},</p>
            <p>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.</p>
            <p><a href="{{reset_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Réinitialiser mon mot de passe</a></p>
            <p>Ce lien expire dans 1 heure.</p>
            <p>Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
            <p>Cordialement,<br>L'équipe Routz</p>
        `
    },
    invitation: {
        subject: 'Vous êtes invité à rejoindre {{organization_name}} sur Routz',
        html: `
            <h2>Invitation à rejoindre Routz</h2>
            <p>Bonjour,</p>
            <p>Vous avez été invité à rejoindre <strong>{{organization_name}}</strong> sur Routz en tant que <strong>{{role}}</strong>.</p>
            <p><a href="{{invite_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Accepter l'invitation</a></p>
            <p>Cette invitation expire dans 7 jours.</p>
            <p>Cordialement,<br>L'équipe Routz</p>
        `
    },
    daily_report: {
        subject: 'Rapport quotidien Routz - {{date}}',
        html: `
            <h2>Rapport quotidien - {{date}}</h2>
            <p>Bonjour {{recipient_name}},</p>
            <div style="background:#f5f5f5;padding:20px;border-radius:8px;margin:20px 0;">
                <h3 style="margin:0 0 10px 0;">Résumé</h3>
                <p style="margin:5px 0;"><strong>Expéditions créées :</strong> {{shipments_created}}</p>
                <p style="margin:5px 0;"><strong>Colis livrés :</strong> {{shipments_delivered}}</p>
                <p style="margin:5px 0;"><strong>Exceptions :</strong> {{shipments_exceptions}}</p>
                <p style="margin:5px 0;"><strong>Retours :</strong> {{returns_created}}</p>
            </div>
            <p><a href="{{dashboard_url}}" style="display:inline-block;background:#00FF88;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">Voir le dashboard</a></p>
            <p>Cordialement,<br>L'équipe Routz</p>
        `
    }
};

const emailProcessor = async (job) => {
    const { template, to, data, attachments = [], cc, bcc } = job.data;

    console.log(`[emails] Sending ${template} email to ${to}`);

    const templateConfig = emailTemplates[template];
    if (!templateConfig) {
        throw new Error(`Unknown email template: ${template}`);
    }

    // Replace placeholders
    let subject = templateConfig.subject;
    let html = templateConfig.html;

    for (const [key, value] of Object.entries(data)) {
        const placeholder = `{{${key}}}`;
        subject = subject.replace(new RegExp(placeholder, 'g'), value || '');
        html = html.replace(new RegExp(placeholder, 'g'), value || '');
    }

    // Wrap HTML in base template
    const fullHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
                h2 { color: #111; }
                a { color: #00D4AA; }
            </style>
        </head>
        <body>
            <div style="text-align:center;margin-bottom:30px;">
                <img src="https://routz.io/logo.png" alt="Routz" width="120">
            </div>
            ${html}
            <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">
            <p style="font-size:12px;color:#888;text-align:center;">
                Cet email a été envoyé par Routz. 
                <a href="{{unsubscribe_url}}">Se désabonner</a>
            </p>
        </body>
        </html>
    `;

    const mailOptions = {
        from: config.email.from,
        to,
        cc,
        bcc,
        subject,
        html: fullHtml,
        attachments: attachments.map(att => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
            encoding: att.encoding || 'base64'
        }))
    };

    const info = await emailTransporter.sendMail(mailOptions);

    // Log email
    await pool.query(`
        INSERT INTO email_logs (recipient, template, subject, message_id, sent_at)
        VALUES ($1, $2, $3, $4, NOW())
    `, [to, template, subject, info.messageId]);

    console.log(`[emails] Email sent to ${to}, messageId: ${info.messageId}`);

    return { messageId: info.messageId, accepted: info.accepted };
};

// ============================================
// LABEL GENERATION WORKER
// ============================================

const labelProcessor = async (job) => {
    const { shipmentId, carrier, request, userId, orgId } = job.data;

    console.log(`[labels] Generating label for shipment ${shipmentId}`);

    // Get carrier connector
    let connector;
    switch (carrier) {
        case 'colissimo':
            connector = require('../connectors/colissimo').ColissimoClient;
            break;
        case 'chronopost':
            connector = require('../connectors/chronopost').ChronopostClient;
            break;
        default:
            throw new Error(`Unknown carrier: ${carrier}`);
    }

    const client = new connector();

    try {
        const result = await client.createShipment(request);

        // Update shipment in database
        await pool.query(`
            UPDATE shipments 
            SET tracking_number = $1,
                status = 'pending',
                label_data = $2,
                label_url = $3,
                carrier_response = $4,
                updated_at = NOW()
            WHERE id = $5
        `, [result.trackingNumber, result.label.data, result.label.url, JSON.stringify(result.raw), shipmentId]);

        // Store label in S3/storage
        // await storageService.uploadLabel(shipmentId, result.label.data);

        // Send email notification
        if (request.recipient?.email) {
            await queueManager.getQueue('emails').add('shipment_created', {
                template: 'shipment_created',
                to: request.recipient.email,
                data: {
                    recipient_name: request.recipient.name || request.recipient.companyName,
                    tracking_number: result.trackingNumber,
                    carrier: carrier,
                    tracking_url: result.tracking.url,
                    sender_name: request.sender.companyName || request.sender.name
                }
            });
        }

        // Trigger webhooks
        const webhooks = await pool.query(`
            SELECT * FROM webhooks 
            WHERE organization_id = $1 AND enabled = true AND 'shipment.created' = ANY(events)
        `, [orgId]);

        for (const webhook of webhooks.rows) {
            await queueManager.getQueue('webhooks').add('delivery', {
                webhookId: webhook.id,
                url: webhook.url,
                event: 'shipment.created',
                payload: {
                    shipment_id: shipmentId,
                    tracking_number: result.trackingNumber,
                    carrier,
                    service: result.service,
                    created_at: new Date().toISOString()
                },
                secret: webhook.secret
            });
        }

        return result;

    } catch (error) {
        // Update shipment with error
        await pool.query(`
            UPDATE shipments 
            SET status = 'failed',
                error_message = $1,
                updated_at = NOW()
            WHERE id = $2
        `, [error.message, shipmentId]);

        throw error;
    }
};

// ============================================
// REPORT GENERATION WORKER
// ============================================

const reportProcessor = async (job) => {
    const { type, orgId, userId, params, format } = job.data;

    console.log(`[reports] Generating ${type} report for org ${orgId}`);

    let data;
    let filename;

    switch (type) {
        case 'shipments':
            data = await generateShipmentsReport(orgId, params);
            filename = `shipments-${params.dateFrom}-${params.dateTo}`;
            break;
        case 'performance':
            data = await generatePerformanceReport(orgId, params);
            filename = `performance-${params.month}`;
            break;
        case 'billing':
            data = await generateBillingReport(orgId, params);
            filename = `billing-${params.month}`;
            break;
        default:
            throw new Error(`Unknown report type: ${type}`);
    }

    // Generate file based on format
    let fileContent;
    let mimeType;

    if (format === 'csv') {
        fileContent = convertToCSV(data);
        mimeType = 'text/csv';
        filename += '.csv';
    } else if (format === 'xlsx') {
        fileContent = await convertToExcel(data);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        filename += '.xlsx';
    } else {
        fileContent = await convertToPDF(data, type);
        mimeType = 'application/pdf';
        filename += '.pdf';
    }

    // Store report
    const reportId = crypto.randomUUID();
    await pool.query(`
        INSERT INTO reports (id, organization_id, user_id, type, filename, mime_type, params, generated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [reportId, orgId, userId, type, filename, mimeType, JSON.stringify(params)]);

    // Upload to storage
    // const url = await storageService.uploadReport(reportId, fileContent, mimeType);

    // Send email with report
    const user = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [userId]);
    if (user.rows.length > 0) {
        await queueManager.getQueue('emails').add('report', {
            template: 'report_ready',
            to: user.rows[0].email,
            data: {
                first_name: user.rows[0].first_name,
                report_type: type,
                download_url: `https://app.routz.io/reports/${reportId}/download`
            }
        });
    }

    return { reportId, filename };
};

async function generateShipmentsReport(orgId, params) {
    const result = await pool.query(`
        SELECT 
            s.id, s.tracking_number, s.carrier, s.service, s.status,
            s.recipient_name, s.recipient_city, s.recipient_country,
            s.weight, s.created_at, s.delivered_at
        FROM shipments s
        WHERE s.organization_id = $1
        AND s.created_at BETWEEN $2 AND $3
        ORDER BY s.created_at DESC
    `, [orgId, params.dateFrom, params.dateTo]);

    return result.rows;
}

async function generatePerformanceReport(orgId, params) {
    const result = await pool.query(`
        SELECT 
            carrier,
            COUNT(*) as total_shipments,
            COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
            COUNT(*) FILTER (WHERE status = 'exception') as exceptions,
            AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400) as avg_delivery_days
        FROM shipments
        WHERE organization_id = $1
        AND DATE_TRUNC('month', created_at) = $2
        GROUP BY carrier
    `, [orgId, params.month]);

    return result.rows;
}

async function generateBillingReport(orgId, params) {
    const result = await pool.query(`
        SELECT 
            DATE(created_at) as date,
            carrier,
            COUNT(*) as shipments,
            SUM(shipping_cost) as total_cost
        FROM shipments
        WHERE organization_id = $1
        AND DATE_TRUNC('month', created_at) = $2
        GROUP BY DATE(created_at), carrier
        ORDER BY date
    `, [orgId, params.month]);

    return result.rows;
}

function convertToCSV(data) {
    if (!data.length) return '';
    
    const headers = Object.keys(data[0]);
    const rows = data.map(row => headers.map(h => JSON.stringify(row[h] || '')).join(','));
    
    return [headers.join(','), ...rows].join('\n');
}

async function convertToExcel(data) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');
    
    if (data.length > 0) {
        sheet.columns = Object.keys(data[0]).map(key => ({ header: key, key }));
        sheet.addRows(data);
    }
    
    return workbook.xlsx.writeBuffer();
}

async function convertToPDF(data, type) {
    // Implement PDF generation with pdfkit or puppeteer
    return Buffer.from('PDF content');
}

// ============================================
// NOTIFICATION WORKER
// ============================================

const notificationProcessor = async (job) => {
    const { type, shipmentId, userId, orgId, data } = job.data;

    console.log(`[notifications] Processing ${type} notification`);

    // Get notification preferences
    const prefs = await pool.query(`
        SELECT * FROM notification_preferences
        WHERE user_id = $1 OR (organization_id = $2 AND user_id IS NULL)
    `, [userId, orgId]);

    const userPrefs = prefs.rows.find(p => p.user_id) || prefs.rows[0] || {};

    // Email notification
    if (userPrefs.email_enabled !== false) {
        const user = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [userId]);
        if (user.rows.length > 0) {
            const templateMap = {
                'delivered': 'shipment_delivered',
                'exception': 'shipment_exception',
                'return_created': 'return_created'
            };

            if (templateMap[type]) {
                await queueManager.getQueue('emails').add(type, {
                    template: templateMap[type],
                    to: user.rows[0].email,
                    data
                });
            }
        }
    }

    // Push notification
    if (userPrefs.push_enabled) {
        await sendPushNotification(userId, {
            title: data.title,
            body: data.body,
            data: { shipmentId, type }
        });
    }

    // Slack notification
    if (userPrefs.slack_webhook_url) {
        await sendSlackNotification(userPrefs.slack_webhook_url, {
            text: `${data.title}: ${data.body}`,
            attachments: [{
                color: type === 'exception' ? 'danger' : 'good',
                fields: Object.entries(data).map(([k, v]) => ({ title: k, value: v, short: true }))
            }]
        });
    }

    // Store notification
    await pool.query(`
        INSERT INTO notifications (user_id, organization_id, type, title, body, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [userId, orgId, type, data.title, data.body, JSON.stringify(data)]);

    return { sent: true };
};

async function sendPushNotification(userId, notification) {
    // Implement with Firebase Cloud Messaging or similar
    console.log(`[notifications] Push notification to user ${userId}:`, notification.title);
}

async function sendSlackNotification(webhookUrl, payload) {
    await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

// ============================================
// CLEANUP WORKER
// ============================================

const cleanupProcessor = async (job) => {
    const { type } = job.data;

    console.log(`[cleanup] Running ${type} cleanup`);

    switch (type) {
        case 'old_jobs':
            // Clean old completed jobs
            for (const queue of queueManager.queues.values()) {
                await queue.clean(7 * 24 * 3600 * 1000, 'completed');
                await queue.clean(30 * 24 * 3600 * 1000, 'failed');
            }
            break;

        case 'expired_sessions':
            await pool.query(`
                DELETE FROM user_sessions WHERE expires_at < NOW()
            `);
            break;

        case 'old_audit_logs':
            await pool.query(`
                DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '90 days'
            `);
            break;

        case 'old_webhook_deliveries':
            await pool.query(`
                DELETE FROM webhook_deliveries WHERE created_at < NOW() - INTERVAL '30 days'
            `);
            break;

        case 'old_notifications':
            await pool.query(`
                UPDATE notifications SET deleted_at = NOW() 
                WHERE read_at IS NOT NULL AND created_at < NOW() - INTERVAL '30 days'
            `);
            break;
    }

    return { cleaned: type };
};

// ============================================
// INITIALIZE WORKERS
// ============================================

async function initializeWorkers() {
    console.log('Initializing background workers...');

    // Create queues
    queueManager.createQueue('webhooks');
    queueManager.createQueue('tracking');
    queueManager.createQueue('emails');
    queueManager.createQueue('labels');
    queueManager.createQueue('reports');
    queueManager.createQueue('notifications');
    queueManager.createQueue('cleanup');

    // Create workers
    queueManager.createWorker('webhooks', webhookProcessor);
    queueManager.createWorker('tracking', trackingProcessor);
    queueManager.createWorker('emails', emailProcessor);
    queueManager.createWorker('labels', labelProcessor);
    queueManager.createWorker('reports', reportProcessor);
    queueManager.createWorker('notifications', notificationProcessor);
    queueManager.createWorker('cleanup', cleanupProcessor);

    // Schedule recurring jobs
    const cleanupQueue = queueManager.getQueue('cleanup');
    
    // Clean old jobs daily at 3 AM
    await cleanupQueue.add('old_jobs', { type: 'old_jobs' }, {
        repeat: { cron: '0 3 * * *' }
    });

    // Clean expired sessions hourly
    await cleanupQueue.add('expired_sessions', { type: 'expired_sessions' }, {
        repeat: { cron: '0 * * * *' }
    });

    // Clean old audit logs weekly
    await cleanupQueue.add('old_audit_logs', { type: 'old_audit_logs' }, {
        repeat: { cron: '0 4 * * 0' }
    });

    // Schedule tracking polling every 15 minutes
    setInterval(scheduleTrackingPolling, config.tracking.pollingInterval);
    
    // Run initial tracking poll after 1 minute
    setTimeout(scheduleTrackingPolling, 60000);

    console.log('Background workers initialized');
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await queueManager.shutdown();
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await queueManager.shutdown();
    await pool.end();
    process.exit(0);
});

// ============================================
// EXPORTS
// ============================================

module.exports = {
    queueManager,
    initializeWorkers,
    scheduleTrackingPolling,
    
    // Individual processors for testing
    webhookProcessor,
    trackingProcessor,
    emailProcessor,
    labelProcessor,
    reportProcessor,
    notificationProcessor,
    cleanupProcessor,

    // Email templates
    emailTemplates
};
