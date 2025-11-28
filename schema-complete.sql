-- ==========================================
-- ROUTZ - Complete Database Schema
-- PostgreSQL 14+
-- ==========================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable PostGIS for geospatial queries (optional but recommended)
-- CREATE EXTENSION IF NOT EXISTS postgis;

-- Enable earthdistance for service point proximity search
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- ==========================================
-- BASE TABLES
-- ==========================================

-- Organizations / Merchants
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE,
    email VARCHAR(255),
    phone VARCHAR(50),
    website VARCHAR(255),

    -- Address
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(2) DEFAULT 'FR',

    -- Settings
    timezone VARCHAR(50) DEFAULT 'Europe/Paris',
    currency VARCHAR(3) DEFAULT 'EUR',
    language VARCHAR(5) DEFAULT 'fr',

    -- Return address (JSONB)
    return_address JSONB,
    notification_settings JSONB DEFAULT '{}',

    -- Billing
    stripe_customer_id VARCHAR(255),
    plan VARCHAR(50) DEFAULT 'free',

    -- Status
    active BOOLEAN DEFAULT true,
    verified BOOLEAN DEFAULT false,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_active ON organizations(active);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255),

    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(50),

    role VARCHAR(50) DEFAULT 'user', -- admin, manager, user, viewer

    -- Status
    active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,

    -- Auth
    last_login_at TIMESTAMP,
    password_reset_token VARCHAR(255),
    password_reset_expires TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    name VARCHAR(100),
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(10), -- First few chars for identification

    -- Permissions
    scopes TEXT[] DEFAULT ARRAY['read'],

    -- Status
    active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,

    -- Expiration
    expires_at TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    code VARCHAR(50),
    type VARCHAR(50) DEFAULT 'shipping', -- shipping, return, both

    -- Address
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(2) DEFAULT 'FR',

    -- Contact
    contact_name VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),

    -- Settings
    is_default BOOLEAN DEFAULT false,
    active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_warehouses_org ON warehouses(organization_id);

-- Organization Settings (additional settings table)
CREATE TABLE IF NOT EXISTS organization_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

    -- Return address
    return_address JSONB,

    -- Carrier settings
    carrier_settings JSONB DEFAULT '{}',

    -- Notification settings
    notification_settings JSONB DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ==========================================
-- ORDERS
-- ==========================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Order info
    order_number VARCHAR(100) NOT NULL,
    external_id VARCHAR(255), -- ID from external system (Shopify, WooCommerce, etc.)
    source VARCHAR(50), -- shopify, woocommerce, prestashop, api, manual

    -- Customer
    customer_id VARCHAR(255),
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    customer_phone VARCHAR(50),

    -- Addresses (JSONB)
    shipping_address JSONB,
    billing_address JSONB,

    -- Items (JSONB array)
    items JSONB NOT NULL DEFAULT '[]',

    -- Totals
    subtotal DECIMAL(10,2),
    shipping_cost DECIMAL(10,2),
    tax DECIMAL(10,2),
    discount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'EUR',

    -- Status
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, shipped, delivered, cancelled, refunded
    payment_status VARCHAR(50) DEFAULT 'pending', -- pending, paid, refunded, failed
    fulfillment_status VARCHAR(50) DEFAULT 'unfulfilled', -- unfulfilled, partial, fulfilled

    -- Notes
    customer_notes TEXT,
    internal_notes TEXT,

    -- Tags
    tags TEXT[],

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    cancelled_at TIMESTAMP,

    UNIQUE(organization_id, order_number)
);

