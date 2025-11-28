/**
 * ROUTZ - Billing & Subscriptions Service
 * Stripe integration for payments, subscriptions, invoices
 */

const Stripe = require('stripe');
const { Pool } = require('pg');
const { Redis } = require('ioredis');
const { EventEmitter } = require('events');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        apiVersion: '2023-10-16'
    },
    plans: {
        trial: {
            name: 'Trial',
            stripePriceId: null,
            limits: {
                shipmentsPerMonth: 50,
                usersCount: 2,
                carriersCount: 2,
                apiCalls: 1000
            },
            features: ['basic_tracking', 'email_support'],
            trialDays: 14
        },
        starter: {
            name: 'Starter',
            stripePriceId: process.env.STRIPE_STARTER_PRICE_ID,
            monthlyPrice: 19,
            yearlyPrice: 190,
            limits: {
                shipmentsPerMonth: 200,
                usersCount: 3,
                carriersCount: 3,
                apiCalls: 5000
            },
            features: ['basic_tracking', 'email_support', 'api_access', 'webhooks']
        },
        pro: {
            name: 'Pro',
            stripePriceId: process.env.STRIPE_PRO_PRICE_ID,
            monthlyPrice: 49,
            yearlyPrice: 490,
            limits: {
                shipmentsPerMonth: 1000,
                usersCount: 10,
                carriersCount: 10,
                apiCalls: 50000
            },
            features: ['advanced_tracking', 'priority_support', 'api_access', 'webhooks', 'analytics', 'returns', 'multi_warehouse']
        },
        business: {
            name: 'Business',
            stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID,
            monthlyPrice: 149,
            yearlyPrice: 1490,
            limits: {
                shipmentsPerMonth: 5000,
                usersCount: 50,
                carriersCount: -1, // unlimited
                apiCalls: 200000
            },
            features: ['advanced_tracking', 'priority_support', 'api_access', 'webhooks', 'analytics', 'returns', 'multi_warehouse', 'sso', 'dedicated_support', 'custom_integrations']
        },
        enterprise: {
            name: 'Enterprise',
            stripePriceId: null, // Custom pricing
            limits: {
                shipmentsPerMonth: -1, // unlimited
                usersCount: -1,
                carriersCount: -1,
                apiCalls: -1
            },
            features: ['all'],
            custom: true
        }
    },
    usage: {
        overage: {
            shipmentPrice: 0.15, // Per additional shipment
            apiCallPrice: 0.001 // Per additional API call
        }
    }
};

// ============================================
// CONNECTIONS
// ============================================

const stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: config.stripe.apiVersion
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// ============================================
// BILLING ERROR
// ============================================

class BillingError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = 'BillingError';
        this.code = code;
        this.details = details;
    }
}

// ============================================
// BILLING SERVICE
// ============================================

class BillingService extends EventEmitter {
    constructor() {
        super();
    }

    // ----------------------------------------
    // CUSTOMER MANAGEMENT
    // ----------------------------------------

    async createCustomer(organization, user) {
        try {
            const customer = await stripe.customers.create({
                email: organization.billingEmail || user.email,
                name: organization.name,
                metadata: {
                    organizationId: organization.id,
                    userId: user.id
                }
            });

            await pool.query(`
                UPDATE organizations 
                SET stripe_customer_id = $1, updated_at = NOW()
                WHERE id = $2
            `, [customer.id, organization.id]);

            this.emit('customer.created', { organizationId: organization.id, customerId: customer.id });

            return customer;
        } catch (error) {
            throw new BillingError('Failed to create customer', 'CUSTOMER_CREATE_FAILED', { error: error.message });
        }
    }

    async getCustomer(organizationId) {
        const result = await pool.query(
            'SELECT stripe_customer_id FROM organizations WHERE id = $1',
            [organizationId]
        );

        if (!result.rows[0]?.stripe_customer_id) {
            return null;
        }

        return stripe.customers.retrieve(result.rows[0].stripe_customer_id);
    }

    async updateCustomer(organizationId, updates) {
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        if (!org.rows[0]?.stripe_customer_id) {
            throw new BillingError('No Stripe customer found', 'CUSTOMER_NOT_FOUND');
        }

        return stripe.customers.update(org.rows[0].stripe_customer_id, updates);
    }

