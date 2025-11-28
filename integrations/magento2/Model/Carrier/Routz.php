<?php
/**
 * Routz Shipping Extension for Magento 2
 * Main Carrier Model
 */

declare(strict_types=1);

namespace Routz\Shipping\Model\Carrier;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\DataObject;
use Magento\Quote\Model\Quote\Address\RateRequest;
use Magento\Quote\Model\Quote\Address\RateResult\ErrorFactory;
use Magento\Quote\Model\Quote\Address\RateResult\MethodFactory;
use Magento\Shipping\Model\Carrier\AbstractCarrier;
use Magento\Shipping\Model\Carrier\CarrierInterface;
use Magento\Shipping\Model\Rate\ResultFactory;
use Psr\Log\LoggerInterface;
use Routz\Shipping\Model\Api\Client as RoutzClient;

class Routz extends AbstractCarrier implements CarrierInterface
{
    /**
     * Carrier code
     */
    protected $_code = 'routz';

    /**
     * @var bool
     */
    protected $_isFixed = false;

    /**
     * @var ResultFactory
     */
    protected $rateResultFactory;

    /**
     * @var MethodFactory
     */
    protected $rateMethodFactory;

    /**
     * @var RoutzClient
     */
    protected $routzClient;

    /**
     * Supported carriers and services
     */
    protected $carriers = [
        'colissimo' => [
            'title' => 'Colissimo',
            'services' => [
                'home' => 'Domicile',
                'signature' => 'Domicile avec signature',
                'pickup' => 'Point Retrait'
            ]
        ],
        'chronopost' => [
            'title' => 'Chronopost',
            'services' => [
                '13h' => 'Chronopost 13h',
                '18h' => 'Chronopost 18h',
                'relais' => 'Chronopost Relais'
            ]
        ],
        'mondial_relay' => [
            'title' => 'Mondial Relay',
            'services' => [
                'standard' => 'Point Relais',
                'home' => 'Domicile'
            ]
        ],
        'dpd' => [
            'title' => 'DPD',
            'services' => [
                'classic' => 'DPD Classic',
                'predict' => 'DPD Predict',
                'relais' => 'DPD Relais'
            ]
        ],
        'gls' => [
            'title' => 'GLS',
            'services' => [
                'business' => 'GLS Business',
                'shop' => 'GLS Shop Delivery'
            ]
        ]
    ];

    /**
     * Constructor
     */
    public function __construct(
        ScopeConfigInterface $scopeConfig,
        ErrorFactory $rateErrorFactory,
        LoggerInterface $logger,
        ResultFactory $rateResultFactory,
        MethodFactory $rateMethodFactory,
        RoutzClient $routzClient,
        array $data = []
    ) {
        $this->rateResultFactory = $rateResultFactory;
        $this->rateMethodFactory = $rateMethodFactory;
        $this->routzClient = $routzClient;
        parent::__construct($scopeConfig, $rateErrorFactory, $logger, $data);
    }

    /**
     * Get allowed methods
     */
    public function getAllowedMethods(): array
    {
        $methods = [];
        
        foreach ($this->carriers as $carrierCode => $carrier) {
            foreach ($carrier['services'] as $serviceCode => $serviceTitle) {
                $methodCode = $carrierCode . '_' . $serviceCode;
                $methods[$methodCode] = $carrier['title'] . ' - ' . $serviceTitle;
            }
        }
        
        return $methods;
    }

    /**
     * Collect shipping rates
     */
    public function collectRates(RateRequest $request)
    {
        if (!$this->getConfigFlag('active')) {
            return false;
        }

        $result = $this->rateResultFactory->create();

        // Get destination info
        $destCountry = $request->getDestCountryId();
        $destPostcode = $request->getDestPostcode();
        $destCity = $request->getDestCity();

        // Calculate weight
        $weight = $request->getPackageWeight();
        if ($weight <= 0) {
            $weight = 0.5;
        }

        // Get cart value
        $cartValue = $request->getPackageValueWithDiscount();

        // Get enabled carriers
        $enabledCarriers = $this->getConfigData('enabled_carriers');
        $enabledCarriers = $enabledCarriers ? explode(',', $enabledCarriers) : array_keys($this->carriers);

        try {
            // Get rates from Routz API
            $rates = $this->routzClient->getShippingOptions([
                'country' => $destCountry,
                'postalCode' => $destPostcode,
                'city' => $destCity,
                'weight' => $weight,
                'cartValue' => $cartValue,
                'carriers' => $enabledCarriers
            ]);

            if ($rates && isset($rates['allOptions'])) {
                foreach ($rates['allOptions'] as $option) {
                    $methodCode = $option['carrier'] . '_' . $option['serviceId'];
                    
                    // Check if method is enabled
                    if (!$this->isMethodEnabled($option['carrier'])) {
                        continue;
                    }

                    $method = $this->rateMethodFactory->create();
                    $method->setCarrier($this->_code);
                    $method->setCarrierTitle($this->getConfigData('title') ?: 'Routz');
                    $method->setMethod($methodCode);
                    $method->setMethodTitle($option['serviceName']);
                    $method->setPrice($option['price']);
                    $method->setCost($option['price']);

                    // Add delivery time info
                    if (isset($option['deliveryDays'])) {
                        $method->setMethodDescription(sprintf(
                            __('Livraison en %s'),
                            $option['deliveryDays']['formatted'] ?? ($option['deliveryDays']['min'] . '-' . $option['deliveryDays']['max'] . ' jours')
                        ));
                    }

                    $result->append($method);
                }
            }
        } catch (\Exception $e) {
            $this->_logger->error('Routz rate error: ' . $e->getMessage());
            
            // Fallback to configured flat rates
            $result = $this->getFallbackRates($result, $request);
        }

        // If no rates, add error
        if (!$result->getAllRates()) {
            $error = $this->_rateErrorFactory->create();
            $error->setCarrier($this->_code);
            $error->setCarrierTitle($this->getConfigData('title'));
            $error->setErrorMessage($this->getConfigData('specificerrmsg') ?: __('Shipping unavailable'));
            $result->append($error);
        }

        return $result;
    }