CREATE INDEX idx_orders_org ON orders(organization_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_orders_customer_email ON orders(customer_email);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_external_id ON orders(external_id);

-- ==========================================
-- SHIPMENTS
-- ==========================================

CREATE TABLE IF NOT EXISTS shipments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    warehouse_id UUID REFERENCES warehouses(id),

    -- Shipment info
    reference VARCHAR(100),
    carrier VARCHAR(50) NOT NULL,
    service VARCHAR(100),
    tracking_number VARCHAR(100),
    tracking_page_url TEXT,

    -- Status
    status VARCHAR(50) DEFAULT 'pending',
    -- pending, label_created, picked_up, in_transit, out_for_delivery, delivered, exception, returned, cancelled

    -- Recipient
    recipient_name VARCHAR(255),
    recipient_company VARCHAR(255),
    recipient_email VARCHAR(255),
    recipient_phone VARCHAR(50),
    recipient_address1 VARCHAR(255),
    recipient_address2 VARCHAR(255),
    recipient_city VARCHAR(100),
    recipient_state VARCHAR(100),
    recipient_postal_code VARCHAR(20),
    recipient_country VARCHAR(2) DEFAULT 'FR',

    -- Sender (if different from warehouse)
    sender_name VARCHAR(255),
    sender_company VARCHAR(255),
    sender_address1 VARCHAR(255),
    sender_address2 VARCHAR(255),
    sender_city VARCHAR(100),
    sender_postal_code VARCHAR(20),
    sender_country VARCHAR(2),

    -- Package details
    weight DECIMAL(10,3), -- kg
    length DECIMAL(10,2), -- cm
    width DECIMAL(10,2),
    height DECIMAL(10,2),
    package_type VARCHAR(50), -- parcel, letter, pallet

    -- Shipping options
    is_return BOOLEAN DEFAULT false,
    signature_required BOOLEAN DEFAULT false,
    insurance_value DECIMAL(10,2),
    declared_value DECIMAL(10,2),
    contents_description TEXT,

    -- Service point (for pickup)
    service_point_id VARCHAR(100),
    service_point_name VARCHAR(255),
    service_point_address TEXT,

    -- Label
    label_url TEXT,
    label_format VARCHAR(10) DEFAULT 'PDF', -- PDF, ZPL, PNG
    label_created_at TIMESTAMP,

    -- Costs
    shipping_cost DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'EUR',

    -- Delivery estimates
    estimated_delivery DATE,
    estimated_delivery_from TIMESTAMP,
    estimated_delivery_to TIMESTAMP,

    -- Tracking
    tracking_events JSONB DEFAULT '[]',
    last_tracking_update TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    cancelled_at TIMESTAMP
);

CREATE INDEX idx_shipments_org ON shipments(organization_id);
CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipments_tracking ON shipments(tracking_number);
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_shipments_carrier ON shipments(carrier);
CREATE INDEX idx_shipments_created ON shipments(created_at DESC);

-- ==========================================
-- Now include the branded tracking & returns schema
-- ==========================================

-- BRAND SETTINGS
CREATE TABLE IF NOT EXISTS brand_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

    -- Basic Branding
    name VARCHAR(255) NOT NULL,
    logo_url TEXT,
    favicon_url TEXT,

    -- Colors
    primary_color VARCHAR(7) DEFAULT '#2563EB',
    secondary_color VARCHAR(7) DEFAULT '#1E40AF',
    accent_color VARCHAR(7) DEFAULT '#F59E0B',
    background_color VARCHAR(7) DEFAULT '#F8FAFC',
    text_color VARCHAR(7) DEFAULT '#1E293B',

    -- Typography & Style
    font_family VARCHAR(255) DEFAULT 'Inter, system-ui, sans-serif',
    border_radius VARCHAR(20) DEFAULT '12px',

    -- Tracking Page Options
    show_carrier_logo BOOLEAN DEFAULT true,
    show_estimated_delivery BOOLEAN DEFAULT true,
    show_map BOOLEAN DEFAULT false,
    show_products BOOLEAN DEFAULT true,

    -- Promo Banner
    show_promo_banner BOOLEAN DEFAULT false,
    promo_banner_text TEXT,
    promo_banner_url TEXT,
    promo_banner_image TEXT,

    -- Social Links
    instagram_url TEXT,
    instagram_embed BOOLEAN DEFAULT false,
    facebook_url TEXT,
    twitter_url TEXT,

    -- Support
    support_email VARCHAR(255),
    support_phone VARCHAR(50),
    support_url TEXT,

    -- Custom CSS
    custom_css TEXT,

    -- Email Settings
    email_from_name VARCHAR(255),
    email_from_address VARCHAR(255),
    email_reply_to VARCHAR(255),
    email_logo_url TEXT,
    email_footer_text TEXT,

    -- Notification Settings (JSON)
    notifications JSONB DEFAULT '{
        "email": {
            "enabled": true,
            "events": ["label_created", "in_transit", "out_for_delivery", "delivered", "exception"]
        },
        "sms": {
            "enabled": false,
            "events": ["out_for_delivery", "delivered"]
        }
    }',

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_brand_settings_org ON brand_settings(organization_id);

