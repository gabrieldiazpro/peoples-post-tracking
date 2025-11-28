-- ==========================================
-- ROUTZ - Branded Tracking & Returns Schema
-- Tables additionnelles pour le tracking brandé
-- et le portail de retours client
-- ==========================================

-- ==========================================
-- BRAND SETTINGS
-- Configuration de la marque pour tracking
-- ==========================================
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

-- ==========================================
-- RETURNS PORTAL SETTINGS
-- Configuration du portail de retours
-- ==========================================
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

-- ==========================================
-- RETURNS (Enhanced)
-- Table des retours avec infos complètes
-- ==========================================
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

-- ==========================================
-- NOTIFICATION LOGS
-- Historique des notifications envoyées
-- ==========================================
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

-- ==========================================
-- TRACKING PAGE ANALYTICS
-- Statistiques des pages de tracking
-- ==========================================
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

-- ==========================================
-- EMAIL TEMPLATES (Custom per organization)
-- Templates email personnalisés
-- ==========================================
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

-- ==========================================
-- ORGANIZATION SETTINGS (return address etc)
-- ==========================================
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS return_address JSONB;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS notification_settings JSONB DEFAULT '{}';

-- ==========================================
-- Add tracking page URL to shipments
-- ==========================================
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_page_url TEXT;

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

-- Apply trigger to tables
DROP TRIGGER IF EXISTS update_brand_settings_updated_at ON brand_settings;
CREATE TRIGGER update_brand_settings_updated_at
    BEFORE UPDATE ON brand_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_returns_portal_settings_updated_at ON returns_portal_settings;
CREATE TRIGGER update_returns_portal_settings_updated_at
    BEFORE UPDATE ON returns_portal_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_returns_updated_at ON returns;
CREATE TRIGGER update_returns_updated_at
    BEFORE UPDATE ON returns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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

-- ==========================================
-- SAMPLE DATA (for testing)
-- ==========================================

-- Insert default brand settings for existing organizations
INSERT INTO brand_settings (organization_id, name, primary_color, secondary_color)
SELECT id, name, '#2563EB', '#1E40AF'
FROM organizations
WHERE id NOT IN (SELECT organization_id FROM brand_settings WHERE organization_id IS NOT NULL)
ON CONFLICT DO NOTHING;

-- Insert default returns portal settings
INSERT INTO returns_portal_settings (organization_id)
SELECT id FROM organizations
WHERE id NOT IN (SELECT organization_id FROM returns_portal_settings WHERE organization_id IS NOT NULL)
ON CONFLICT DO NOTHING;

-- ==========================================
-- SERVICE POINT PICKER TABLES
-- Tables pour le widget de sélection de points relais
-- ==========================================

-- Widget Configuration
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

-- Service Point Cache (for faster lookups)
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

-- Service Point Selection Analytics
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

-- Carrier Credentials (encrypted)
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

-- Saved Service Points (customer favorites)
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

-- Triggers
DROP TRIGGER IF EXISTS update_sp_widget_config_updated_at ON service_point_widget_config;
CREATE TRIGGER update_sp_widget_config_updated_at
    BEFORE UPDATE ON service_point_widget_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to clean expired cache
CREATE OR REPLACE FUNCTION clean_expired_sp_cache()
RETURNS void AS $$
BEGIN
    DELETE FROM service_point_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Insert default widget config for existing organizations
INSERT INTO service_point_widget_config (organization_id)
SELECT id FROM organizations
WHERE id NOT IN (SELECT organization_id FROM service_point_widget_config WHERE organization_id IS NOT NULL)
ON CONFLICT DO NOTHING;
