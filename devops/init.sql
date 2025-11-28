-- ==========================================
-- Routz v4.0 - Database Schema
-- PostgreSQL 16
-- ==========================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ==========================================
-- ORGANIZATIONS
-- ==========================================
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    plan VARCHAR(50) DEFAULT 'free',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ==========================================
-- USERS
-- ==========================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user',
    api_token VARCHAR(255) UNIQUE,
    settings JSONB DEFAULT '{}',
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_api_token ON users(api_token);

-- ==========================================
-- CARRIERS
-- ==========================================
CREATE TABLE carriers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    countries_served TEXT[],
    services JSONB DEFAULT '[]',
    settings JSONB DEFAULT '{}',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE organization_carriers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    carrier_id VARCHAR(50) REFERENCES carriers(id),
    credentials JSONB,
    settings JSONB DEFAULT '{}',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(organization_id, carrier_id)
);

-- ==========================================
-- WAREHOUSES
-- ==========================================
CREATE TABLE warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50),
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(2),
    is_default BOOLEAN DEFAULT false,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_warehouses_org ON warehouses(organization_id);

-- ==========================================
-- ORDERS
-- ==========================================
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    order_number VARCHAR(100) NOT NULL,
    external_id VARCHAR(255),
    source VARCHAR(50),
    status VARCHAR(50) DEFAULT 'pending',
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    shipping_address JSONB,
    billing_address JSONB,
    items JSONB DEFAULT '[]',
    subtotal DECIMAL(10, 2),
    shipping_cost DECIMAL(10, 2),
    tax DECIMAL(10, 2),
    total DECIMAL(10, 2),
    currency VARCHAR(3) DEFAULT 'EUR',
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP
);

CREATE INDEX idx_orders_org ON orders(organization_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_source ON orders(source);
CREATE INDEX idx_orders_created ON orders(created_at DESC);

-- ==========================================
-- SHIPMENTS
-- ==========================================
CREATE TABLE shipments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id),
    tracking_number VARCHAR(100),
    carrier VARCHAR(50),
    service VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending',
    
    -- Sender
    sender_name VARCHAR(255),
    sender_company VARCHAR(255),
    sender_address1 VARCHAR(255),
    sender_address2 VARCHAR(255),
    sender_city VARCHAR(100),
    sender_state VARCHAR(100),
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
    recipient_state VARCHAR(100),
    recipient_postal_code VARCHAR(20),
    recipient_country VARCHAR(2),
    recipient_phone VARCHAR(50),
    recipient_email VARCHAR(255),
    
    -- Parcel details
    parcels JSONB DEFAULT '[]',
    total_weight DECIMAL(10, 3),
    
    -- Shipping details
    label_url TEXT,
    label_format VARCHAR(10),
    shipping_cost DECIMAL(10, 2),
    insurance_value DECIMAL(10, 2),
    
    -- Tracking
    estimated_delivery DATE,
    last_tracking_update TIMESTAMP,
    last_location VARCHAR(255),
    tracking_events JSONB DEFAULT '[]',
    
    -- Dates
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    
    -- Metadata
    reference VARCHAR(255),
    notes TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_shipments_org ON shipments(organization_id);
CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipments_tracking ON shipments(tracking_number);
CREATE INDEX idx_shipments_carrier ON shipments(carrier);
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_shipments_created ON shipments(created_at DESC);
CREATE INDEX idx_shipments_recipient_postal ON shipments(recipient_postal_code);

-- ==========================================
-- RETURNS (RMA)
-- ==========================================
CREATE TABLE returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id),
    rma_number VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(50) DEFAULT 'pending_approval',
    reason_code VARCHAR(50),
    reason_text TEXT,
    
    -- Customer
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    
    -- Items
    items JSONB DEFAULT '[]',
    
    -- Shipping
    return_carrier VARCHAR(50),
    return_tracking_number VARCHAR(100),
    return_label_url TEXT,
    shipping_method VARCHAR(50),
    
    -- Refund
    original_amount DECIMAL(10, 2),
    refund_amount DECIMAL(10, 2),
    restocking_fee DECIMAL(10, 2) DEFAULT 0,
    refund_method VARCHAR(50),
    refund_status VARCHAR(50),
    
    -- Dates
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    approved_at TIMESTAMP,
    received_at TIMESTAMP,
    inspected_at TIMESTAMP,
    refunded_at TIMESTAMP,
    
    -- Metadata
    notes TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_returns_org ON returns(organization_id);
CREATE INDEX idx_returns_order ON returns(order_id);
CREATE INDEX idx_returns_rma ON returns(rma_number);
CREATE INDEX idx_returns_status ON returns(status);