-- RETURNS PORTAL SETTINGS
CREATE TABLE IF NOT EXISTS returns_portal_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

    -- General Settings
    enabled BOOLEAN DEFAULT true,
    return_window_days INTEGER DEFAULT 30,
    auto_approve BOOLEAN DEFAULT false,
    require_photos BOOLEAN DEFAULT false,
    allow_partial_returns BOOLEAN DEFAULT true,

    -- Return Methods (JSON: dropoff, pickup, store)
    methods JSONB DEFAULT '{
        "dropoff": {"enabled": true, "price": 0, "label": "Point relais"},
        "pickup": {"enabled": false, "price": 4.99, "label": "Enlèvement à domicile"},
        "store": {"enabled": false, "price": 0, "label": "Retour en magasin"}
    }',

    -- Fees
    restocking_fee_percent DECIMAL(5,2) DEFAULT 0,
    free_return_threshold DECIMAL(10,2) DEFAULT 0,

    -- Carriers
    return_carriers TEXT[] DEFAULT ARRAY['colissimo', 'mondial_relay'],
    default_carrier VARCHAR(50) DEFAULT 'colissimo',

    -- Custom Return Reasons (JSON, null = use defaults)
    custom_reasons JSONB,

    -- Refund Options
    refund_methods TEXT[] DEFAULT ARRAY['original_payment', 'store_credit'],
    default_refund_method VARCHAR(50) DEFAULT 'original_payment',

    -- QR Code / Paperless
    enable_qr_code BOOLEAN DEFAULT true,
    enable_label_in_box BOOLEAN DEFAULT false,

    -- Styling
    custom_css TEXT,

    -- Legal
    terms_url TEXT,
    privacy_url TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_returns_portal_org ON returns_portal_settings(organization_id);

-- RETURNS
CREATE TABLE IF NOT EXISTS returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rma_id VARCHAR(50) UNIQUE NOT NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id),
    order_number VARCHAR(100),
    customer_email VARCHAR(255),

    -- Items (JSON array)
    items JSONB NOT NULL DEFAULT '[]',

    -- Return Details
    return_method VARCHAR(50), -- dropoff, pickup, store
    refund_method VARCHAR(50), -- original_payment, store_credit, bank_transfer
    comments TEXT,
    photos JSONB DEFAULT '[]',

    -- Financial
    original_amount DECIMAL(10,2),
    restocking_fee DECIMAL(10,2) DEFAULT 0,
    shipping_fee DECIMAL(10,2) DEFAULT 0,
    estimated_refund DECIMAL(10,2),
    final_refund_amount DECIMAL(10,2),

    -- Shipping
    carrier VARCHAR(50),
    tracking_number VARCHAR(100),
    label_url TEXT,
    qr_code_url TEXT,
    return_address JSONB,

    -- Payment (for paid returns)
    payment_intent_id VARCHAR(255),
    payment_status VARCHAR(50) DEFAULT 'not_required', -- not_required, pending, paid, failed
    paid_at TIMESTAMP,

    -- Status
    status VARCHAR(50) DEFAULT 'pending_approval',
    -- pending_approval, approved, rejected, label_created, in_transit,
    -- received, inspecting, processed, refunded, closed

    rejection_reason TEXT,

    -- Processing
    approved_by UUID,
    received_by UUID,
    processed_by UUID,
    warehouse_location VARCHAR(100),

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    approved_at TIMESTAMP,
    label_created_at TIMESTAMP,
    shipped_at TIMESTAMP,
    received_at TIMESTAMP,
    processed_at TIMESTAMP,
    refunded_at TIMESTAMP,
    closed_at TIMESTAMP,

    -- SLA
    sla_deadline TIMESTAMP,
    is_overdue BOOLEAN DEFAULT false
);

CREATE INDEX idx_returns_org ON returns(organization_id);
CREATE INDEX idx_returns_order ON returns(order_id);
CREATE INDEX idx_returns_rma ON returns(rma_id);
CREATE INDEX idx_returns_status ON returns(status);
CREATE INDEX idx_returns_tracking ON returns(tracking_number);
CREATE INDEX idx_returns_created ON returns(created_at DESC);

