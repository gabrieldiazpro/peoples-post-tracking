<?php
/**
 * Plugin Name: Routz Shipping
 * Plugin URI: https://routz.io/integrations/woocommerce
 * Description: Solution complète d'expédition multi-transporteurs pour WooCommerce. Points relais, tracking brandé, retours, tarifs optimisés.
 * Version: 1.0.0
 * Author: Routz
 * Author URI: https://routz.io
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: routz-shipping
 * Domain Path: /languages
 * Requires at least: 5.8
 * Tested up to: 6.4
 * Requires PHP: 7.4
 * WC requires at least: 6.0
 * WC tested up to: 8.4
 */

if (!defined('ABSPATH')) {
    exit;
}

// Plugin constants
define('ROUTZ_VERSION', '1.0.0');
define('ROUTZ_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('ROUTZ_PLUGIN_URL', plugin_dir_url(__FILE__));
define('ROUTZ_API_URL', 'https://api.routz.io/v1');

/**
 * Main Routz Shipping Plugin Class
 */
class Routz_Shipping {
    
    /**
     * Single instance
     */
    private static $instance = null;
    
    /**
     * API Key
     */
    private $api_key;
    
    /**
     * Organization ID
     */
    private $org_id;

    /**
     * Get instance
     */
    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    /**
     * Constructor
     */
    private function __construct() {
        $this->api_key = get_option('routz_api_key');
        $this->org_id = get_option('routz_org_id');
        
        // Load dependencies
        $this->load_dependencies();
        
        // Initialize hooks
        $this->init_hooks();
    }

    /**
     * Load required files
     */
    private function load_dependencies() {
        // Shipping method
        require_once ROUTZ_PLUGIN_DIR . 'includes/class-routz-shipping-method.php';
        
        // Pickup points
        require_once ROUTZ_PLUGIN_DIR . 'includes/class-routz-pickup-points.php';
        
        // Tracking
        require_once ROUTZ_PLUGIN_DIR . 'includes/class-routz-tracking.php';
        
        // Returns
        require_once ROUTZ_PLUGIN_DIR . 'includes/class-routz-returns.php';
        
        // Admin
        if (is_admin()) {
            require_once ROUTZ_PLUGIN_DIR . 'includes/admin/class-routz-admin.php';
        }
    }

    /**
     * Initialize hooks
     */
    private function init_hooks() {
        // Activation/Deactivation
        register_activation_hook(__FILE__, array($this, 'activate'));
        register_deactivation_hook(__FILE__, array($this, 'deactivate'));
        
        // Init
        add_action('init', array($this, 'init'));
        add_action('plugins_loaded', array($this, 'load_textdomain'));
        
        // WooCommerce
        add_filter('woocommerce_shipping_methods', array($this, 'add_shipping_method'));
        add_action('woocommerce_shipping_init', array($this, 'shipping_init'));
        
        // Checkout
        add_action('woocommerce_review_order_before_shipping', array($this, 'display_pickup_selector'));
        add_action('woocommerce_checkout_update_order_meta', array($this, 'save_pickup_point'));
        
        // Order
        add_action('woocommerce_order_status_processing', array($this, 'sync_order_to_routz'));
        add_action('woocommerce_order_status_completed', array($this, 'sync_order_to_routz'));
        
        // Tracking
        add_action('woocommerce_order_details_after_order_table', array($this, 'display_tracking_info'));
        add_action('woocommerce_email_order_meta', array($this, 'add_tracking_to_email'), 10, 3);
        
        // Scripts
        add_action('wp_enqueue_scripts', array($this, 'enqueue_scripts'));
        
        // REST API
        add_action('rest_api_init', array($this, 'register_rest_routes'));
        
        // Webhooks from Routz
        add_action('wp_ajax_routz_webhook', array($this, 'handle_webhook'));
        add_action('wp_ajax_nopriv_routz_webhook', array($this, 'handle_webhook'));
        
        // HPOS compatibility
        add_action('before_woocommerce_init', array($this, 'declare_hpos_compatibility'));
    }

    /**
     * Plugin activation
     */
    public function activate() {
        // Create custom tables
        $this->create_tables();
        
        // Default options
        add_option('routz_api_key', '');
        add_option('routz_org_id', '');
        add_option('routz_enable_pickup_points', 'yes');
        add_option('routz_enable_tracking_page', 'yes');
        add_option('routz_enable_returns', 'yes');
        add_option('routz_auto_create_shipment', 'no');
        add_option('routz_default_carrier', 'colissimo');
        
        // Create tracking page
        $this->create_tracking_page();
        
        // Create returns page
        $this->create_returns_page();
        
        // Flush rewrite rules
        flush_rewrite_rules();
    }

    /**
     * Plugin deactivation
     */
    public function deactivate() {
        flush_rewrite_rules();
    }

    /**
     * Create database tables
     */
    private function create_tables() {
        global $wpdb;
        
        $charset_collate = $wpdb->get_charset_collate();
        
        $sql = "CREATE TABLE IF NOT EXISTS {$wpdb->prefix}routz_shipments (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            order_id bigint(20) unsigned NOT NULL,
            routz_shipment_id varchar(50) DEFAULT NULL,
            carrier varchar(50) DEFAULT NULL,
            service varchar(50) DEFAULT NULL,
            tracking_number varchar(100) DEFAULT NULL,
            label_url varchar(500) DEFAULT NULL,
            status varchar(50) DEFAULT 'pending',
            pickup_point_id varchar(100) DEFAULT NULL,
            pickup_point_data longtext DEFAULT NULL,
            created_at datetime DEFAULT CURRENT_TIMESTAMP,
            updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY order_id (order_id),
            KEY tracking_number (tracking_number)
        ) $charset_collate;";
        
        require_once(ABSPATH . 'wp-admin/includes/upgrade.php');
        dbDelta($sql);
    }

    /**
     * Create tracking page
     */
    private function create_tracking_page() {
        $page_id = get_option('routz_tracking_page_id');
        
        if (!$page_id || !get_post($page_id)) {
            $page = array(
                'post_title'   => __('Suivi de commande', 'routz-shipping'),
                'post_content' => '[routz_tracking]',
                'post_status'  => 'publish',
                'post_type'    => 'page',
                'post_name'    => 'suivi-commande'
            );
            
            $page_id = wp_insert_post($page);
            update_option('routz_tracking_page_id', $page_id);
        }
    }

    /**
     * Create returns page
     */
    private function create_returns_page() {
        $page_id = get_option('routz_returns_page_id');
        
        if (!$page_id || !get_post($page_id)) {
            $page = array(
                'post_title'   => __('Retourner un article', 'routz-shipping'),
                'post_content' => '[routz_returns]',
                'post_status'  => 'publish',
                'post_type'    => 'page',
                'post_name'    => 'retours'
            );
            
            $page_id = wp_insert_post($page);
            update_option('routz_returns_page_id', $page_id);
        }
    }

    /**
     * Init
     */
    public function init() {
        // Shortcodes
        add_shortcode('routz_tracking', array($this, 'tracking_shortcode'));
        add_shortcode('routz_returns', array($this, 'returns_shortcode'));
        add_shortcode('routz_pickup_map', array($this, 'pickup_map_shortcode'));
    }

    /**
     * Load translations
     */
    public function load_textdomain() {
        load_plugin_textdomain('routz-shipping', false, dirname(plugin_basename(__FILE__)) . '/languages');
    }

    /**
     * Add shipping method
     */
    public function add_shipping_method($methods) {
        $methods['routz_shipping'] = 'Routz_Shipping_Method';
        return $methods;
    }

    /**
     * Initialize shipping
     */
    public function shipping_init() {
        // Shipping method already loaded in load_dependencies
    }

    /**
     * Enqueue frontend scripts
     */
    public function enqueue_scripts() {
        if (is_checkout() || is_cart()) {
            // Pickup point selector
            if (get_option('routz_enable_pickup_points') === 'yes') {
                wp_enqueue_style(
                    'routz-pickup-selector',
                    ROUTZ_PLUGIN_URL . 'assets/css/pickup-selector.css',
                    array(),
                    ROUTZ_VERSION
                );
                
                wp_enqueue_script(
                    'routz-pickup-selector',
                    ROUTZ_PLUGIN_URL . 'assets/js/pickup-selector.js',
                    array('jquery'),
                    ROUTZ_VERSION,
                    true
                );
                
                wp_localize_script('routz-pickup-selector', 'routzPickup', array(
                    'ajaxUrl' => admin_url('admin-ajax.php'),
                    'nonce' => wp_create_nonce('routz_pickup_nonce'),
                    'apiUrl' => ROUTZ_API_URL,
                    'orgId' => $this->org_id,
                    'mapboxToken' => get_option('routz_mapbox_token', ''),
                    'i18n' => array(
                        'selectPoint' => __('Choisir ce point', 'routz-shipping'),
                        'selected' => __('Point sélectionné', 'routz-shipping'),
                        'search' => __('Rechercher', 'routz-shipping'),
                        'loading' => __('Chargement...', 'routz-shipping'),
                        'noResults' => __('Aucun point relais trouvé', 'routz-shipping')
                    )
                ));
            }
        }
        
        // Tracking page
        if (is_page(get_option('routz_tracking_page_id'))) {
            wp_enqueue_style(
                'routz-tracking',
                ROUTZ_PLUGIN_URL . 'assets/css/tracking.css',
                array(),
                ROUTZ_VERSION
            );
        }
    }

    /**
     * Display pickup point selector at checkout
     */
    public function display_pickup_selector() {
        if (get_option('routz_enable_pickup_points') !== 'yes') {
            return;
        }
        
        $chosen_methods = WC()->session->get('chosen_shipping_methods');
        
        // Check if a pickup point method is selected
        $show_selector = false;
        if ($chosen_methods) {
            foreach ($chosen_methods as $method) {
                if (strpos($method, 'routz_pickup') !== false || 
                    strpos($method, 'mondial_relay') !== false ||
                    strpos($method, 'colissimo_pickup') !== false) {
                    $show_selector = true;
                    break;
                }
            }
        }
        
        if (!$show_selector) {
            return;
        }
        
        // Get customer postal code
        $postal_code = WC()->customer->get_shipping_postcode();
        $country = WC()->customer->get_shipping_country() ?: 'FR';
        
        ?>
        <tr class="routz-pickup-selector-row">
            <th><?php _e('Point de retrait', 'routz-shipping'); ?></th>
            <td>
                <div id="routz-pickup-selector" 
                     data-postal-code="<?php echo esc_attr($postal_code); ?>"
                     data-country="<?php echo esc_attr($country); ?>">
                    
                    <div class="routz-pickup-search">
                        <input type="text" 
                               id="routz-pickup-search-input" 
                               placeholder="<?php _e('Code postal ou ville', 'routz-shipping'); ?>"
                               value="<?php echo esc_attr($postal_code); ?>">
                        <button type="button" id="routz-pickup-search-btn">
                            <?php _e('Rechercher', 'routz-shipping'); ?>
                        </button>
                    </div>
                    
                    <div id="routz-pickup-map" style="height: 300px; display: none;"></div>
                    
                    <div id="routz-pickup-list" class="routz-pickup-list"></div>
                    
                    <input type="hidden" name="routz_pickup_point_id" id="routz_pickup_point_id" value="">
                    <input type="hidden" name="routz_pickup_point_data" id="routz_pickup_point_data" value="">
                    
                    <div id="routz-selected-pickup" class="routz-selected-pickup" style="display: none;">
                        <strong><?php _e('Point sélectionné:', 'routz-shipping'); ?></strong>
                        <span id="routz-selected-pickup-name"></span>
                        <span id="routz-selected-pickup-address"></span>
                        <button type="button" id="routz-change-pickup">
                            <?php _e('Modifier', 'routz-shipping'); ?>
                        </button>
                    </div>
                </div>
            </td>
        </tr>
        <?php
    }

    /**
     * Save pickup point to order
     */
    public function save_pickup_point($order_id) {
        if (!empty($_POST['routz_pickup_point_id'])) {
            $order = wc_get_order($order_id);
            
            $pickup_point_id = sanitize_text_field($_POST['routz_pickup_point_id']);
            $pickup_point_data = sanitize_textarea_field($_POST['routz_pickup_point_data']);
            
            $order->update_meta_data('_routz_pickup_point_id', $pickup_point_id);
            $order->update_meta_data('_routz_pickup_point_data', $pickup_point_data);
            
            // Decode and save address
            $data = json_decode($pickup_point_data, true);
            if ($data) {
                $order->update_meta_data('_routz_pickup_name', $data['name']);
                $order->update_meta_data('_routz_pickup_address', $data['address']);
                $order->update_meta_data('_routz_pickup_city', $data['city']);
                $order->update_meta_data('_routz_pickup_postal_code', $data['postalCode']);
            }
            
            $order->save();
        }
    }

    /**
     * Sync order to Routz
     */
    public function sync_order_to_routz($order_id) {
        if (!$this->api_key || !$this->org_id) {
            return;
        }
        
        $order = wc_get_order($order_id);
        
        // Check if already synced
        if ($order->get_meta('_routz_order_id')) {
            return;
        }
        
        // Build order data
        $order_data = array(
            'external_id' => $order_id,
            'external_platform' => 'woocommerce',
            'order_number' => $order->get_order_number(),
            
            'customer_email' => $order->get_billing_email(),
            'customer_name' => $order->get_formatted_shipping_full_name(),
            'customer_phone' => $order->get_billing_phone(),
            
            'shipping_address' => array(
                'name' => $order->get_formatted_shipping_full_name(),
                'company' => $order->get_shipping_company(),
                'address1' => $order->get_shipping_address_1(),
                'address2' => $order->get_shipping_address_2(),
                'city' => $order->get_shipping_city(),
                'postalCode' => $order->get_shipping_postcode(),
                'country' => $order->get_shipping_country(),
                'phone' => $order->get_billing_phone()
            ),
            
            'items' => array(),
            
            'subtotal' => (float) $order->get_subtotal(),
            'shipping_cost' => (float) $order->get_shipping_total(),
            'total' => (float) $order->get_total(),
            'currency' => $order->get_currency(),
            
            'pickup_point' => array(
                'id' => $order->get_meta('_routz_pickup_point_id'),
                'data' => json_decode($order->get_meta('_routz_pickup_point_data'), true)
            )
        );
        
        // Add items
        foreach ($order->get_items() as $item) {
            $product = $item->get_product();
            
            $order_data['items'][] = array(
                'external_id' => $item->get_id(),
                'sku' => $product ? $product->get_sku() : '',
                'name' => $item->get_name(),
                'quantity' => $item->get_quantity(),
                'price' => (float) $item->get_total() / $item->get_quantity(),
                'weight' => $product ? (float) $product->get_weight() : 0
            );
        }
        
        // Send to Routz API
        $response = $this->api_request('POST', '/orders', $order_data);
        
        if ($response && isset($response['id'])) {
            $order->update_meta_data('_routz_order_id', $response['id']);
            $order->save();
            
            // Auto-create shipment if enabled
            if (get_option('routz_auto_create_shipment') === 'yes') {
                $this->create_shipment($order_id);
            }
        }
    }

    /**
     * Create shipment in Routz
     */
    public function create_shipment($order_id, $carrier = null, $service = null) {
        $order = wc_get_order($order_id);
        $routz_order_id = $order->get_meta('_routz_order_id');
        
        if (!$routz_order_id) {
            // Sync order first
            $this->sync_order_to_routz($order_id);
            $order = wc_get_order($order_id);
            $routz_order_id = $order->get_meta('_routz_order_id');
        }
        
        if (!$routz_order_id) {
            return false;
        }
        
        $shipment_data = array(
            'order_id' => $routz_order_id,
            'carrier' => $carrier ?: get_option('routz_default_carrier'),
            'service' => $service,
            'pickup_point_id' => $order->get_meta('_routz_pickup_point_id')
        );
        
        $response = $this->api_request('POST', '/shipments', $shipment_data);
        
        if ($response && isset($response['id'])) {
            global $wpdb;
            
            $wpdb->insert(
                $wpdb->prefix . 'routz_shipments',
                array(
                    'order_id' => $order_id,
                    'routz_shipment_id' => $response['id'],
                    'carrier' => $response['carrier'],
                    'service' => $response['service'],
                    'tracking_number' => $response['tracking_number'],
                    'label_url' => $response['label_url'],
                    'status' => $response['status']
                ),
                array('%d', '%s', '%s', '%s', '%s', '%s', '%s')
            );
            
            // Add tracking to order
            if (!empty($response['tracking_number'])) {
                $order->update_meta_data('_routz_tracking_number', $response['tracking_number']);
                $order->update_meta_data('_routz_carrier', $response['carrier']);
                $order->save();
                
                // Add order note
                $order->add_order_note(sprintf(
                    __('Expédition créée via Routz. Transporteur: %s, Suivi: %s', 'routz-shipping'),
                    $response['carrier'],
                    $response['tracking_number']
                ));
            }
            
            return $response;
        }
        
        return false;
    }

    /**
     * Display tracking info on order details
     */
    public function display_tracking_info($order) {
        $tracking_number = $order->get_meta('_routz_tracking_number');
        
        if (!$tracking_number) {
            return;
        }
        
        $carrier = $order->get_meta('_routz_carrier');
        $tracking_url = $this->get_tracking_url($tracking_number);
        
        ?>
        <h2><?php _e('Suivi de livraison', 'routz-shipping'); ?></h2>
        <table class="woocommerce-table routz-tracking-table">
            <tr>
                <th><?php _e('Transporteur', 'routz-shipping'); ?></th>
                <td><?php echo esc_html(ucfirst($carrier)); ?></td>
            </tr>
            <tr>
                <th><?php _e('Numéro de suivi', 'routz-shipping'); ?></th>
                <td>
                    <a href="<?php echo esc_url($tracking_url); ?>" target="_blank">
                        <?php echo esc_html($tracking_number); ?>
                    </a>
                </td>
            </tr>
        </table>
        
        <?php if (get_option('routz_enable_tracking_page') === 'yes'): ?>
        <div class="routz-tracking-widget">
            <iframe 
                src="<?php echo esc_url(ROUTZ_API_URL . '/widget/tracking/' . $tracking_number . '?embed=true'); ?>"
                width="100%" 
                height="400" 
                frameborder="0"
                style="border-radius: 12px; margin-top: 20px;">
            </iframe>
        </div>
        <?php endif; ?>
        <?php
    }

    /**
     * Add tracking to emails
     */
    public function add_tracking_to_email($order, $sent_to_admin, $plain_text) {
        $tracking_number = $order->get_meta('_routz_tracking_number');
        
        if (!$tracking_number) {
            return;
        }
        
        $carrier = $order->get_meta('_routz_carrier');
        $tracking_url = $this->get_tracking_url($tracking_number);
        
        if ($plain_text) {
            echo "\n\n" . __('Suivi de livraison', 'routz-shipping') . "\n";
            echo __('Transporteur:', 'routz-shipping') . ' ' . ucfirst($carrier) . "\n";
            echo __('Numéro de suivi:', 'routz-shipping') . ' ' . $tracking_number . "\n";
            echo __('Suivre mon colis:', 'routz-shipping') . ' ' . $tracking_url . "\n";
        } else {
            ?>
            <h2><?php _e('Suivi de livraison', 'routz-shipping'); ?></h2>
            <p>
                <strong><?php _e('Transporteur:', 'routz-shipping'); ?></strong> 
                <?php echo esc_html(ucfirst($carrier)); ?>
            </p>
            <p>
                <strong><?php _e('Numéro de suivi:', 'routz-shipping'); ?></strong>
                <a href="<?php echo esc_url($tracking_url); ?>"><?php echo esc_html($tracking_number); ?></a>
            </p>
            <p>
                <a href="<?php echo esc_url($tracking_url); ?>" 
                   style="display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px;">
                    <?php _e('Suivre mon colis', 'routz-shipping'); ?>
                </a>
            </p>
            <?php
        }
    }

    /**
     * Tracking shortcode
     */
    public function tracking_shortcode($atts) {
        $atts = shortcode_atts(array(
            'tracking' => isset($_GET['tracking']) ? sanitize_text_field($_GET['tracking']) : ''
        ), $atts);
        
        ob_start();
        include ROUTZ_PLUGIN_DIR . 'templates/tracking-page.php';
        return ob_get_clean();
    }

    /**
     * Returns shortcode
     */
    public function returns_shortcode($atts) {
        ob_start();
        include ROUTZ_PLUGIN_DIR . 'templates/returns-page.php';
        return ob_get_clean();
    }

    /**
     * Pickup map shortcode
     */
    public function pickup_map_shortcode($atts) {
        $atts = shortcode_atts(array(
            'postal_code' => '',
            'country' => 'FR',
            'carriers' => 'mondial_relay,colissimo'
        ), $atts);
        
        ob_start();
        include ROUTZ_PLUGIN_DIR . 'templates/pickup-map.php';
        return ob_get_clean();
    }

    /**
     * Handle webhooks from Routz
     */
    public function handle_webhook() {
        // Verify signature
        $signature = isset($_SERVER['HTTP_X_ROUTZ_SIGNATURE']) ? $_SERVER['HTTP_X_ROUTZ_SIGNATURE'] : '';
        $payload = file_get_contents('php://input');
        
        $expected_signature = hash_hmac('sha256', $payload, $this->api_key);
        
        if (!hash_equals($expected_signature, $signature)) {
            wp_send_json_error('Invalid signature', 401);
        }
        
        $data = json_decode($payload, true);
        
        if (!$data || !isset($data['event'])) {
            wp_send_json_error('Invalid payload', 400);
        }
        
        switch ($data['event']) {
            case 'shipment.tracking_updated':
                $this->handle_tracking_update($data['data']);
                break;
                
            case 'shipment.delivered':
                $this->handle_shipment_delivered($data['data']);
                break;
                
            case 'return.created':
                $this->handle_return_created($data['data']);
                break;
                
            case 'return.received':
                $this->handle_return_received($data['data']);
                break;
        }
        
        wp_send_json_success();
    }

    /**
     * Handle tracking update webhook
     */
    private function handle_tracking_update($data) {
        global $wpdb;
        
        $shipment = $wpdb->get_row($wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}routz_shipments WHERE routz_shipment_id = %s",
            $data['shipment_id']
        ));
        
        if (!$shipment) {
            return;
        }
        
        // Update shipment status
        $wpdb->update(
            $wpdb->prefix . 'routz_shipments',
            array('status' => $data['status']),
            array('id' => $shipment->id),
            array('%s'),
            array('%d')
        );
        
        // Add order note
        $order = wc_get_order($shipment->order_id);
        if ($order) {
            $order->add_order_note(sprintf(
                __('Mise à jour du suivi: %s', 'routz-shipping'),
                $data['status_label'] ?? $data['status']
            ));
        }
    }

    /**
     * Handle shipment delivered webhook
     */
    private function handle_shipment_delivered($data) {
        global $wpdb;
        
        $shipment = $wpdb->get_row($wpdb->prepare(
            "SELECT * FROM {$wpdb->prefix}routz_shipments WHERE routz_shipment_id = %s",
            $data['shipment_id']
        ));
        
        if (!$shipment) {
            return;
        }
        
        $order = wc_get_order($shipment->order_id);
        if ($order) {
            // Optionally complete the order
            if (get_option('routz_complete_on_delivery') === 'yes') {
                $order->update_status('completed', __('Colis livré (via Routz)', 'routz-shipping'));
            } else {
                $order->add_order_note(__('Colis livré', 'routz-shipping'));
            }
        }
    }

    /**
     * Handle return created webhook
     */
    private function handle_return_created($data) {
        $order = wc_get_order($data['order_id']);
        if ($order) {
            $order->add_order_note(sprintf(
                __('Demande de retour créée. RMA: %s', 'routz-shipping'),
                $data['rma_number']
            ));
            
            $order->update_meta_data('_routz_return_rma', $data['rma_number']);
            $order->save();
        }
    }

    /**
     * Handle return received webhook
     */
    private function handle_return_received($data) {
        $order = wc_get_order($data['order_id']);
        if ($order) {
            $order->add_order_note(sprintf(
                __('Retour reçu. RMA: %s. Remboursement: %s€', 'routz-shipping'),
                $data['rma_number'],
                $data['refund_amount']
            ));
            
            // Auto-refund if enabled
            if (get_option('routz_auto_refund') === 'yes' && $data['refund_amount'] > 0) {
                wc_create_refund(array(
                    'order_id' => $order->get_id(),
                    'amount' => $data['refund_amount'],
                    'reason' => sprintf(__('Retour %s', 'routz-shipping'), $data['rma_number'])
                ));
            }
        }
    }

    /**
     * Register REST routes
     */
    public function register_rest_routes() {
        register_rest_route('routz/v1', '/pickup-points', array(
            'methods' => 'GET',
            'callback' => array($this, 'rest_get_pickup_points'),
            'permission_callback' => '__return_true'
        ));
        
        register_rest_route('routz/v1', '/tracking/(?P<tracking>[a-zA-Z0-9]+)', array(
            'methods' => 'GET',
            'callback' => array($this, 'rest_get_tracking'),
            'permission_callback' => '__return_true'
        ));
    }

    /**
     * REST: Get pickup points
     */
    public function rest_get_pickup_points($request) {
        $postal_code = $request->get_param('postal_code');
        $country = $request->get_param('country') ?: 'FR';
        $carriers = $request->get_param('carriers') ?: array('mondial_relay', 'colissimo');
        
        $response = $this->api_request('POST', '/service-points/search', array(
            'postalCode' => $postal_code,
            'country' => $country,
            'carriers' => is_array($carriers) ? $carriers : explode(',', $carriers)
        ));
        
        return rest_ensure_response($response);
    }

    /**
     * REST: Get tracking info
     */
    public function rest_get_tracking($request) {
        $tracking = $request->get_param('tracking');
        
        $response = $this->api_request('GET', '/tracking/' . $tracking);
        
        return rest_ensure_response($response);
    }

    /**
     * Make API request to Routz
     */
    private function api_request($method, $endpoint, $data = null) {
        $url = ROUTZ_API_URL . $endpoint;
        
        $args = array(
            'method' => $method,
            'headers' => array(
                'Authorization' => 'Bearer ' . $this->api_key,
                'Content-Type' => 'application/json',
                'X-Org-Id' => $this->org_id
            ),
            'timeout' => 30
        );
        
        if ($data !== null) {
            $args['body'] = json_encode($data);
        }
        
        $response = wp_remote_request($url, $args);
        
        if (is_wp_error($response)) {
            error_log('Routz API Error: ' . $response->get_error_message());
            return null;
        }
        
        $body = wp_remote_retrieve_body($response);
        return json_decode($body, true);
    }

    /**
     * Get tracking URL
     */
    private function get_tracking_url($tracking_number) {
        $tracking_page_id = get_option('routz_tracking_page_id');
        
        if ($tracking_page_id && get_option('routz_enable_tracking_page') === 'yes') {
            return add_query_arg('tracking', $tracking_number, get_permalink($tracking_page_id));
        }
        
        return ROUTZ_API_URL . '/t/' . $tracking_number;
    }

    /**
     * Declare HPOS compatibility
     */
    public function declare_hpos_compatibility() {
        if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
            \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
                'custom_order_tables',
                __FILE__,
                true
            );
        }
    }
}

// Initialize
function routz_shipping() {
    return Routz_Shipping::get_instance();
}

// Start plugin
add_action('plugins_loaded', function() {
    if (class_exists('WooCommerce')) {
        routz_shipping();
    }
});