    // ----------------------------------------
    // SUBSCRIPTION MANAGEMENT
    // ----------------------------------------

    async createSubscription(organizationId, planId, options = {}) {
        const org = await pool.query(
            'SELECT id, name, stripe_customer_id, plan FROM organizations WHERE id = $1',
            [organizationId]
        );

        if (!org.rows[0]) {
            throw new BillingError('Organization not found', 'ORG_NOT_FOUND');
        }

        const organization = org.rows[0];
        const plan = config.plans[planId];

        if (!plan || !plan.stripePriceId) {
            throw new BillingError('Invalid plan', 'INVALID_PLAN');
        }

        let customerId = organization.stripe_customer_id;

        // Create customer if not exists
        if (!customerId) {
            const customer = await stripe.customers.create({
                name: organization.name,
                metadata: { organizationId: organization.id }
            });
            customerId = customer.id;
            
            await pool.query(
                'UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2',
                [customerId, organizationId]
            );
        }

        // Create subscription
        const subscriptionParams = {
            customer: customerId,
            items: [{ price: plan.stripePriceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            expand: ['latest_invoice.payment_intent'],
            metadata: {
                organizationId,
                planId
            }
        };

        // Handle trial
        if (options.withTrial && plan.trialDays) {
            subscriptionParams.trial_period_days = plan.trialDays;
        }

        // Handle promo code
        if (options.promoCode) {
            const promotionCodes = await stripe.promotionCodes.list({ code: options.promoCode, active: true });
            if (promotionCodes.data.length > 0) {
                subscriptionParams.promotion_code = promotionCodes.data[0].id;
            }
        }

        const subscription = await stripe.subscriptions.create(subscriptionParams);

        // Store subscription
        await pool.query(`
            INSERT INTO subscriptions (
                organization_id, stripe_subscription_id, plan, status,
                current_period_start, current_period_end, trial_start, trial_end
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (organization_id) 
            DO UPDATE SET 
                stripe_subscription_id = $2, plan = $3, status = $4,
                current_period_start = $5, current_period_end = $6,
                trial_start = $7, trial_end = $8, updated_at = NOW()
        `, [
            organizationId,
            subscription.id,
            planId,
            subscription.status,
            new Date(subscription.current_period_start * 1000),
            new Date(subscription.current_period_end * 1000),
            subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
            subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
        ]);

        // Update organization plan
        await pool.query(
            'UPDATE organizations SET plan = $1, updated_at = NOW() WHERE id = $2',
            [planId, organizationId]
        );

        this.emit('subscription.created', { organizationId, planId, subscriptionId: subscription.id });

        return {
            subscriptionId: subscription.id,
            status: subscription.status,
            clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
            plan: planId
        };
    }

    async getSubscription(organizationId) {
        const result = await pool.query(`
            SELECT s.*, o.plan as current_plan
            FROM subscriptions s
            JOIN organizations o ON o.id = s.organization_id
            WHERE s.organization_id = $1
        `, [organizationId]);

        if (!result.rows[0]) {
            return null;
        }

        const sub = result.rows[0];
        const plan = config.plans[sub.plan];

        return {
            id: sub.id,
            stripeSubscriptionId: sub.stripe_subscription_id,
            plan: sub.plan,
            planDetails: plan,
            status: sub.status,
            currentPeriodStart: sub.current_period_start,
            currentPeriodEnd: sub.current_period_end,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            trialEnd: sub.trial_end,
            isTrialing: sub.status === 'trialing',
            isActive: ['active', 'trialing'].includes(sub.status)
        };
    }

    async changePlan(organizationId, newPlanId) {
        const subscription = await this.getSubscription(organizationId);
        
        if (!subscription || !subscription.stripeSubscriptionId) {
            throw new BillingError('No active subscription', 'NO_SUBSCRIPTION');
        }

        const newPlan = config.plans[newPlanId];
        if (!newPlan || !newPlan.stripePriceId) {
            throw new BillingError('Invalid plan', 'INVALID_PLAN');
        }

        // Get current Stripe subscription
        const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);

        // Update subscription with new price
        const updated = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
            items: [{
                id: stripeSub.items.data[0].id,
                price: newPlan.stripePriceId
            }],
            proration_behavior: 'create_prorations',
            metadata: { planId: newPlanId }
        });