-- NOTIFICATION LOGS
CREATE TABLE IF NOT EXISTS notification_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shipment_id UUID REFERENCES shipments(id) ON DELETE CASCADE,
    return_id UUID REFERENCES returns(id) ON DELETE CASCADE,

    -- Notification Details
    type VARCHAR(20) NOT NULL, -- email, sms, whatsapp, push
    event_type VARCHAR(50) NOT NULL, -- label_created, in_transit, delivered, etc.
    recipient VARCHAR(255) NOT NULL,

    -- Status
    status VARCHAR(20) DEFAULT 'pending', -- pending, sent, delivered, failed, bounced
    message_id VARCHAR(255),
    error TEXT,

    -- Metadata
    metadata JSONB DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP
);

CREATE INDEX idx_notification_logs_shipment ON notification_logs(shipment_id);
CREATE INDEX idx_notification_logs_return ON notification_logs(return_id);
CREATE INDEX idx_notification_logs_status ON notification_logs(status);
CREATE INDEX idx_notification_logs_created ON notification_logs(created_at DESC);

-- TRACKING PAGE ANALYTICS
CREATE TABLE IF NOT EXISTS tracking_analytics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    shipment_id UUID REFERENCES shipments(id) ON DELETE CASCADE,
    tracking_number VARCHAR(100),

    -- Page View
    page_type VARCHAR(20) DEFAULT 'tracking', -- tracking, returns

    -- Visitor Info
    visitor_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    referrer TEXT,

    -- Location
    country VARCHAR(2),
    city VARCHAR(100),

    -- Device
    device_type VARCHAR(20), -- desktop, mobile, tablet
    browser VARCHAR(50),
    os VARCHAR(50),

    -- Engagement
    time_on_page INTEGER, -- seconds
    clicked_promo BOOLEAN DEFAULT false,
    clicked_social BOOLEAN DEFAULT false,
    clicked_support BOOLEAN DEFAULT false,
    initiated_return BOOLEAN DEFAULT false,

    -- Timestamps
    viewed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tracking_analytics_org ON tracking_analytics(organization_id);
CREATE INDEX idx_tracking_analytics_shipment ON tracking_analytics(shipment_id);
CREATE INDEX idx_tracking_analytics_date ON tracking_analytics(viewed_at);

-- EMAIL TEMPLATES
CREATE TABLE IF NOT EXISTS email_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Template Info
    name VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL, -- label_created, in_transit, delivered, etc.
    language VARCHAR(5) DEFAULT 'fr',

    -- Content
    subject VARCHAR(255) NOT NULL,
    preheader VARCHAR(255),
    html_content TEXT NOT NULL,
    text_content TEXT,

    -- Status
    active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(organization_id, event_type, language)
);

CREATE INDEX idx_email_templates_org ON email_templates(organization_id);
CREATE INDEX idx_email_templates_event ON email_templates(event_type);

-- SERVICE POINT WIDGET CONFIG
CREATE TABLE IF NOT EXISTS service_point_widget_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

    -- General
    enabled BOOLEAN DEFAULT true,

    -- Carriers
    enabled_carriers TEXT[] DEFAULT ARRAY['mondial_relay', 'colissimo', 'chronopost'],

    -- Display Options
    default_view VARCHAR(10) DEFAULT 'map', -- 'map' or 'list'
    map_provider VARCHAR(20) DEFAULT 'mapbox', -- 'mapbox', 'google', 'leaflet'
    show_carrier_filter BOOLEAN DEFAULT true,
    show_distance BOOLEAN DEFAULT true,
    show_opening_hours BOOLEAN DEFAULT true,
    show_photos BOOLEAN DEFAULT true,

    -- Search Options
    max_results INTEGER DEFAULT 20,
    max_distance INTEGER DEFAULT 20, -- km
    auto_select_nearest BOOLEAN DEFAULT false,

    -- Styling
    theme VARCHAR(10) DEFAULT 'light', -- 'light', 'dark', 'auto'
    primary_color VARCHAR(7) DEFAULT '#2563EB',
    border_radius VARCHAR(20) DEFAULT '12px',
    font_family VARCHAR(255) DEFAULT 'Inter, system-ui, sans-serif',

    -- Map Settings
    map_zoom_default INTEGER DEFAULT 13,
    map_style VARCHAR(20) DEFAULT 'streets',

    -- Custom Labels (JSONB for multi-language)
    labels JSONB DEFAULT '{}',

    -- Custom CSS
    custom_css TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sp_widget_config_org ON service_point_widget_config(organization_id);

