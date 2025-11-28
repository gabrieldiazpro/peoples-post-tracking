-- ==========================================
-- ROUTZ - Shopify Integration Schema
-- Additional tables for Shopify app
-- ==========================================

-- Add Shopify domain column to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS shopify_domain VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_organizations_shopify ON organizations(shopify_domain);

-- Shopify OAuth States (temporary, for auth flow)
CREATE TABLE IF NOT EXISTS shopify_oauth_states (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    state VARCHAR(255) UNIQUE NOT NULL,
    shop VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Auto-delete old states (cleanup)
CREATE INDEX idx_shopify_oauth_states_created ON shopify_oauth_states(created_at);

-- Shopify Shops (installed shops)
CREATE TABLE IF NOT EXISTS shopify_shops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shop_domain VARCHAR(255) UNIQUE NOT NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Auth
    access_token TEXT, -- Should be encrypted in production
    scope TEXT,

    -- Status
    installed_at TIMESTAMP DEFAULT NOW(),
    uninstalled_at TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_shopify_shops_org ON shopify_shops(organization_id);
CREATE INDEX idx_shopify_shops_domain ON shopify_shops(shop_domain);

-- Shopify App Settings (per organization)
CREATE TABLE IF NOT EXISTS shopify_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

    -- Settings (JSONB)
    settings JSONB DEFAULT '{
        "auto_import_orders": true,
        "auto_fulfill": false,
        "default_carrier": "colissimo",
        "enable_pickup_points": true,
        "enable_returns_portal": true,
        "tracking_page_enabled": true,
        "notify_customer_on_shipment": true,
        "free_shipping_threshold": 50
    }',

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_shopify_settings_org ON shopify_settings(organization_id);

-- Add external platform columns to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_platform VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_created_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS financial_status VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_weight DECIMAL(10,3);

-- Add external fulfillment ID to shipments
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS external_fulfillment_id VARCHAR(255);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS service VARCHAR(100);

-- Create unique constraint for external orders
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_unique
ON orders(organization_id, external_id, external_platform)
WHERE external_id IS NOT NULL AND external_platform IS NOT NULL;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_shopify_shops_updated_at ON shopify_shops;
CREATE TRIGGER update_shopify_shops_updated_at
    BEFORE UPDATE ON shopify_shops
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_shopify_settings_updated_at ON shopify_settings;
CREATE TRIGGER update_shopify_settings_updated_at
    BEFORE UPDATE ON shopify_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Done
SELECT 'Shopify schema created successfully!' as status;