        // Update database
        await pool.query(`
            UPDATE subscriptions SET plan = $1, updated_at = NOW() WHERE organization_id = $2
        `, [newPlanId, organizationId]);

        await pool.query(`
            UPDATE organizations SET plan = $1, updated_at = NOW() WHERE id = $2
        `, [newPlanId, organizationId]);

        this.emit('subscription.updated', { organizationId, oldPlan: subscription.plan, newPlan: newPlanId });

        return { success: true, plan: newPlanId };
    }

    async cancelSubscription(organizationId, options = {}) {
        const subscription = await this.getSubscription(organizationId);
        
        if (!subscription?.stripeSubscriptionId) {
            throw new BillingError('No active subscription', 'NO_SUBSCRIPTION');
        }

        if (options.immediate) {
            // Cancel immediately
            await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
            
            await pool.query(`
                UPDATE subscriptions 
                SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                WHERE organization_id = $1
            `, [organizationId]);

            await pool.query(`
                UPDATE organizations SET plan = 'trial', updated_at = NOW() WHERE id = $1
            `, [organizationId]);
        } else {
            // Cancel at period end
            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                cancel_at_period_end: true
            });

            await pool.query(`
                UPDATE subscriptions 
                SET cancel_at_period_end = true, updated_at = NOW()
                WHERE organization_id = $1
            `, [organizationId]);
        }

        this.emit('subscription.cancelled', { organizationId, immediate: !!options.immediate });

        return { success: true, cancelledAt: options.immediate ? new Date() : subscription.currentPeriodEnd };
    }

    async reactivateSubscription(organizationId) {
        const subscription = await this.getSubscription(organizationId);
        
        if (!subscription?.stripeSubscriptionId) {
            throw new BillingError('No subscription found', 'NO_SUBSCRIPTION');
        }

        await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
            cancel_at_period_end: false
        });

        await pool.query(`
            UPDATE subscriptions 
            SET cancel_at_period_end = false, updated_at = NOW()
            WHERE organization_id = $1
        `, [organizationId]);

        return { success: true };
    }

    // ----------------------------------------
    // PAYMENT METHODS
    // ----------------------------------------

    async getPaymentMethods(organizationId) {
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        if (!org.rows[0]?.stripe_customer_id) {
            return [];
        }

        const methods = await stripe.paymentMethods.list({
            customer: org.rows[0].stripe_customer_id,
            type: 'card'
        });

        const customer = await stripe.customers.retrieve(org.rows[0].stripe_customer_id);

        return methods.data.map(pm => ({
            id: pm.id,
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
            isDefault: pm.id === customer.invoice_settings?.default_payment_method
        }));
    }

    async createSetupIntent(organizationId) {
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        let customerId = org.rows[0]?.stripe_customer_id;
        
        if (!customerId) {
            throw new BillingError('No customer found', 'CUSTOMER_NOT_FOUND');
        }

        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            payment_method_types: ['card'],
            metadata: { organizationId }
        });

        return { clientSecret: setupIntent.client_secret };
    }

    async setDefaultPaymentMethod(organizationId, paymentMethodId) {
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        if (!org.rows[0]?.stripe_customer_id) {
            throw new BillingError('No customer found', 'CUSTOMER_NOT_FOUND');
        }

        await stripe.customers.update(org.rows[0].stripe_customer_id, {
            invoice_settings: { default_payment_method: paymentMethodId }
        });

        return { success: true };
    }

    async removePaymentMethod(organizationId, paymentMethodId) {
        // Verify ownership
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        if (pm.customer !== org.rows[0]?.stripe_customer_id) {
            throw new BillingError('Payment method not found', 'PM_NOT_FOUND');
        }

        await stripe.paymentMethods.detach(paymentMethodId);

        return { success: true };
    }

    // ----------------------------------------
    // INVOICES
    // ----------------------------------------

    async getInvoices(organizationId, options = {}) {
        const result = await pool.query(`
            SELECT * FROM invoices 
            WHERE organization_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [organizationId, options.limit || 10, options.offset || 0]);

        return result.rows.map(inv => ({
            id: inv.id,
            number: inv.number,
            status: inv.status,
            total: inv.total,
            currency: inv.currency,
            dueDate: inv.due_date,
            paidAt: inv.paid_at,
            pdfUrl: inv.pdf_url,
            hostedUrl: inv.hosted_invoice_url,
            periodStart: inv.period_start,
            periodEnd: inv.period_end,
            createdAt: inv.created_at
        }));
    }

    async getUpcomingInvoice(organizationId) {
        const subscription = await this.getSubscription(organizationId);
        
        if (!subscription?.stripeSubscriptionId) {
            return null;
        }

        try {
            const invoice = await stripe.invoices.retrieveUpcoming({
                subscription: subscription.stripeSubscriptionId
            });

            return {
                total: invoice.total / 100,
                subtotal: invoice.subtotal / 100,
                tax: invoice.tax / 100,
                currency: invoice.currency.toUpperCase(),
                periodStart: new Date(invoice.period_start * 1000),
                periodEnd: new Date(invoice.period_end * 1000),
                lines: invoice.lines.data.map(line => ({
                    description: line.description,
                    amount: line.amount / 100,
                    quantity: line.quantity
                }))
            };
        } catch (error) {
            return null;
        }
    }

    async downloadInvoice(invoiceId, organizationId) {
        const result = await pool.query(
            'SELECT stripe_invoice_id, pdf_url FROM invoices WHERE id = $1 AND organization_id = $2',
            [invoiceId, organizationId]
        );

        if (!result.rows[0]) {
            throw new BillingError('Invoice not found', 'INVOICE_NOT_FOUND');
        }

        if (result.rows[0].pdf_url) {
            return { url: result.rows[0].pdf_url };
        }

        const invoice = await stripe.invoices.retrieve(result.rows[0].stripe_invoice_id);
        return { url: invoice.invoice_pdf };
    }

    // ----------------------------------------
    // USAGE TRACKING
    // ----------------------------------------

    async trackUsage(organizationId, metric, quantity = 1) {
        const today = new Date();
        const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

        await pool.query(`
            INSERT INTO usage_records (organization_id, metric, quantity, period_start, period_end)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (organization_id, metric, period_start) 
            DO UPDATE SET quantity = usage_records.quantity + $3
        `, [organizationId, metric, quantity, periodStart, periodEnd]);

        // Update Redis counter for real-time limits
        const redisKey = `usage:${organizationId}:${metric}:${periodStart.toISOString().substring(0, 7)}`;
        await redis.incrby(redisKey, quantity);
        await redis.expire(redisKey, 45 * 24 * 60 * 60); // 45 days

        return true;
    }

    async getUsage(organizationId, period = 'current') {
        let periodStart, periodEnd;
        const today = new Date();

        if (period === 'current') {
            periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
            periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        } else {
            // Parse YYYY-MM format
            const [year, month] = period.split('-').map(Number);
            periodStart = new Date(year, month - 1, 1);
            periodEnd = new Date(year, month, 0);
        }

        const result = await pool.query(`
            SELECT metric, SUM(quantity) as total
            FROM usage_records
            WHERE organization_id = $1 AND period_start >= $2 AND period_end <= $3
            GROUP BY metric
        `, [organizationId, periodStart, periodEnd]);

        const subscription = await this.getSubscription(organizationId);
        const plan = config.plans[subscription?.plan || 'trial'];
        const limits = plan.limits;

        const usage = {};
        for (const row of result.rows) {
            const limit = limits[row.metric] || -1;
            usage[row.metric] = {
                used: parseInt(row.total),
                limit: limit,
                percentage: limit > 0 ? Math.round((parseInt(row.total) / limit) * 100) : 0,
                unlimited: limit === -1
            };
        }

        // Add missing metrics with 0 usage
        for (const [metric, limit] of Object.entries(limits)) {
            if (!usage[metric]) {
                usage[metric] = {
                    used: 0,
                    limit: limit,
                    percentage: 0,
                    unlimited: limit === -1
                };
            }
        }

        return {
            periodStart,
            periodEnd,
            plan: subscription?.plan || 'trial',
            usage
        };
    }

    async checkLimit(organizationId, metric, quantity = 1) {
        const subscription = await this.getSubscription(organizationId);
        const plan = config.plans[subscription?.plan || 'trial'];
        const limit = plan.limits[metric];

        if (limit === -1) {
            return { allowed: true, unlimited: true };
        }

        // Quick check from Redis
        const today = new Date();
        const periodKey = today.toISOString().substring(0, 7);
        const redisKey = `usage:${organizationId}:${metric}:${periodKey}`;
        const current = parseInt(await redis.get(redisKey) || '0');

        if (current + quantity > limit) {
            return {
                allowed: false,
                current,
                limit,
                overage: current + quantity - limit
            };
        }

        return { allowed: true, current, limit, remaining: limit - current - quantity };
    }

    // ----------------------------------------
    // METERED BILLING
    // ----------------------------------------

    async reportMeteredUsage(organizationId, quantity, metric = 'shipments') {
        const subscription = await this.getSubscription(organizationId);
        
        if (!subscription?.stripeSubscriptionId) {
            return;
        }

        // Get the metered subscription item
        const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
        const meteredItem = stripeSub.items.data.find(item => 
            item.price.recurring?.usage_type === 'metered'
        );

        if (!meteredItem) {
            return;
        }

        // Create usage record in Stripe
        await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
            quantity,
            timestamp: Math.floor(Date.now() / 1000),
            action: 'increment'
        });
    }

    // ----------------------------------------
    // PROMO CODES
    // ----------------------------------------

    async validatePromoCode(code) {
        try {
            const promotionCodes = await stripe.promotionCodes.list({
                code,
                active: true
            });

            if (promotionCodes.data.length === 0) {
                return { valid: false, message: 'Invalid promo code' };
            }

            const promo = promotionCodes.data[0];
            const coupon = promo.coupon;

            return {
                valid: true,
                code: promo.code,
                discount: coupon.percent_off 
                    ? `${coupon.percent_off}% off` 
                    : `${coupon.amount_off / 100} ${coupon.currency.toUpperCase()} off`,
                duration: coupon.duration,
                durationInMonths: coupon.duration_in_months
            };
        } catch (error) {
            return { valid: false, message: 'Invalid promo code' };
        }
    }

    // ----------------------------------------
    // WEBHOOK HANDLING
    // ----------------------------------------

    async handleWebhook(payload, signature) {
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                payload,
                signature,
                config.stripe.webhookSecret
            );
        } catch (error) {
            throw new BillingError('Invalid webhook signature', 'INVALID_SIGNATURE');
        }

        console.log(`[Billing] Webhook received: ${event.type}`);

        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await this.handleSubscriptionUpdate(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await this.handleSubscriptionDeleted(event.data.object);
                break;

            case 'invoice.paid':
                await this.handleInvoicePaid(event.data.object);
                break;

            case 'invoice.payment_failed':
                await this.handlePaymentFailed(event.data.object);
                break;

            case 'invoice.finalized':
                await this.handleInvoiceFinalized(event.data.object);
                break;

            case 'customer.updated':
                await this.handleCustomerUpdated(event.data.object);
                break;

            default:
                console.log(`[Billing] Unhandled event type: ${event.type}`);
        }

        return { received: true };
    }

    async handleSubscriptionUpdate(subscription) {
        const orgId = subscription.metadata?.organizationId;
        if (!orgId) return;

        await pool.query(`
            UPDATE subscriptions SET
                status = $1,
                current_period_start = $2,
                current_period_end = $3,
                cancel_at_period_end = $4,
                updated_at = NOW()
            WHERE stripe_subscription_id = $5
        `, [
            subscription.status,
            new Date(subscription.current_period_start * 1000),
            new Date(subscription.current_period_end * 1000),
            subscription.cancel_at_period_end,
            subscription.id
        ]);

        // Update org plan based on status
        if (subscription.status === 'active') {
            await pool.query(
                'UPDATE organizations SET plan = $1 WHERE id = $2',
                [subscription.metadata.planId || 'starter', orgId]
            );
        }

        this.emit('subscription.updated', { organizationId: orgId, status: subscription.status });
    }

    async handleSubscriptionDeleted(subscription) {
        const orgId = subscription.metadata?.organizationId;
        if (!orgId) return;

        await pool.query(`
            UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() 
            WHERE stripe_subscription_id = $1
        `, [subscription.id]);

        await pool.query(
            'UPDATE organizations SET plan = $1 WHERE id = $2',
            ['trial', orgId]
        );

        this.emit('subscription.deleted', { organizationId: orgId });
    }

    async handleInvoicePaid(invoice) {
        await pool.query(`
            INSERT INTO invoices (
                organization_id, stripe_invoice_id, number, status,
                subtotal, tax, total, currency, period_start, period_end,
                pdf_url, hosted_invoice_url, paid_at
            ) VALUES (
                (SELECT id FROM organizations WHERE stripe_customer_id = $1),
                $2, $3, 'paid', $4, $5, $6, $7, $8, $9, $10, $11, NOW()
            )
            ON CONFLICT (stripe_invoice_id) DO UPDATE SET
                status = 'paid', paid_at = NOW()
        `, [
            invoice.customer,
            invoice.id,
            invoice.number,
            invoice.subtotal / 100,
            invoice.tax / 100,
            invoice.total / 100,
            invoice.currency.toUpperCase(),
            new Date(invoice.period_start * 1000),
            new Date(invoice.period_end * 1000),
            invoice.invoice_pdf,
            invoice.hosted_invoice_url
        ]);

        this.emit('invoice.paid', { invoiceId: invoice.id });
    }

    async handlePaymentFailed(invoice) {
        const orgResult = await pool.query(
            'SELECT id FROM organizations WHERE stripe_customer_id = $1',
            [invoice.customer]
        );

        if (orgResult.rows[0]) {
            await pool.query(`
                UPDATE subscriptions SET status = 'past_due' 
                WHERE organization_id = $1
            `, [orgResult.rows[0].id]);

            this.emit('payment.failed', { organizationId: orgResult.rows[0].id, invoiceId: invoice.id });
        }
    }

    async handleInvoiceFinalized(invoice) {
        await pool.query(`
            INSERT INTO invoices (
                organization_id, stripe_invoice_id, number, status,
                subtotal, tax, total, currency, due_date, period_start, period_end,
                pdf_url, hosted_invoice_url, lines
            ) VALUES (
                (SELECT id FROM organizations WHERE stripe_customer_id = $1),
                $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            )
            ON CONFLICT (stripe_invoice_id) DO NOTHING
        `, [
            invoice.customer,
            invoice.id,
            invoice.number,
            invoice.status,
            invoice.subtotal / 100,
            invoice.tax / 100,
            invoice.total / 100,
            invoice.currency.toUpperCase(),
            invoice.due_date ? new Date(invoice.due_date * 1000) : null,
            new Date(invoice.period_start * 1000),
            new Date(invoice.period_end * 1000),
            invoice.invoice_pdf,
            invoice.hosted_invoice_url,
            JSON.stringify(invoice.lines.data)
        ]);
    }

    async handleCustomerUpdated(customer) {
        const orgResult = await pool.query(
            'SELECT id FROM organizations WHERE stripe_customer_id = $1',
            [customer.id]
        );

        if (orgResult.rows[0] && customer.email) {
            await pool.query(
                'UPDATE organizations SET billing_email = $1 WHERE id = $2',
                [customer.email, orgResult.rows[0].id]
            );
        }
    }

    // ----------------------------------------
    // PORTAL SESSION
    // ----------------------------------------

    async createPortalSession(organizationId, returnUrl) {
        const org = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [organizationId]);
        
        if (!org.rows[0]?.stripe_customer_id) {
            throw new BillingError('No customer found', 'CUSTOMER_NOT_FOUND');
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: org.rows[0].stripe_customer_id,
            return_url: returnUrl
        });

        return { url: session.url };
    }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

const billingService = new BillingService();

// ============================================
// EXPORTS
// ============================================

module.exports = {
    BillingService,
    billingService,
    BillingError,
    config,
    stripe
};