-- SERVICE POINT CACHE
CREATE TABLE IF NOT EXISTS service_point_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    carrier VARCHAR(50) NOT NULL,
    point_id VARCHAR(100) NOT NULL,
    country VARCHAR(2) NOT NULL,

    -- Point Data
    name VARCHAR(255),
    address TEXT,
    postal_code VARCHAR(20),
    city VARCHAR(100),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    point_type VARCHAR(50),
    opening_hours JSONB,
    features TEXT[],
    photo_url TEXT,

    -- Status
    active BOOLEAN DEFAULT true,

    -- Timestamps
    cached_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',

    UNIQUE(carrier, point_id)
);

CREATE INDEX idx_sp_cache_carrier ON service_point_cache(carrier);
CREATE INDEX idx_sp_cache_location ON service_point_cache(country, postal_code);
CREATE INDEX idx_sp_cache_geo ON service_point_cache USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX idx_sp_cache_expires ON service_point_cache(expires_at);

-- SERVICE POINT ANALYTICS
CREATE TABLE IF NOT EXISTS service_point_analytics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Session
    session_id VARCHAR(100),

    -- Search Context
    search_postal_code VARCHAR(20),
    search_country VARCHAR(2),
    search_carriers TEXT[],
    results_count INTEGER,

    -- Selection
    selected_carrier VARCHAR(50),
    selected_point_id VARCHAR(100),
    selected_point_name VARCHAR(255),
    selection_rank INTEGER, -- Position in results

    -- Conversion
    converted_to_order BOOLEAN DEFAULT false,
    order_id UUID,

    -- Context
    checkout_platform VARCHAR(50), -- shopify, woocommerce, prestashop, etc.
    device_type VARCHAR(20),

    -- Timestamps
    searched_at TIMESTAMP DEFAULT NOW(),
    selected_at TIMESTAMP,
    converted_at TIMESTAMP
);

CREATE INDEX idx_sp_analytics_org ON service_point_analytics(organization_id);
CREATE INDEX idx_sp_analytics_date ON service_point_analytics(searched_at);
CREATE INDEX idx_sp_analytics_carrier ON service_point_analytics(selected_carrier);

-- CARRIER CREDENTIALS (encrypted)
CREATE TABLE IF NOT EXISTS carrier_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    carrier VARCHAR(50) NOT NULL,

    -- Credentials (encrypted)
    credentials_encrypted BYTEA NOT NULL,
    credentials_iv BYTEA NOT NULL,

    -- Status
    active BOOLEAN DEFAULT true,
    verified BOOLEAN DEFAULT false,
    verified_at TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(organization_id, carrier)
);

CREATE INDEX idx_carrier_creds_org ON carrier_credentials(organization_id);

-- SAVED SERVICE POINTS (customer favorites)
CREATE TABLE IF NOT EXISTS saved_service_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id VARCHAR(255), -- External customer ID
    customer_email VARCHAR(255),

    -- Point Info
    carrier VARCHAR(50) NOT NULL,
    point_id VARCHAR(100) NOT NULL,
    point_name VARCHAR(255),
    point_address TEXT,
    point_postal_code VARCHAR(20),
    point_city VARCHAR(100),
    point_country VARCHAR(2),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),

    -- Metadata
    label VARCHAR(100), -- "Home", "Work", etc.
    is_default BOOLEAN DEFAULT false,
    last_used_at TIMESTAMP,
    usage_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_saved_sp_org ON saved_service_points(organization_id);
CREATE INDEX idx_saved_sp_customer ON saved_service_points(customer_email);

-- ==========================================
-- FUNCTIONS & TRIGGERS
-- ==========================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all relevant tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT table_name
        FROM information_schema.columns
        WHERE column_name = 'updated_at'
        AND table_schema = 'public'
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_%s_updated_at ON %s;
            CREATE TRIGGER update_%s_updated_at
            BEFORE UPDATE ON %s
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END $$;

