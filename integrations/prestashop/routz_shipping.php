<?php
/**
 * Routz Shipping Module for PrestaShop
 * Version: 1.0.0
 * Compatible: PrestaShop 1.7.x - 8.x
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

require_once dirname(__FILE__) . '/classes/RoutzApi.php';
require_once dirname(__FILE__) . '/classes/RoutzCarrier.php';
require_once dirname(__FILE__) . '/classes/RoutzPickupPoint.php';

class Routz_Shipping extends CarrierModule
{
    /**
     * Module configuration
     */
    public $id_carrier;
    
    /**
     * Routz API instance
     */
    private $api;
    
    /**
     * Supported carriers
     */
    private $routzCarriers = [
        'colissimo' => [
            'name' => 'Colissimo',
            'delay' => '2-4 jours ouvrés',
            'services' => ['home', 'pickup']
        ],
        'chronopost' => [
            'name' => 'Chronopost',
            'delay' => '24-48h',
            'services' => ['13h', '18h', 'relais']
        ],
        'mondial_relay' => [
            'name' => 'Mondial Relay',
            'delay' => '3-6 jours ouvrés',
            'services' => ['standard', 'home']
        ],
        'dpd' => [
            'name' => 'DPD',
            'delay' => '2-4 jours ouvrés',
            'services' => ['classic', 'predict', 'relais']
        ],
        'gls' => [
            'name' => 'GLS',
            'delay' => '2-4 jours ouvrés',
            'services' => ['business', 'shop']
        ]
    ];

    /**
     * Constructor
     */
    public function __construct()
    {
        $this->name = 'routz_shipping';
        $this->tab = 'shipping_logistics';
        $this->version = '1.0.0';
        $this->author = 'Routz';
        $this->need_instance = 0;
        $this->ps_versions_compliancy = [
            'min' => '1.7.0.0',
            'max' => '8.99.99'
        ];
        $this->bootstrap = true;

        parent::__construct();

        $this->displayName = $this->l('Routz Shipping');
        $this->description = $this->l('Solution d\'expédition multi-transporteurs avec points relais, tracking et retours.');
        $this->confirmUninstall = $this->l('Êtes-vous sûr de vouloir désinstaller ce module ?');

        // Initialize API
        if (Configuration::get('ROUTZ_API_KEY')) {
            $this->api = new RoutzApi(
                Configuration::get('ROUTZ_API_KEY'),
                Configuration::get('ROUTZ_ORG_ID')
            );
        }
    }

    /**
     * Install module
     */
    public function install()
    {
        if (!parent::install()) {
            return false;
        }

        // Create database tables
        if (!$this->createTables()) {
            return false;
        }

        // Register hooks
        $hooks = [
            'header',
            'displayCarrierExtraContent',
            'actionValidateOrder',
            'actionOrderStatusUpdate',
            'displayOrderDetail',
            'displayAdminOrderMain',
            'displayAdminOrderSide',
            'actionAdminOrdersTrackingNumberUpdate',
            'displayPDFInvoice',
            'moduleRoutes'
        ];

        foreach ($hooks as $hook) {
            if (!$this->registerHook($hook)) {
                return false;
            }
        }

        // Create carriers
        if (!$this->createCarriers()) {
            return false;
        }

        // Default configuration
        Configuration::updateValue('ROUTZ_API_KEY', '');
        Configuration::updateValue('ROUTZ_ORG_ID', '');
        Configuration::updateValue('ROUTZ_ENABLE_PICKUP', 1);
        Configuration::updateValue('ROUTZ_ENABLE_TRACKING', 1);
        Configuration::updateValue('ROUTZ_ENABLE_RETURNS', 1);
        Configuration::updateValue('ROUTZ_AUTO_SYNC', 1);
        Configuration::updateValue('ROUTZ_MAPBOX_TOKEN', '');

        return true;
    }

    /**
     * Uninstall module
     */
    public function uninstall()
    {
        // Remove carriers
        $this->removeCarriers();

        // Remove configuration
        $configs = [
            'ROUTZ_API_KEY',
            'ROUTZ_ORG_ID',
            'ROUTZ_ENABLE_PICKUP',
            'ROUTZ_ENABLE_TRACKING',
            'ROUTZ_ENABLE_RETURNS',
            'ROUTZ_AUTO_SYNC',
            'ROUTZ_MAPBOX_TOKEN'
        ];

        foreach ($configs as $config) {
            Configuration::deleteByName($config);
        }

        // Remove carrier IDs
        foreach ($this->routzCarriers as $code => $carrier) {
            Configuration::deleteByName('ROUTZ_CARRIER_' . strtoupper($code));
        }

        return parent::uninstall();
    }

    /**
     * Create database tables
     */
    private function createTables()
    {
        $sql = [];

        // Shipments table
        $sql[] = 'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'routz_shipments` (
            `id_routz_shipment` int(11) unsigned NOT NULL AUTO_INCREMENT,
            `id_order` int(11) unsigned NOT NULL,
            `routz_shipment_id` varchar(50) DEFAULT NULL,
            `carrier_code` varchar(50) DEFAULT NULL,
            `service` varchar(50) DEFAULT NULL,
            `tracking_number` varchar(100) DEFAULT NULL,
            `label_url` varchar(500) DEFAULT NULL,
            `status` varchar(50) DEFAULT "pending",
            `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
            `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id_routz_shipment`),
            KEY `id_order` (`id_order`),
            KEY `tracking_number` (`tracking_number`)
        ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8;';

        // Pickup points table
        $sql[] = 'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'routz_pickup_points` (
            `id_routz_pickup` int(11) unsigned NOT NULL AUTO_INCREMENT,
            `id_cart` int(11) unsigned NOT NULL,
            `id_order` int(11) unsigned DEFAULT NULL,
            `carrier_code` varchar(50) NOT NULL,
            `point_id` varchar(100) NOT NULL,
            `point_name` varchar(255) DEFAULT NULL,
            `point_address` text DEFAULT NULL,
            `point_city` varchar(100) DEFAULT NULL,
            `point_postal_code` varchar(20) DEFAULT NULL,
            `point_country` varchar(2) DEFAULT NULL,
            `point_data` text DEFAULT NULL,
            `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id_routz_pickup`),
            KEY `id_cart` (`id_cart`),
            KEY `id_order` (`id_order`)
        ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8;';

        // Returns table
        $sql[] = 'CREATE TABLE IF NOT EXISTS `' . _DB_PREFIX_ . 'routz_returns` (
            `id_routz_return` int(11) unsigned NOT NULL AUTO_INCREMENT,
            `id_order` int(11) unsigned NOT NULL,
            `routz_return_id` varchar(50) DEFAULT NULL,
            `rma_number` varchar(50) DEFAULT NULL,
            `status` varchar(50) DEFAULT "pending",
            `refund_amount` decimal(10,2) DEFAULT NULL,
            `return_label_url` varchar(500) DEFAULT NULL,
            `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
            `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id_routz_return`),
            KEY `id_order` (`id_order`),
            KEY `rma_number` (`rma_number`)
        ) ENGINE=' . _MYSQL_ENGINE_ . ' DEFAULT CHARSET=utf8;';

        foreach ($sql as $query) {
            if (!Db::getInstance()->execute($query)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Create carriers
     */
    private function createCarriers()
    {
        foreach ($this->routzCarriers as $code => $config) {
            // Create main carrier
            $carrier = new Carrier();
            $carrier->name = $config['name'];
            $carrier->active = true;
            $carrier->deleted = false;
            $carrier->shipping_handling = false;
            $carrier->range_behavior = 0;
            $carrier->is_module = true;
            $carrier->shipping_external = true;
            $carrier->external_module_name = $this->name;
            $carrier->need_range = true;

            // Multilingual delay
            $languages = Language::getLanguages(true);
            foreach ($languages as $lang) {
                $carrier->delay[$lang['id_lang']] = $config['delay'];
            }

            if (!$carrier->add()) {
                return false;
            }

            // Store carrier ID
            Configuration::updateValue('ROUTZ_CARRIER_' . strtoupper($code), (int) $carrier->id);

            // Associate with groups
            $groups = Group::getGroups(true);
            foreach ($groups as $group) {
                Db::getInstance()->insert('carrier_group', [
                    'id_carrier' => (int) $carrier->id,
                    'id_group' => (int) $group['id_group']
                ]);
            }

            // Add zones and ranges
            $zones = Zone::getZones(true);
            foreach ($zones as $zone) {
                Db::getInstance()->insert('carrier_zone', [
                    'id_carrier' => (int) $carrier->id,
                    'id_zone' => (int) $zone['id_zone']
                ]);
            }

            // Create weight range
            $range = new RangeWeight();
            $range->id_carrier = $carrier->id;
            $range->delimiter1 = 0;
            $range->delimiter2 = 30;
            $range->add();

            // Set shipping costs (will be calculated dynamically)
            foreach ($zones as $zone) {
                Db::getInstance()->insert('delivery', [
                    'id_carrier' => (int) $carrier->id,
                    'id_range_weight' => (int) $range->id,
                    'id_zone' => (int) $zone['id_zone'],
                    'price' => 0
                ]);
            }

            // Copy logo
            $logoSource = dirname(__FILE__) . '/views/img/carriers/' . $code . '.png';
            if (file_exists($logoSource)) {
                copy($logoSource, _PS_SHIP_IMG_DIR_ . $carrier->id . '.jpg');
            }
        }

        return true;
    }

    /**
     * Remove carriers
     */
    private function removeCarriers()
    {
        foreach ($this->routzCarriers as $code => $config) {
            $carrierId = Configuration::get('ROUTZ_CARRIER_' . strtoupper($code));
            if ($carrierId) {
                $carrier = new Carrier($carrierId);
                $carrier->deleted = true;
                $carrier->save();
            }
        }
    }

    /**
     * Module configuration page
     */
    public function getContent()
    {
        $output = '';

        // Handle form submission
        if (Tools::isSubmit('submitRoutzConfig')) {
            Configuration::updateValue('ROUTZ_API_KEY', Tools::getValue('ROUTZ_API_KEY'));
            Configuration::updateValue('ROUTZ_ORG_ID', Tools::getValue('ROUTZ_ORG_ID'));
            Configuration::updateValue('ROUTZ_ENABLE_PICKUP', (int) Tools::getValue('ROUTZ_ENABLE_PICKUP'));
            Configuration::updateValue('ROUTZ_ENABLE_TRACKING', (int) Tools::getValue('ROUTZ_ENABLE_TRACKING'));
            Configuration::updateValue('ROUTZ_ENABLE_RETURNS', (int) Tools::getValue('ROUTZ_ENABLE_RETURNS'));
            Configuration::updateValue('ROUTZ_AUTO_SYNC', (int) Tools::getValue('ROUTZ_AUTO_SYNC'));
            Configuration::updateValue('ROUTZ_MAPBOX_TOKEN', Tools::getValue('ROUTZ_MAPBOX_TOKEN'));

            $output .= $this->displayConfirmation($this->l('Configuration sauvegardée'));

            // Reinitialize API
            $this->api = new RoutzApi(
                Configuration::get('ROUTZ_API_KEY'),
                Configuration::get('ROUTZ_ORG_ID')
            );
        }

        // Test connection
        if (Tools::isSubmit('testRoutzConnection')) {
            if ($this->api && $this->api->testConnection()) {
                $output .= $this->displayConfirmation($this->l('Connexion à Routz réussie !'));
            } else {
                $output .= $this->displayError($this->l('Échec de la connexion. Vérifiez vos identifiants.'));
            }
        }

        return $output . $this->renderConfigForm();
    }

    /**
     * Render configuration form
     */
    private function renderConfigForm()
    {
        $fields = [
            'form' => [
                'legend' => [
                    'title' => $this->l('Configuration Routz'),
                    'icon' => 'icon-cogs'
                ],
                'input' => [
                    [
                        'type' => 'text',
                        'label' => $this->l('Clé API'),
                        'name' => 'ROUTZ_API_KEY',
                        'desc' => $this->l('Votre clé API Routz (disponible dans votre dashboard)'),
                        'required' => true
                    ],
                    [
                        'type' => 'text',
                        'label' => $this->l('ID Organisation'),
                        'name' => 'ROUTZ_ORG_ID',
                        'desc' => $this->l('Votre identifiant organisation Routz'),
                        'required' => true
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Activer les points relais'),
                        'name' => 'ROUTZ_ENABLE_PICKUP',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'on', 'value' => 1, 'label' => $this->l('Oui')],
                            ['id' => 'off', 'value' => 0, 'label' => $this->l('Non')]
                        ]
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Activer le tracking'),
                        'name' => 'ROUTZ_ENABLE_TRACKING',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'on', 'value' => 1, 'label' => $this->l('Oui')],
                            ['id' => 'off', 'value' => 0, 'label' => $this->l('Non')]
                        ]
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Activer les retours'),
                        'name' => 'ROUTZ_ENABLE_RETURNS',
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'on', 'value' => 1, 'label' => $this->l('Oui')],
                            ['id' => 'off', 'value' => 0, 'label' => $this->l('Non')]
                        ]
                    ],
                    [
                        'type' => 'switch',
                        'label' => $this->l('Synchronisation automatique'),
                        'name' => 'ROUTZ_AUTO_SYNC',
                        'desc' => $this->l('Synchroniser automatiquement les commandes avec Routz'),
                        'is_bool' => true,
                        'values' => [
                            ['id' => 'on', 'value' => 1, 'label' => $this->l('Oui')],
                            ['id' => 'off', 'value' => 0, 'label' => $this->l('Non')]
                        ]
                    ],
                    [
                        'type' => 'text',
                        'label' => $this->l('Token Mapbox'),
                        'name' => 'ROUTZ_MAPBOX_TOKEN',
                        'desc' => $this->l('Pour afficher la carte des points relais (optionnel)')
                    ]
                ],
                'submit' => [
                    'title' => $this->l('Sauvegarder'),
                    'class' => 'btn btn-primary'
                ],
                'buttons' => [
                    [
                        'href' => AdminController::$currentIndex . '&configure=' . $this->name . '&testRoutzConnection&token=' . Tools::getAdminTokenLite('AdminModules'),
                        'title' => $this->l('Tester la connexion'),
                        'icon' => 'process-icon-refresh'
                    ]
                ]
            ]
        ];

        $helper = new HelperForm();
        $helper->module = $this;
        $helper->identifier = $this->identifier;
        $helper->submit_action = 'submitRoutzConfig';
        $helper->currentIndex = $this->context->link->getAdminLink('AdminModules', false) . '&configure=' . $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->tpl_vars = [
            'fields_value' => [
                'ROUTZ_API_KEY' => Configuration::get('ROUTZ_API_KEY'),
                'ROUTZ_ORG_ID' => Configuration::get('ROUTZ_ORG_ID'),
                'ROUTZ_ENABLE_PICKUP' => Configuration::get('ROUTZ_ENABLE_PICKUP'),
                'ROUTZ_ENABLE_TRACKING' => Configuration::get('ROUTZ_ENABLE_TRACKING'),
                'ROUTZ_ENABLE_RETURNS' => Configuration::get('ROUTZ_ENABLE_RETURNS'),
                'ROUTZ_AUTO_SYNC' => Configuration::get('ROUTZ_AUTO_SYNC'),
                'ROUTZ_MAPBOX_TOKEN' => Configuration::get('ROUTZ_MAPBOX_TOKEN')
            ]
        ];

        return $helper->generateForm([$fields]);
    }

    /**
     * Get shipping cost
     */
    public function getOrderShippingCost($params, $shipping_cost)
    {
        if (!$this->api) {
            return false;
        }

        $cart = $params;
        $address = new Address($cart->id_address_delivery);
        
        if (!Validate::isLoadedObject($address)) {
            return false;
        }

        // Get carrier code from carrier ID
        $carrierCode = $this->getCarrierCode($this->id_carrier);
        if (!$carrierCode) {
            return false;
        }

        // Calculate total weight
        $weight = $cart->getTotalWeight();
        if ($weight == 0) {
            $weight = 0.5; // Default weight
        }

        // Get cart value
        $cartValue = $cart->getOrderTotal(true, Cart::ONLY_PRODUCTS);

        try {
            // Get rate from Routz API
            $rate = $this->api->getRate([
                'carrier' => $carrierCode,
                'country' => Country::getIsoById($address->id_country),
                'postalCode' => $address->postcode,
                'weight' => $weight,
                'cartValue' => $cartValue
            ]);

            if ($rate && isset($rate['finalRate'])) {
                return (float) $rate['finalRate'];
            }
        } catch (Exception $e) {
            PrestaShopLogger::addLog(
                'Routz rate error: ' . $e->getMessage(),
                3,
                null,
                'Cart',
                $cart->id
            );
        }

        return $shipping_cost;
    }

    /**
     * Get shipping cost external (required for external carrier)
     */
    public function getOrderShippingCostExternal($params)
    {
        return $this->getOrderShippingCost($params, 0);
    }

    /**
     * Display carrier extra content (pickup points)
     */
    public function hookDisplayCarrierExtraContent($params)
    {
        if (!Configuration::get('ROUTZ_ENABLE_PICKUP')) {
            return '';
        }

        $carrier = new Carrier($params['carrier']['id']);
        $carrierCode = $this->getCarrierCode($carrier->id);

        // Check if this carrier supports pickup points
        if (!$carrierCode || !in_array('pickup', $this->routzCarriers[$carrierCode]['services'] ?? [])) {
            return '';
        }

        // Get delivery address
        $address = new Address($this->context->cart->id_address_delivery);
        
        $this->context->smarty->assign([
            'carrierCode' => $carrierCode,
            'postalCode' => $address->postcode,
            'country' => Country::getIsoById($address->id_country),
            'mapboxToken' => Configuration::get('ROUTZ_MAPBOX_TOKEN'),
            'apiUrl' => RoutzApi::API_URL,
            'orgId' => Configuration::get('ROUTZ_ORG_ID')
        ]);

        return $this->display(__FILE__, 'views/templates/hook/pickup-selector.tpl');
    }

    /**
     * Hook: Validate order - sync to Routz
     */
    public function hookActionValidateOrder($params)
    {
        if (!Configuration::get('ROUTZ_AUTO_SYNC') || !$this->api) {
            return;
        }

        $order = $params['order'];
        
        // Sync order to Routz
        $this->syncOrderToRoutz($order);
    }

    /**
     * Sync order to Routz
     */
    public function syncOrderToRoutz($order)
    {
        if (!$this->api) {
            return false;
        }

        $customer = new Customer($order->id_customer);
        $addressDelivery = new Address($order->id_address_delivery);
        $country = new Country($addressDelivery->id_country);

        // Get carrier code
        $carrierCode = $this->getCarrierCode($order->id_carrier);

        // Build order data
        $orderData = [
            'external_id' => $order->id,
            'external_platform' => 'prestashop',
            'order_number' => $order->reference,
            
            'customer_email' => $customer->email,
            'customer_name' => $addressDelivery->firstname . ' ' . $addressDelivery->lastname,
            'customer_phone' => $addressDelivery->phone ?: $addressDelivery->phone_mobile,
            
            'shipping_address' => [
                'name' => $addressDelivery->firstname . ' ' . $addressDelivery->lastname,
                'company' => $addressDelivery->company,
                'address1' => $addressDelivery->address1,
                'address2' => $addressDelivery->address2,
                'city' => $addressDelivery->city,
                'postalCode' => $addressDelivery->postcode,
                'country' => $country->iso_code,
                'phone' => $addressDelivery->phone ?: $addressDelivery->phone_mobile
            ],
            
            'items' => [],
            
            'subtotal' => (float) $order->total_products_wt,
            'shipping_cost' => (float) $order->total_shipping,
            'total' => (float) $order->total_paid,
            'currency' => Currency::getCurrencyInstance($order->id_currency)->iso_code,
            
            'carrier' => $carrierCode
        ];

        // Add items
        $products = $order->getProducts();
        foreach ($products as $product) {
            $orderData['items'][] = [
                'external_id' => $product['id_order_detail'],
                'sku' => $product['reference'],
                'name' => $product['product_name'],
                'quantity' => (int) $product['product_quantity'],
                'price' => (float) $product['unit_price_tax_incl'],
                'weight' => (float) $product['weight']
            ];
        }

        // Get pickup point if selected
        $pickupPoint = $this->getOrderPickupPoint($order->id);
        if ($pickupPoint) {
            $orderData['pickup_point'] = [
                'id' => $pickupPoint['point_id'],
                'carrier' => $pickupPoint['carrier_code'],
                'data' => json_decode($pickupPoint['point_data'], true)
            ];
        }

        try {
            $response = $this->api->createOrder($orderData);
            
            if ($response && isset($response['id'])) {
                // Store Routz order ID
                Db::getInstance()->insert('routz_shipments', [
                    'id_order' => (int) $order->id,
                    'routz_shipment_id' => pSQL($response['id']),
                    'carrier_code' => pSQL($carrierCode),
                    'status' => 'synced'
                ]);
                
                return $response;
            }
        } catch (Exception $e) {
            PrestaShopLogger::addLog(
                'Routz sync error: ' . $e->getMessage(),
                3,
                null,
                'Order',
                $order->id
            );
        }

        return false;
    }

    /**
     * Display tracking on order detail
     */
    public function hookDisplayOrderDetail($params)
    {
        if (!Configuration::get('ROUTZ_ENABLE_TRACKING')) {
            return '';
        }

        $order = $params['order'];
        
        // Get shipment info
        $shipment = Db::getInstance()->getRow(
            'SELECT * FROM `' . _DB_PREFIX_ . 'routz_shipments` WHERE `id_order` = ' . (int) $order->id
        );

        if (!$shipment || !$shipment['tracking_number']) {
            return '';
        }

        $this->context->smarty->assign([
            'tracking_number' => $shipment['tracking_number'],
            'carrier_code' => $shipment['carrier_code'],
            'tracking_url' => RoutzApi::API_URL . '/t/' . $shipment['tracking_number'],
            'enable_widget' => true
        ]);

        return $this->display(__FILE__, 'views/templates/hook/order-tracking.tpl');
    }

    /**
     * Admin order main hook
     */
    public function hookDisplayAdminOrderMain($params)
    {
        $order = new Order($params['id_order']);
        
        // Get shipment info
        $shipment = Db::getInstance()->getRow(
            'SELECT * FROM `' . _DB_PREFIX_ . 'routz_shipments` WHERE `id_order` = ' . (int) $order->id
        );

        // Get pickup point
        $pickupPoint = $this->getOrderPickupPoint($order->id);

        $this->context->smarty->assign([
            'order' => $order,
            'shipment' => $shipment,
            'pickupPoint' => $pickupPoint,
            'carriers' => $this->routzCarriers,
            'module_url' => $this->context->link->getAdminLink('AdminModules') . '&configure=' . $this->name
        ]);

        return $this->display(__FILE__, 'views/templates/admin/order-main.tpl');
    }

    /**
     * Get order pickup point
     */
    private function getOrderPickupPoint($orderId)
    {
        return Db::getInstance()->getRow(
            'SELECT * FROM `' . _DB_PREFIX_ . 'routz_pickup_points` WHERE `id_order` = ' . (int) $orderId
        );
    }

    /**
     * Get carrier code from carrier ID
     */
    private function getCarrierCode($carrierId)
    {
        foreach ($this->routzCarriers as $code => $config) {
            if (Configuration::get('ROUTZ_CARRIER_' . strtoupper($code)) == $carrierId) {
                return $code;
            }
        }
        return null;
    }

    /**
     * Module routes
     */
    public function hookModuleRoutes()
    {
        return [
            'module-routz_shipping-tracking' => [
                'controller' => 'tracking',
                'rule' => 'suivi/{tracking}',
                'keywords' => [
                    'tracking' => ['regexp' => '[a-zA-Z0-9]+', 'param' => 'tracking']
                ],
                'params' => [
                    'fc' => 'module',
                    'module' => 'routz_shipping'
                ]
            ],
            'module-routz_shipping-returns' => [
                'controller' => 'returns',
                'rule' => 'retours',
                'keywords' => [],
                'params' => [
                    'fc' => 'module',
                    'module' => 'routz_shipping'
                ]
            ],
            'module-routz_shipping-webhook' => [
                'controller' => 'webhook',
                'rule' => 'routz-webhook',
                'keywords' => [],
                'params' => [
                    'fc' => 'module',
                    'module' => 'routz_shipping'
                ]
            ]
        ];
    }
}