    /**
     * Get fallback rates when API is unavailable
     */
    protected function getFallbackRates($result, RateRequest $request)
    {
        $fallbackPrice = (float) $this->getConfigData('fallback_price') ?: 6.99;
        
        $method = $this->rateMethodFactory->create();
        $method->setCarrier($this->_code);
        $method->setCarrierTitle($this->getConfigData('title') ?: 'Routz');
        $method->setMethod('standard');
        $method->setMethodTitle(__('Livraison Standard'));
        $method->setPrice($fallbackPrice);
        $method->setCost($fallbackPrice);
        
        $result->append($method);
        
        return $result;
    }

    /**
     * Check if carrier is enabled
     */
    protected function isMethodEnabled(string $carrier): bool
    {
        $enabledCarriers = $this->getConfigData('enabled_carriers');
        if (!$enabledCarriers) {
            return true;
        }
        
        $enabled = explode(',', $enabledCarriers);
        return in_array($carrier, $enabled);
    }

    /**
     * Check if tracking available
     */
    public function isTrackingAvailable(): bool
    {
        return true;
    }

    /**
     * Get tracking info
     */
    public function getTrackingInfo($tracking)
    {
        $result = $this->getTracking($tracking);
        
        if ($result instanceof \Magento\Shipping\Model\Tracking\Result) {
            $trackings = $result->getAllTrackings();
            if ($trackings) {
                return $trackings[0];
            }
        }
        
        return false;
    }

    /**
     * Get tracking
     */
    public function getTracking($trackingNumber)
    {
        $result = $this->_trackFactory->create();

        try {
            $trackingData = $this->routzClient->getTracking($trackingNumber);
            
            if ($trackingData) {
                $tracking = $this->_trackStatusFactory->create();
                $tracking->setCarrier($this->_code);
                $tracking->setCarrierTitle($this->getConfigData('title'));
                $tracking->setTracking($trackingNumber);
                $tracking->setTrackSummary($trackingData['status'] ?? 'In Transit');
                
                // Add tracking URL
                $trackingUrl = $this->routzClient->getTrackingUrl($trackingNumber);
                $tracking->setUrl($trackingUrl);
                
                // Add events
                if (isset($trackingData['events'])) {
                    $progressDetail = [];
                    foreach ($trackingData['events'] as $event) {
                        $progressDetail[] = [
                            'deliverydate' => $event['date'] ?? '',
                            'deliverytime' => $event['time'] ?? '',
                            'deliverylocation' => $event['location'] ?? '',
                            'activity' => $event['description'] ?? ''
                        ];
                    }
                    $tracking->setProgressdetail($progressDetail);
                }
                
                $result->append($tracking);
            }
        } catch (\Exception $e) {
            $this->_logger->error('Routz tracking error: ' . $e->getMessage());
        }

        return $result;
    }

    /**
     * Process shipment request
     */
    public function requestToShipment($request)
    {
        $packages = $request->getPackages();
        $result = new DataObject();
        
        if (!is_array($packages) || !$packages) {
            $result->setErrors(__('No packages for request'));
            return $result;
        }

        $data = [];
        
        foreach ($packages as $packageId => $package) {
            try {
                // Create shipment via Routz API
                $shipmentData = [
                    'order_id' => $request->getOrderShipment()->getOrderId(),
                    'carrier' => $this->getCarrierFromMethod($request->getShippingMethod()),
                    'service' => $this->getServiceFromMethod($request->getShippingMethod()),
                    'weight' => $package['params']['weight'] ?? null,
                    'recipient' => [
                        'name' => $request->getRecipientContactPersonName(),
                        'company' => $request->getRecipientContactCompanyName(),
                        'address1' => $request->getRecipientAddressStreet1(),
                        'address2' => $request->getRecipientAddressStreet2(),
                        'city' => $request->getRecipientAddressCity(),
                        'postalCode' => $request->getRecipientAddressPostalCode(),
                        'country' => $request->getRecipientAddressCountryCode(),
                        'phone' => $request->getRecipientContactPhoneNumber(),
                        'email' => $request->getRecipientEmail()
                    ]
                ];

                $response = $this->routzClient->createShipment($shipmentData);
                
                if ($response && isset($response['tracking_number'])) {
                    $data[$packageId] = [
                        'tracking_number' => $response['tracking_number'],
                        'label_content' => $response['label_content'] ?? '',
                        'label_url' => $response['label_url'] ?? ''
                    ];
                }
            } catch (\Exception $e) {
                $this->_logger->error('Routz shipment error: ' . $e->getMessage());
                $result->setErrors($e->getMessage());
            }
        }

        if (!empty($data)) {
            $result->setInfo($data);
        }

        return $result;
    }

    /**
     * Get carrier from method code
     */
    protected function getCarrierFromMethod(string $method): string
    {
        $parts = explode('_', str_replace('routz_', '', $method));
        return $parts[0] ?? 'colissimo';
    }

    /**
     * Get service from method code
     */
    protected function getServiceFromMethod(string $method): string
    {
        $parts = explode('_', str_replace('routz_', '', $method));
        return $parts[1] ?? 'home';
    }
}