-- Function to check return SLA
CREATE OR REPLACE FUNCTION check_return_sla()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.sla_deadline IS NOT NULL AND NEW.sla_deadline < NOW() THEN
        NEW.is_overdue = true;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS check_return_sla_trigger ON returns;
CREATE TRIGGER check_return_sla_trigger
    BEFORE UPDATE ON returns
    FOR EACH ROW EXECUTE FUNCTION check_return_sla();

-- Function to clean expired cache
CREATE OR REPLACE FUNCTION clean_expired_sp_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM service_point_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- SEED DATA (Demo Organization)
-- ==========================================

-- Create a demo organization
INSERT INTO organizations (id, name, slug, email, timezone, currency, language, active, verified)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'Demo Store',
    'demo-store',
    'demo@routz.io',
    'Europe/Paris',
    'EUR',
    'fr',
    true,
    true
) ON CONFLICT DO NOTHING;

-- Create default brand settings for demo org
INSERT INTO brand_settings (organization_id, name, primary_color, secondary_color, support_email)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'Demo Store',
    '#2563EB',
    '#1E40AF',
    'support@demo-store.com'
) ON CONFLICT (organization_id) DO NOTHING;

-- Create default returns portal settings for demo org
INSERT INTO returns_portal_settings (organization_id, enabled, return_window_days, auto_approve)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    true,
    30,
    true
) ON CONFLICT (organization_id) DO NOTHING;

-- Create default service point widget config for demo org
INSERT INTO service_point_widget_config (organization_id, enabled)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    true
) ON CONFLICT (organization_id) DO NOTHING;

-- Create a demo warehouse
INSERT INTO warehouses (id, organization_id, name, code, type, address_line1, city, postal_code, country, is_default)
VALUES (
    'b0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'Main Warehouse',
    'WH-MAIN',
    'both',
    '123 Rue du Commerce',
    'Paris',
    '75001',
    'FR',
    true
) ON CONFLICT DO NOTHING;

-- Create a sample order
INSERT INTO orders (id, organization_id, order_number, customer_name, customer_email, shipping_address, items, total, status, payment_status, fulfillment_status)
VALUES (
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'ORD-2024-001',
    'Jean Dupont',
    'jean.dupont@example.com',
    '{"name": "Jean Dupont", "address1": "456 Avenue des Champs", "city": "Paris", "postalCode": "75008", "country": "FR"}',
    '[{"id": "item-1", "sku": "TSHIRT-BLU-M", "name": "T-Shirt Bleu", "quantity": 2, "price": 29.99, "image": "https://example.com/tshirt.jpg"}, {"id": "item-2", "sku": "JEANS-BLK-32", "name": "Jean Noir", "quantity": 1, "price": 79.99, "image": "https://example.com/jeans.jpg"}]',
    139.97,
    'shipped',
    'paid',
    'fulfilled'
) ON CONFLICT DO NOTHING;

-- Create a sample shipment
INSERT INTO shipments (id, organization_id, order_id, carrier, tracking_number, status, recipient_name, recipient_email, recipient_address1, recipient_city, recipient_postal_code, recipient_country, estimated_delivery, tracking_events)
VALUES (
    'd0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'colissimo',
    'DEMO123456789FR',
    'in_transit',
    'Jean Dupont',
    'jean.dupont@example.com',
    '456 Avenue des Champs',
    'Paris',
    '75008',
    'FR',
    CURRENT_DATE + INTERVAL '2 days',
    '[{"timestamp": "2024-01-15T10:00:00Z", "status": "label_created", "description": "Étiquette créée", "location": "Paris"}, {"timestamp": "2024-01-15T14:00:00Z", "status": "picked_up", "description": "Pris en charge", "location": "Paris"}, {"timestamp": "2024-01-16T08:00:00Z", "status": "in_transit", "description": "En cours d''acheminement", "location": "Hub Colissimo"}]'
) ON CONFLICT DO NOTHING;

-- ==========================================
-- GRANT PERMISSIONS (adjust as needed)
-- ==========================================

-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO routz;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO routz;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO routz;

-- Done!
SELECT 'Schema created successfully!' as status;