-- ==========================================
-- INVENTORY
-- ==========================================
CREATE TABLE inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL,
    name VARCHAR(255),
    quantity INTEGER DEFAULT 0,
    reserved INTEGER DEFAULT 0,
    available INTEGER GENERATED ALWAYS AS (quantity - reserved) STORED,
    reorder_point INTEGER DEFAULT 0,
    location VARCHAR(100),
    barcode VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(organization_id, warehouse_id, sku)
);

CREATE INDEX idx_inventory_org ON inventory(organization_id);
CREATE INDEX idx_inventory_warehouse ON inventory(warehouse_id);
CREATE INDEX idx_inventory_sku ON inventory(sku);
CREATE INDEX idx_inventory_low_stock ON inventory(available) WHERE available <= reorder_point;

-- ==========================================
-- INVENTORY MOVEMENTS
-- ==========================================
CREATE TABLE inventory_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    inventory_id UUID REFERENCES inventory(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    reference_type VARCHAR(50),
    reference_id UUID,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_movements_inventory ON inventory_movements(inventory_id);
CREATE INDEX idx_movements_created ON inventory_movements(created_at DESC);

-- ==========================================
-- WEBHOOKS
-- ==========================================
CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret VARCHAR(255),
    events TEXT[] DEFAULT '{}',
    active BOOLEAN DEFAULT true,
    retry_count INTEGER DEFAULT 0,
    last_triggered_at TIMESTAMP,
    last_status INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_webhooks_org ON webhooks(organization_id);

-- ==========================================
-- WEBHOOK LOGS
-- ==========================================
CREATE TABLE webhook_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    event VARCHAR(100),
    payload JSONB,
    response_status INTEGER,
    response_body TEXT,
    duration_ms INTEGER,
    attempt INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_webhook_logs_webhook ON webhook_logs(webhook_id);
CREATE INDEX idx_webhook_logs_created ON webhook_logs(created_at DESC);

-- ==========================================
-- SUPPORT CHATS
-- ==========================================
CREATE TABLE support_chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    customer_id VARCHAR(255),
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    channel VARCHAR(50) DEFAULT 'widget',
    status VARCHAR(50) DEFAULT 'waiting',
    priority VARCHAR(20) DEFAULT 'normal',
    assigned_to UUID REFERENCES users(id),
    department VARCHAR(100),
    subject TEXT,
    context JSONB DEFAULT '{}',
    rating INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    first_response_at TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE INDEX idx_chats_org ON support_chats(organization_id);
CREATE INDEX idx_chats_status ON support_chats(status);
CREATE INDEX idx_chats_assigned ON support_chats(assigned_to);

-- ==========================================
-- CHAT MESSAGES
-- ==========================================
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID REFERENCES support_chats(id) ON DELETE CASCADE,
    type VARCHAR(50) DEFAULT 'text',
    content TEXT,
    sender_type VARCHAR(50),
    sender_id VARCHAR(255),
    sender_name VARCHAR(255),
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_chat ON chat_messages(chat_id);
CREATE INDEX idx_messages_created ON chat_messages(created_at);

-- ==========================================
-- SUPPORT TICKETS
-- ==========================================
CREATE TABLE support_tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES support_chats(id),
    customer_id VARCHAR(255),
    customer_email VARCHAR(255),
    subject TEXT,
    description TEXT,
    category VARCHAR(100),
    priority VARCHAR(20) DEFAULT 'normal',
    status VARCHAR(50) DEFAULT 'open',
    assigned_to UUID REFERENCES users(id),
    department VARCHAR(100),
    tags JSONB DEFAULT '[]',
    sla_deadline TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    first_response_at TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE INDEX idx_tickets_org ON support_tickets(organization_id);
CREATE INDEX idx_tickets_status ON support_tickets(status);

-- ==========================================
-- CUSTOMS DECLARATIONS
-- ==========================================
CREATE TABLE customs_declarations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    shipment_id UUID REFERENCES shipments(id),
    type VARCHAR(50),
    exporter JSONB,
    importer JSONB,
    items JSONB DEFAULT '[]',
    total_value DECIMAL(10, 2),
    currency VARCHAR(3),
    incoterm VARCHAR(10),
    origin_country VARCHAR(2),
    destination_country VARCHAR(2),
    required_documents JSONB DEFAULT '[]',
    estimated_duties DECIMAL(10, 2),
    estimated_taxes DECIMAL(10, 2),
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_customs_org ON customs_declarations(organization_id);
CREATE INDEX idx_customs_shipment ON customs_declarations(shipment_id);

-- ==========================================
-- CARRIER RECOMMENDATIONS (AI)
-- ==========================================
CREATE TABLE carrier_recommendations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    shipment_data JSONB,
    recommended_carrier VARCHAR(50),
    score INTEGER,
    alternatives JSONB DEFAULT '[]',
    selected_carrier VARCHAR(50),
    feedback VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_recommendations_org ON carrier_recommendations(organization_id);
CREATE INDEX idx_recommendations_carrier ON carrier_recommendations(recommended_carrier);

-- ==========================================
-- API LOGS
-- ==========================================
CREATE TABLE api_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID,
    user_id UUID,
    method VARCHAR(10),
    path TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    ip_address INET,
    user_agent TEXT,
    request_body JSONB,
    response_size INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_api_logs_org ON api_logs(organization_id);
CREATE INDEX idx_api_logs_created ON api_logs(created_at DESC);

-- Partition by month for performance
-- CREATE TABLE api_logs_2024_01 PARTITION OF api_logs
--     FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- ==========================================
-- INSERT DEFAULT DATA
-- ==========================================

-- Default carriers
INSERT INTO carriers (id, name, type, countries_served, services) VALUES
('colissimo', 'Colissimo', 'national', ARRAY['FR'], '[{"id": "standard", "name": "Colissimo Standard", "estimatedDays": 3}, {"id": "expert", "name": "Colissimo Expert", "estimatedDays": 2}]'),
('chronopost', 'Chronopost', 'express', ARRAY['FR', 'BE', 'LU'], '[{"id": "express", "name": "Chrono 13", "estimatedDays": 1}, {"id": "classic", "name": "Chrono Classic", "estimatedDays": 2}]'),
('mondial_relay', 'Mondial Relay', 'relay', ARRAY['FR', 'BE', 'ES', 'LU', 'NL', 'PT'], '[{"id": "standard", "name": "Point Relais", "estimatedDays": 5}]'),
('dhl', 'DHL Express', 'international', ARRAY['*'], '[{"id": "express", "name": "DHL Express", "estimatedDays": 2}, {"id": "economy", "name": "DHL Economy", "estimatedDays": 5}]'),
('ups', 'UPS', 'international', ARRAY['*'], '[{"id": "express", "name": "UPS Express", "estimatedDays": 2}, {"id": "standard", "name": "UPS Standard", "estimatedDays": 4}]'),
('fedex', 'FedEx', 'international', ARRAY['*'], '[{"id": "priority", "name": "FedEx Priority", "estimatedDays": 2}, {"id": "economy", "name": "FedEx Economy", "estimatedDays": 5}]'),
('gls', 'GLS', 'european', ARRAY['FR', 'DE', 'BE', 'NL', 'ES', 'IT', 'PT', 'AT', 'PL'], '[{"id": "standard", "name": "GLS Standard", "estimatedDays": 3}]'),
('dpd', 'DPD', 'european', ARRAY['FR', 'DE', 'BE', 'NL', 'ES', 'IT', 'PT', 'AT', 'PL', 'GB'], '[{"id": "classic", "name": "DPD Classic", "estimatedDays": 3}]');

-- ==========================================
-- FUNCTIONS & TRIGGERS
-- ==========================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables
CREATE TRIGGER update_organizations_timestamp BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_users_timestamp BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_orders_timestamp BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_shipments_timestamp BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_returns_timestamp BEFORE UPDATE ON returns FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_inventory_timestamp BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_warehouses_timestamp BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_webhooks_timestamp BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ==========================================
-- VIEWS
-- ==========================================

-- Shipments summary view
CREATE VIEW v_shipments_summary AS
SELECT 
    organization_id,
    DATE(created_at) as date,
    carrier,
    status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as avg_delivery_days
FROM shipments
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY organization_id, DATE(created_at), carrier, status;

-- Carrier performance view
CREATE VIEW v_carrier_performance AS
SELECT 
    organization_id,
    carrier,
    COUNT(*) as total_shipments,
    COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
    COUNT(CASE WHEN status = 'exception' THEN 1 END) as exceptions,
    ROUND(COUNT(CASE WHEN status = 'delivered' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as delivery_rate,
    ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400)::numeric, 1) as avg_delivery_days
FROM shipments
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY organization_id, carrier;

-- Low stock view
CREATE VIEW v_low_stock AS
SELECT 
    i.organization_id,
    i.warehouse_id,
    w.name as warehouse_name,
    i.sku,
    i.name,
    i.quantity,
    i.reserved,
    i.available,
    i.reorder_point
FROM inventory i
JOIN warehouses w ON i.warehouse_id = w.id
WHERE i.available <= i.reorder_point;

COMMENT ON DATABASE routz IS 'Routz v4.0 - Enterprise Logistics Platform';
