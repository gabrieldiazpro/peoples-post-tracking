/**
 * ROUTZ - Database Migration System
 * Versioned migrations with up/down support
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================

const config = {
    migrationsDir: path.join(__dirname, 'migrations'),
    tableName: 'schema_migrations',
    lockTimeout: 30000 // 30 seconds
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5
});

// ============================================
// MIGRATION MANAGER
// ============================================

class MigrationManager {
    constructor() {
        this.migrations = [];
    }

    async initialize() {
        // Create migrations table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ${config.tableName} (
                id SERIAL PRIMARY KEY,
                version VARCHAR(255) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                checksum VARCHAR(64) NOT NULL,
                executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                execution_time_ms INTEGER
            )
        `);

        // Create migration lock table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migration_lock (
                id INTEGER PRIMARY KEY DEFAULT 1,
                locked_at TIMESTAMP WITH TIME ZONE,
                locked_by VARCHAR(255),
                CONSTRAINT single_row CHECK (id = 1)
            )
        `);

        await pool.query(`
            INSERT INTO schema_migration_lock (id) VALUES (1)
            ON CONFLICT (id) DO NOTHING
        `);
    }

    async acquireLock() {
        const lockId = `${process.env.HOSTNAME || 'local'}-${process.pid}`;
        
        const result = await pool.query(`
            UPDATE schema_migration_lock
            SET locked_at = NOW(), locked_by = $1
            WHERE locked_at IS NULL OR locked_at < NOW() - INTERVAL '${config.lockTimeout} milliseconds'
            RETURNING *
        `, [lockId]);

        if (result.rows.length === 0) {
            throw new Error('Could not acquire migration lock. Another migration is in progress.');
        }

        return lockId;
    }

    async releaseLock() {
        await pool.query(`
            UPDATE schema_migration_lock
            SET locked_at = NULL, locked_by = NULL
        `);
    }

    async getAppliedMigrations() {
        const result = await pool.query(`
            SELECT version, name, checksum, executed_at
            FROM ${config.tableName}
            ORDER BY version ASC
        `);
        return result.rows;
    }

    async getPendingMigrations() {
        const applied = await this.getAppliedMigrations();
        const appliedVersions = new Set(applied.map(m => m.version));

        return this.migrations
            .filter(m => !appliedVersions.has(m.version))
            .sort((a, b) => a.version.localeCompare(b.version));
    }

    registerMigration(migration) {
        this.migrations.push(migration);
    }

    async runMigration(migration, direction = 'up') {
        const client = await pool.connect();
        const startTime = Date.now();

        try {
            await client.query('BEGIN');

            if (direction === 'up') {
                await migration.up(client);
                
                const checksum = this.calculateChecksum(migration);
                await client.query(`
                    INSERT INTO ${config.tableName} (version, name, checksum, execution_time_ms)
                    VALUES ($1, $2, $3, $4)
                `, [migration.version, migration.name, checksum, Date.now() - startTime]);
            } else {
                await migration.down(client);
                
                await client.query(`
                    DELETE FROM ${config.tableName} WHERE version = $1
                `, [migration.version]);
            }

            await client.query('COMMIT');
            
            console.log(`✓ ${direction === 'up' ? 'Applied' : 'Reverted'}: ${migration.version} - ${migration.name} (${Date.now() - startTime}ms)`);
            
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`✗ Failed: ${migration.version} - ${migration.name}`);
            console.error(error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async migrateUp(targetVersion = null) {
        await this.initialize();
        const lockId = await this.acquireLock();

        try {
            let pending = await this.getPendingMigrations();
            
            if (targetVersion) {
                pending = pending.filter(m => m.version <= targetVersion);
            }

            if (pending.length === 0) {
                console.log('No pending migrations');
                return [];
            }

            console.log(`Running ${pending.length} migration(s)...`);

            const results = [];
            for (const migration of pending) {
                await this.runMigration(migration, 'up');
                results.push(migration.version);
            }

            return results;
        } finally {
            await this.releaseLock();
        }
    }

    async migrateDown(steps = 1) {
        await this.initialize();
        const lockId = await this.acquireLock();

        try {
            const applied = await this.getAppliedMigrations();
            const toRevert = applied.slice(-steps).reverse();

            if (toRevert.length === 0) {
                console.log('No migrations to revert');
                return [];
            }

            console.log(`Reverting ${toRevert.length} migration(s)...`);

            const results = [];
            for (const appliedMigration of toRevert) {
                const migration = this.migrations.find(m => m.version === appliedMigration.version);
                if (!migration) {
                    throw new Error(`Migration ${appliedMigration.version} not found in registered migrations`);
                }
                await this.runMigration(migration, 'down');
                results.push(migration.version);
            }

            return results;
        } finally {
            await this.releaseLock();
        }
    }

    async status() {
        await this.initialize();
        
        const applied = await this.getAppliedMigrations();
        const pending = await this.getPendingMigrations();

        return {
            applied: applied.map(m => ({
                version: m.version,
                name: m.name,
                executedAt: m.executed_at
            })),
            pending: pending.map(m => ({
                version: m.version,
                name: m.name
            }))
        };
    }

    calculateChecksum(migration) {
        const content = migration.up.toString() + migration.down.toString();
        return crypto.createHash('sha256').update(content).digest('hex');
    }
}

const migrationManager = new MigrationManager();

// ============================================
// MIGRATION DEFINITIONS
// ============================================

// Migration 001: Initial Schema
migrationManager.registerMigration({
    version: '001',
    name: 'initial_schema',
    
    async up(client) {
        // Organizations
        await client.query(`
            CREATE TABLE organizations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(100) NOT NULL UNIQUE,
                plan VARCHAR(50) DEFAULT 'trial',
                settings JSONB DEFAULT '{}',
                billing_email VARCHAR(255),
                stripe_customer_id VARCHAR(255),
                trial_ends_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                deleted_at TIMESTAMP WITH TIME ZONE
            )
        `);

        await client.query('CREATE INDEX idx_organizations_slug ON organizations(slug)');
        await client.query('CREATE INDEX idx_organizations_stripe ON organizations(stripe_customer_id)');

        // Users
        await client.query(`
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                email VARCHAR(255) NOT NULL,
                password_hash VARCHAR(255),
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                role VARCHAR(50) NOT NULL DEFAULT 'viewer',
                custom_permissions TEXT[],
                email_verified_at TIMESTAMP WITH TIME ZONE,
                email_verification_token VARCHAR(255),
                password_reset_token VARCHAR(255),
                password_reset_expires TIMESTAMP WITH TIME ZONE,
                password_changed_at TIMESTAMP WITH TIME ZONE,
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret VARCHAR(255),
                oauth_provider VARCHAR(50),
                oauth_provider_id VARCHAR(255),
                failed_login_attempts INTEGER DEFAULT 0,
                locked_until TIMESTAMP WITH TIME ZONE,
                last_login_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                deleted_at TIMESTAMP WITH TIME ZONE,
                UNIQUE(email)
            )
        `);

        await client.query('CREATE INDEX idx_users_email ON users(email)');
        await client.query('CREATE INDEX idx_users_org ON users(organization_id)');
        await client.query('CREATE INDEX idx_users_oauth ON users(oauth_provider, oauth_provider_id)');

        // User Sessions
        await client.query(`
            CREATE TABLE user_sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                ip_address INET,
                user_agent TEXT,
                device_info JSONB,
                location VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                revoked_at TIMESTAMP WITH TIME ZONE
            )
        `);

        await client.query('CREATE INDEX idx_sessions_user ON user_sessions(user_id)');
        await client.query('CREATE INDEX idx_sessions_expires ON user_sessions(expires_at)');

        // MFA Backup Codes
        await client.query(`
            CREATE TABLE user_mfa_backup_codes (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                code_hash VARCHAR(255) NOT NULL,
                used_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_mfa_codes_user ON user_mfa_backup_codes(user_id)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS user_mfa_backup_codes CASCADE');
        await client.query('DROP TABLE IF EXISTS user_sessions CASCADE');
        await client.query('DROP TABLE IF EXISTS users CASCADE');
        await client.query('DROP TABLE IF EXISTS organizations CASCADE');
    }
});

// Migration 002: Shipments
migrationManager.registerMigration({
    version: '002',
    name: 'shipments',
    
    async up(client) {
        await client.query(`
            CREATE TABLE shipments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                order_id UUID,
                tracking_number VARCHAR(100),
                carrier VARCHAR(50) NOT NULL,
                service VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                status_description TEXT,
                
                -- Sender
                sender_name VARCHAR(255),
                sender_company VARCHAR(255),
                sender_address1 VARCHAR(255),
                sender_address2 VARCHAR(255),
                sender_city VARCHAR(100),
                sender_postal_code VARCHAR(20),
                sender_country VARCHAR(2),
                sender_phone VARCHAR(50),
                sender_email VARCHAR(255),
                
                -- Recipient
                recipient_name VARCHAR(255),
                recipient_company VARCHAR(255),
                recipient_address1 VARCHAR(255),
                recipient_address2 VARCHAR(255),
                recipient_city VARCHAR(100),
                recipient_postal_code VARCHAR(20),
                recipient_country VARCHAR(2),
                recipient_phone VARCHAR(50),
                recipient_email VARCHAR(255),
                
                -- Parcel details
                weight DECIMAL(10,3),
                length DECIMAL(10,2),
                width DECIMAL(10,2),
                height DECIMAL(10,2),
                
                -- Costs
                shipping_cost DECIMAL(10,2),
                insurance_value DECIMAL(10,2),
                cod_amount DECIMAL(10,2),
                
                -- References
                reference VARCHAR(255),
                order_number VARCHAR(255),
                
                -- Label
                label_data TEXT,
                label_url VARCHAR(500),
                label_format VARCHAR(50),
                
                -- Pickup
                pickup_point_id VARCHAR(100),
                
                -- Tracking
                last_tracking_update TIMESTAMP WITH TIME ZONE,
                estimated_delivery DATE,
                delivered_at TIMESTAMP WITH TIME ZONE,
                
                -- Customs
                customs_data JSONB,
                
                -- Carrier response
                carrier_response JSONB,
                error_message TEXT,
                
                -- Metadata
                metadata JSONB DEFAULT '{}',
                created_by UUID REFERENCES users(id),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                cancelled_at TIMESTAMP WITH TIME ZONE
            )
        `);

        await client.query('CREATE INDEX idx_shipments_org ON shipments(organization_id)');
        await client.query('CREATE INDEX idx_shipments_tracking ON shipments(tracking_number)');
        await client.query('CREATE INDEX idx_shipments_status ON shipments(status)');
        await client.query('CREATE INDEX idx_shipments_carrier ON shipments(carrier)');
        await client.query('CREATE INDEX idx_shipments_created ON shipments(created_at DESC)');
        await client.query('CREATE INDEX idx_shipments_order ON shipments(order_id)');

        // Shipment Events
        await client.query(`
            CREATE TABLE shipment_events (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
                event_code VARCHAR(50),
                description TEXT,
                location VARCHAR(255),
                postal_code VARCHAR(20),
                timestamp TIMESTAMP WITH TIME ZONE,
                raw_data JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(shipment_id, event_code, timestamp)
            )
        `);

        await client.query('CREATE INDEX idx_events_shipment ON shipment_events(shipment_id)');
        await client.query('CREATE INDEX idx_events_timestamp ON shipment_events(timestamp DESC)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS shipment_events CASCADE');
        await client.query('DROP TABLE IF EXISTS shipments CASCADE');
    }
});

// Migration 003: Orders
migrationManager.registerMigration({
    version: '003',
    name: 'orders',
    
    async up(client) {
        await client.query(`
            CREATE TABLE orders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                order_number VARCHAR(100) NOT NULL,
                external_id VARCHAR(255),
                source VARCHAR(50),
                source_url VARCHAR(500),
                status VARCHAR(50) DEFAULT 'pending',
                
                -- Customer
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                customer_phone VARCHAR(50),
                
                -- Shipping Address
                shipping_name VARCHAR(255),
                shipping_company VARCHAR(255),
                shipping_address1 VARCHAR(255),
                shipping_address2 VARCHAR(255),
                shipping_city VARCHAR(100),
                shipping_postal_code VARCHAR(20),
                shipping_country VARCHAR(2),
                shipping_phone VARCHAR(50),
                
                -- Billing Address
                billing_name VARCHAR(255),
                billing_address1 VARCHAR(255),
                billing_city VARCHAR(100),
                billing_postal_code VARCHAR(20),
                billing_country VARCHAR(2),
                
                -- Financials
                subtotal DECIMAL(10,2),
                shipping_total DECIMAL(10,2),
                tax_total DECIMAL(10,2),
                discount_total DECIMAL(10,2),
                total DECIMAL(10,2),
                currency VARCHAR(3) DEFAULT 'EUR',
                
                -- Items
                items JSONB DEFAULT '[]',
                
                -- Metadata
                notes TEXT,
                tags TEXT[],
                metadata JSONB DEFAULT '{}',
                
                -- Timestamps
                order_date TIMESTAMP WITH TIME ZONE,
                paid_at TIMESTAMP WITH TIME ZONE,
                shipped_at TIMESTAMP WITH TIME ZONE,
                delivered_at TIMESTAMP WITH TIME ZONE,
                cancelled_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                
                UNIQUE(organization_id, order_number)
            )
        `);

        await client.query('CREATE INDEX idx_orders_org ON orders(organization_id)');
        await client.query('CREATE INDEX idx_orders_number ON orders(order_number)');
        await client.query('CREATE INDEX idx_orders_status ON orders(status)');
        await client.query('CREATE INDEX idx_orders_source ON orders(source)');
        await client.query('CREATE INDEX idx_orders_created ON orders(created_at DESC)');
        await client.query('CREATE INDEX idx_orders_customer ON orders(customer_email)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS orders CASCADE');
    }
});

// Migration 004: Returns
migrationManager.registerMigration({
    version: '004',
    name: 'returns',
    
    async up(client) {
        await client.query(`
            CREATE TABLE returns (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                order_id UUID REFERENCES orders(id),
                shipment_id UUID REFERENCES shipments(id),
                return_number VARCHAR(100) NOT NULL,
                status VARCHAR(50) DEFAULT 'requested',
                reason VARCHAR(100),
                reason_details TEXT,
                
                -- Customer
                customer_name VARCHAR(255),
                customer_email VARCHAR(255),
                
                -- Return shipment
                return_tracking_number VARCHAR(100),
                return_carrier VARCHAR(50),
                return_label_data TEXT,
                return_label_url VARCHAR(500),
                
                -- Items
                items JSONB DEFAULT '[]',
                
                -- Refund
                refund_amount DECIMAL(10,2),
                refund_status VARCHAR(50),
                refund_processed_at TIMESTAMP WITH TIME ZONE,
                
                -- Processing
                received_at TIMESTAMP WITH TIME ZONE,
                inspected_at TIMESTAMP WITH TIME ZONE,
                inspection_notes TEXT,
                
                -- Metadata
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                
                UNIQUE(organization_id, return_number)
            )
        `);

        await client.query('CREATE INDEX idx_returns_org ON returns(organization_id)');
        await client.query('CREATE INDEX idx_returns_order ON returns(order_id)');
        await client.query('CREATE INDEX idx_returns_status ON returns(status)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS returns CASCADE');
    }
});

// Migration 005: API Keys & Webhooks
migrationManager.registerMigration({
    version: '005',
    name: 'api_keys_webhooks',
    
    async up(client) {
        // API Keys
        await client.query(`
            CREATE TABLE api_keys (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                user_id UUID NOT NULL REFERENCES users(id),
                name VARCHAR(100) NOT NULL,
                key_hash VARCHAR(255) NOT NULL UNIQUE,
                key_prefix VARCHAR(20),
                permissions TEXT[],
                rate_limit INTEGER DEFAULT 1000,
                last_used_at TIMESTAMP WITH TIME ZONE,
                expires_at TIMESTAMP WITH TIME ZONE,
                revoked_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_api_keys_hash ON api_keys(key_hash)');
        await client.query('CREATE INDEX idx_api_keys_org ON api_keys(organization_id)');

        // Webhooks
        await client.query(`
            CREATE TABLE webhooks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                url VARCHAR(500) NOT NULL,
                secret VARCHAR(255) NOT NULL,
                events TEXT[] NOT NULL,
                enabled BOOLEAN DEFAULT TRUE,
                consecutive_failures INTEGER DEFAULT 0,
                disabled_at TIMESTAMP WITH TIME ZONE,
                last_triggered_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_webhooks_org ON webhooks(organization_id)');
        await client.query('CREATE INDEX idx_webhooks_enabled ON webhooks(enabled)');

        // Webhook Deliveries
        await client.query(`
            CREATE TABLE webhook_deliveries (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
                event VARCHAR(100),
                status_code INTEGER,
                response_body TEXT,
                error TEXT,
                attempted_at TIMESTAMP WITH TIME ZONE,
                delivered_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_webhook_deliveries ON webhook_deliveries(webhook_id)');
        await client.query('CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS webhook_deliveries CASCADE');
        await client.query('DROP TABLE IF EXISTS webhooks CASCADE');
        await client.query('DROP TABLE IF EXISTS api_keys CASCADE');
    }
});

// Migration 006: Audit Logs
migrationManager.registerMigration({
    version: '006',
    name: 'audit_logs',
    
    async up(client) {
        await client.query(`
            CREATE TABLE audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID REFERENCES organizations(id),
                user_id UUID REFERENCES users(id),
                event_type VARCHAR(100) NOT NULL,
                resource_type VARCHAR(100),
                resource_id VARCHAR(255),
                action VARCHAR(100),
                status VARCHAR(50),
                ip_address INET,
                user_agent TEXT,
                metadata JSONB DEFAULT '{}',
                changes JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_audit_org ON audit_logs(organization_id)');
        await client.query('CREATE INDEX idx_audit_user ON audit_logs(user_id)');
        await client.query('CREATE INDEX idx_audit_event ON audit_logs(event_type)');
        await client.query('CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id)');
        await client.query('CREATE INDEX idx_audit_created ON audit_logs(created_at DESC)');

        // Partitioning for large tables (monthly)
        await client.query(`
            CREATE INDEX idx_audit_created_month ON audit_logs(DATE_TRUNC('month', created_at))
        `);
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS audit_logs CASCADE');
    }
});

// Migration 007: Carriers & Integrations
migrationManager.registerMigration({
    version: '007',
    name: 'carriers_integrations',
    
    async up(client) {
        // Carrier Configurations
        await client.query(`
            CREATE TABLE carrier_configs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                carrier VARCHAR(50) NOT NULL,
                enabled BOOLEAN DEFAULT TRUE,
                credentials JSONB NOT NULL DEFAULT '{}',
                settings JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(organization_id, carrier)
            )
        `);

        await client.query('CREATE INDEX idx_carrier_configs_org ON carrier_configs(organization_id)');

        // E-commerce Integrations
        await client.query(`
            CREATE TABLE integrations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                type VARCHAR(50) NOT NULL,
                name VARCHAR(100),
                platform VARCHAR(50),
                store_url VARCHAR(500),
                credentials JSONB DEFAULT '{}',
                settings JSONB DEFAULT '{}',
                last_sync_at TIMESTAMP WITH TIME ZONE,
                sync_status VARCHAR(50),
                enabled BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_integrations_org ON integrations(organization_id)');
        await client.query('CREATE INDEX idx_integrations_type ON integrations(type)');

        // SSO Configurations
        await client.query(`
            CREATE TABLE organization_sso (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                provider VARCHAR(50) NOT NULL,
                config JSONB NOT NULL,
                enabled BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(organization_id, provider)
            )
        `);

        await client.query('CREATE INDEX idx_org_sso ON organization_sso(organization_id)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS organization_sso CASCADE');
        await client.query('DROP TABLE IF EXISTS integrations CASCADE');
        await client.query('DROP TABLE IF EXISTS carrier_configs CASCADE');
    }
});

// Migration 008: Billing
migrationManager.registerMigration({
    version: '008',
    name: 'billing',
    
    async up(client) {
        // Subscriptions
        await client.query(`
            CREATE TABLE subscriptions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                stripe_subscription_id VARCHAR(255) UNIQUE,
                plan VARCHAR(50) NOT NULL,
                status VARCHAR(50) NOT NULL,
                current_period_start TIMESTAMP WITH TIME ZONE,
                current_period_end TIMESTAMP WITH TIME ZONE,
                cancel_at_period_end BOOLEAN DEFAULT FALSE,
                cancelled_at TIMESTAMP WITH TIME ZONE,
                trial_start TIMESTAMP WITH TIME ZONE,
                trial_end TIMESTAMP WITH TIME ZONE,
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id)');
        await client.query('CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id)');

        // Invoices
        await client.query(`
            CREATE TABLE invoices (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                stripe_invoice_id VARCHAR(255) UNIQUE,
                number VARCHAR(50),
                status VARCHAR(50),
                subtotal DECIMAL(10,2),
                tax DECIMAL(10,2),
                total DECIMAL(10,2),
                currency VARCHAR(3) DEFAULT 'EUR',
                due_date DATE,
                paid_at TIMESTAMP WITH TIME ZONE,
                pdf_url VARCHAR(500),
                hosted_invoice_url VARCHAR(500),
                period_start TIMESTAMP WITH TIME ZONE,
                period_end TIMESTAMP WITH TIME ZONE,
                lines JSONB DEFAULT '[]',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_invoices_org ON invoices(organization_id)');
        await client.query('CREATE INDEX idx_invoices_stripe ON invoices(stripe_invoice_id)');

        // Usage Records
        await client.query(`
            CREATE TABLE usage_records (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                metric VARCHAR(50) NOT NULL,
                quantity INTEGER NOT NULL,
                period_start DATE NOT NULL,
                period_end DATE NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(organization_id, metric, period_start)
            )
        `);

        await client.query('CREATE INDEX idx_usage_org ON usage_records(organization_id)');
        await client.query('CREATE INDEX idx_usage_period ON usage_records(period_start, period_end)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS usage_records CASCADE');
        await client.query('DROP TABLE IF EXISTS invoices CASCADE');
        await client.query('DROP TABLE IF EXISTS subscriptions CASCADE');
    }
});

// Migration 009: Notifications
migrationManager.registerMigration({
    version: '009',
    name: 'notifications',
    
    async up(client) {
        // Notification Preferences
        await client.query(`
            CREATE TABLE notification_preferences (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id),
                organization_id UUID REFERENCES organizations(id),
                email_enabled BOOLEAN DEFAULT TRUE,
                push_enabled BOOLEAN DEFAULT FALSE,
                slack_enabled BOOLEAN DEFAULT FALSE,
                slack_webhook_url VARCHAR(500),
                events JSONB DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_notif_prefs_user ON notification_preferences(user_id)');
        await client.query('CREATE INDEX idx_notif_prefs_org ON notification_preferences(organization_id)');

        -- Notifications
        await client.query(`
            CREATE TABLE notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id),
                organization_id UUID REFERENCES organizations(id),
                type VARCHAR(100) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body TEXT,
                data JSONB DEFAULT '{}',
                read_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                deleted_at TIMESTAMP WITH TIME ZONE
            )
        `);

        await client.query('CREATE INDEX idx_notifications_user ON notifications(user_id)');
        await client.query('CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at) WHERE read_at IS NULL');

        -- Email Logs
        await client.query(`
            CREATE TABLE email_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                recipient VARCHAR(255) NOT NULL,
                template VARCHAR(100),
                subject VARCHAR(255),
                message_id VARCHAR(255),
                status VARCHAR(50),
                error TEXT,
                sent_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_email_logs_recipient ON email_logs(recipient)');
        await client.query('CREATE INDEX idx_email_logs_created ON email_logs(created_at DESC)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS email_logs CASCADE');
        await client.query('DROP TABLE IF EXISTS notifications CASCADE');
        await client.query('DROP TABLE IF EXISTS notification_preferences CASCADE');
    }
});

// Migration 010: Invitations & Reports
migrationManager.registerMigration({
    version: '010',
    name: 'invitations_reports',
    
    async up(client) {
        // Invitations
        await client.query(`
            CREATE TABLE invitations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                email VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                token VARCHAR(255) NOT NULL UNIQUE,
                invited_by UUID REFERENCES users(id),
                expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                used_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_invitations_token ON invitations(token)');
        await client.query('CREATE INDEX idx_invitations_org ON invitations(organization_id)');

        -- Reports
        await client.query(`
            CREATE TABLE reports (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                user_id UUID REFERENCES users(id),
                type VARCHAR(50) NOT NULL,
                filename VARCHAR(255),
                mime_type VARCHAR(100),
                file_url VARCHAR(500),
                params JSONB DEFAULT '{}',
                status VARCHAR(50) DEFAULT 'pending',
                error TEXT,
                generated_at TIMESTAMP WITH TIME ZONE,
                expires_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        await client.query('CREATE INDEX idx_reports_org ON reports(organization_id)');
        await client.query('CREATE INDEX idx_reports_user ON reports(user_id)');
    },

    async down(client) {
        await client.query('DROP TABLE IF EXISTS reports CASCADE');
        await client.query('DROP TABLE IF EXISTS invitations CASCADE');
    }
});

// ============================================
// CLI COMMANDS
// ============================================

async function runCLI() {
    const command = process.argv[2];
    const arg = process.argv[3];

    try {
        switch (command) {
            case 'up':
                await migrationManager.migrateUp(arg);
                break;
            case 'down':
                await migrationManager.migrateDown(parseInt(arg) || 1);
                break;
            case 'status':
                const status = await migrationManager.status();
                console.log('\nApplied migrations:');
                status.applied.forEach(m => console.log(`  ✓ ${m.version} - ${m.name} (${m.executedAt})`));
                console.log('\nPending migrations:');
                status.pending.forEach(m => console.log(`  ○ ${m.version} - ${m.name}`));
                break;
            case 'reset':
                console.log('WARNING: This will drop all tables!');
                const applied = await migrationManager.getAppliedMigrations();
                await migrationManager.migrateDown(applied.length);
                break;
            default:
                console.log(`
Usage: node migrations.js <command> [args]

Commands:
  up [version]     Run pending migrations (optionally up to specific version)
  down [steps]     Revert migrations (default: 1 step)
  status          Show migration status
  reset           Revert all migrations (dangerous!)
                `);
        }
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run CLI if executed directly
if (require.main === module) {
    runCLI();
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    migrationManager,
    pool
};
