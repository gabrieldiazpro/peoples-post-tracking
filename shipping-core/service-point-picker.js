/**
 * ROUTZ - Service Point Picker Service
 * Widget de sélection de points relais pour checkout e-commerce
 * Support multi-transporteurs: Mondial Relay, Colissimo, Chronopost, DPD, GLS, UPS, etc.
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');
const crypto = require('crypto');

// ============================================
// DATABASE & CACHE
// ============================================

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Cache TTL: 1 hour for service points (they don't change often)
const CACHE_TTL = 3600;

// ============================================
// CARRIER CONFIGURATIONS
// ============================================

const CARRIER_CONFIGS = {
    mondial_relay: {
        name: 'Mondial Relay',
        logo: 'https://cdn.routz.io/carriers/mondial-relay.svg',
        color: '#E30613',
        api: {
            baseUrl: 'https://api.mondialrelay.com/Web_Services.asmx',
            type: 'soap'
        },
        pointTypes: ['24R', '24L', 'DRI'],
        maxResults: 20,
        maxDistance: 20, // km
        features: ['locker', 'shop', 'drive'],
        countries: ['FR', 'BE', 'LU', 'ES', 'PT', 'NL', 'DE', 'AT']
    },
    
    colissimo: {
        name: 'Colissimo',
        logo: 'https://cdn.routz.io/carriers/colissimo.svg',
        color: '#FFD100',
        api: {
            baseUrl: 'https://ws.colissimo.fr/pointretrait-ws-cxf/PointRetraitServiceWS/2.0',
            type: 'soap'
        },
        pointTypes: ['BPR', 'ACP', 'CDI', 'BDP'],
        maxResults: 20,
        maxDistance: 20,
        features: ['bureau_poste', 'relais_pickup', 'consigne', 'commerce'],
        countries: ['FR', 'BE', 'DE', 'GB', 'LU', 'NL', 'ES', 'IT', 'AT', 'PT']
    },
    
    chronopost: {
        name: 'Chronopost Pickup',
        logo: 'https://cdn.routz.io/carriers/chronopost.svg',
        color: '#003DA5',
        api: {
            baseUrl: 'https://www.chronopost.fr/recherchebt-ws-cxf/PointChronopostService',
            type: 'soap'
        },
        pointTypes: ['P', 'T', 'B'],
        maxResults: 15,
        maxDistance: 15,
        features: ['relais', 'bureau_tabac', 'consigne'],
        countries: ['FR']
    },
    
    dpd: {
        name: 'DPD Pickup',
        logo: 'https://cdn.routz.io/carriers/dpd.svg',
        color: '#DC0032',
        api: {
            baseUrl: 'https://api.dpd.fr/pickup',
            type: 'rest'
        },
        maxResults: 20,
        maxDistance: 20,
        features: ['pickup_shop', 'pickup_station'],
        countries: ['FR', 'DE', 'BE', 'NL', 'LU', 'AT', 'PL', 'CZ', 'SK']
    },
    
    gls: {
        name: 'GLS Relais Colis',
        logo: 'https://cdn.routz.io/carriers/gls.svg',
        color: '#003A70',
        api: {
            baseUrl: 'https://api.gls-group.eu/parcelshop',
            type: 'rest'
        },
        maxResults: 20,
        maxDistance: 20,
        features: ['parcel_shop'],
        countries: ['FR', 'DE', 'BE', 'NL', 'IT', 'ES', 'PT', 'AT', 'PL']
    },
    
    ups_access_point: {
        name: 'UPS Access Point',
        logo: 'https://cdn.routz.io/carriers/ups.svg',
        color: '#351C15',
        api: {
            baseUrl: 'https://onlinetools.ups.com/rest/Locator',
            type: 'rest'
        },
        maxResults: 20,
        maxDistance: 25,
        features: ['access_point', 'locker', 'store'],
        countries: ['FR', 'DE', 'GB', 'ES', 'IT', 'BE', 'NL', 'AT', 'PL', 'US', 'CA']
    },
    
    fedex_hold: {
        name: 'FedEx Hold at Location',
        logo: 'https://cdn.routz.io/carriers/fedex.svg',
        color: '#4D148C',
        api: {
            baseUrl: 'https://apis.fedex.com/location/v1',
            type: 'rest'
        },
        maxResults: 15,
        maxDistance: 25,
        features: ['fedex_office', 'walgreens', 'dollar_general'],
        countries: ['FR', 'DE', 'GB', 'US', 'CA']
    },
    
    relais_colis: {
        name: 'Relais Colis',
        logo: 'https://cdn.routz.io/carriers/relais-colis.svg',
        color: '#00A0E3',
        api: {
            baseUrl: 'https://api.relaiscolis.com/v2',
            type: 'rest'
        },
        maxResults: 20,
        maxDistance: 20,
        features: ['relais'],
        countries: ['FR', 'BE']
    },
    
    shop2shop: {
        name: 'Shop2Shop (Colis Privé)',
        logo: 'https://cdn.routz.io/carriers/colis-prive.svg',
        color: '#E4002B',
        api: {
            baseUrl: 'https://api.colisprive.com/v1/pickup-points',
            type: 'rest'
        },
        maxResults: 20,
        maxDistance: 15,
        features: ['pickup_point'],
        countries: ['FR']
    },
    
    inpost: {
        name: 'InPost Locker',
        logo: 'https://cdn.routz.io/carriers/inpost.svg',
        color: '#FFCD00',
        api: {
            baseUrl: 'https://api-shipx-pl.easypack24.net/v1',
            type: 'rest'
        },
        maxResults: 30,
        maxDistance: 10,
        features: ['locker', 'paczkomat'],
        countries: ['FR', 'PL', 'GB', 'IT', 'ES']
    }
};

// ============================================
// SERVICE POINT PICKER SERVICE
// ============================================

class ServicePointPickerService {
    constructor() {
        this.carrierConnectors = {};
        this.initConnectors();
    }

    // ----------------------------------------
    // CONNECTOR INITIALIZATION
    // ----------------------------------------

    initConnectors() {
        // Initialize API connectors for each carrier
        Object.keys(CARRIER_CONFIGS).forEach(carrier => {
            this.carrierConnectors[carrier] = this.createConnector(carrier);
        });
    }

    createConnector(carrier) {
        const config = CARRIER_CONFIGS[carrier];
        
        return {
            config,
            search: async (params) => {
                switch (carrier) {
                    case 'mondial_relay':
                        return this.searchMondialRelay(params);
                    case 'colissimo':
                        return this.searchColissimo(params);
                    case 'chronopost':
                        return this.searchChronopost(params);
                    case 'dpd':
                        return this.searchDPD(params);
                    case 'gls':
                        return this.searchGLS(params);
                    case 'ups_access_point':
                        return this.searchUPS(params);
                    case 'inpost':
                        return this.searchInPost(params);
                    default:
                        return this.searchGeneric(carrier, params);
                }
            }
        };
    }

    // ----------------------------------------
    // MAIN SEARCH METHODS
    // ----------------------------------------

    /**
     * Search service points across multiple carriers
     */
    async searchServicePoints(params) {
        const {
            postalCode,
            city,
            country = 'FR',
            latitude,
            longitude,
            carriers = [],
            maxResults = 20,
            maxDistance = 20,
            weight,
            dimensions,
            features = []
        } = params;

        // Validate input
        if (!postalCode && !city && (!latitude || !longitude)) {
            throw new Error('Either postalCode, city, or coordinates required');
        }

        // Get coordinates if not provided
        let coords = { lat: latitude, lng: longitude };
        if (!coords.lat || !coords.lng) {
            coords = await this.geocode(postalCode, city, country);
        }

        // Determine which carriers to search
        const searchCarriers = carriers.length > 0 
            ? carriers.filter(c => CARRIER_CONFIGS[c])
            : Object.keys(CARRIER_CONFIGS).filter(c => 
                CARRIER_CONFIGS[c].countries.includes(country)
            );

        // Check cache first
        const cacheKey = this.getCacheKey(coords, country, searchCarriers);
        const cached = await redis.get(cacheKey);
        if (cached) {
            const results = JSON.parse(cached);
            return this.filterResults(results, { maxResults, maxDistance, weight, dimensions, features });
        }

        // Search all carriers in parallel
        const searchPromises = searchCarriers.map(async carrier => {
            try {
                const connector = this.carrierConnectors[carrier];
                const points = await connector.search({
                    ...coords,
                    postalCode,
                    country,
                    maxResults: CARRIER_CONFIGS[carrier].maxResults,
                    maxDistance: CARRIER_CONFIGS[carrier].maxDistance
                });

                return points.map(point => ({
                    ...point,
                    carrier,
                    carrierName: CARRIER_CONFIGS[carrier].name,
                    carrierLogo: CARRIER_CONFIGS[carrier].logo,
                    carrierColor: CARRIER_CONFIGS[carrier].color
                }));
            } catch (error) {
                console.error(`Error searching ${carrier}:`, error.message);
                return [];
            }
        });

        const results = await Promise.all(searchPromises);
        const allPoints = results.flat();

        // Sort by distance
        allPoints.sort((a, b) => (a.distance || 0) - (b.distance || 0));

        // Cache results
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(allPoints));

        return this.filterResults(allPoints, { maxResults, maxDistance, weight, dimensions, features });
    }

    /**
     * Get details for a specific service point
     */
    async getServicePointDetails(carrier, pointId) {
        const cacheKey = `sp_detail:${carrier}:${pointId}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const connector = this.carrierConnectors[carrier];
        if (!connector) throw new Error(`Unknown carrier: ${carrier}`);

        const details = await this.fetchPointDetails(carrier, pointId);
        
        await redis.setex(cacheKey, CACHE_TTL * 24, JSON.stringify(details)); // 24h cache
        return details;
    }

    /**
     * Validate a service point is still available
     */
    async validateServicePoint(carrier, pointId) {
        try {
            const details = await this.getServicePointDetails(carrier, pointId);
            return {
                valid: !!details && details.active !== false,
                point: details
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    // ----------------------------------------
    // CARRIER-SPECIFIC SEARCH IMPLEMENTATIONS
    // ----------------------------------------

    async searchMondialRelay(params) {
        const { lat, lng, postalCode, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('mondial_relay');
        
        // Mondial Relay uses SOAP
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                <soap:Body>
                    <WSI4_PointRelais_Recherche xmlns="http://www.mondialrelay.fr/webservice/">
                        <Enseigne>${credentials.enseigne}</Enseigne>
                        <Pays>${country}</Pays>
                        <CP>${postalCode}</CP>
                        <Latitude>${lat || ''}</Latitude>
                        <Longitude>${lng || ''}</Longitude>
                        <NombreResultats>${maxResults}</NombreResultats>
                        <Security>${this.generateMondialRelaySignature(credentials, postalCode, country)}</Security>
                    </WSI4_PointRelais_Recherche>
                </soap:Body>
            </soap:Envelope>`;

        try {
            const response = await axios.post(
                CARRIER_CONFIGS.mondial_relay.api.baseUrl,
                soapBody,
                { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
            );

            return this.parseMondialRelayResponse(response.data);
        } catch (error) {
            console.error('Mondial Relay search error:', error);
            return [];
        }
    }

    async searchColissimo(params) {
        const { lat, lng, postalCode, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('colissimo');

        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                <soap:Body>
                    <findRDVPointRetraitAchworker xmlns="http://ws.colissimo.fr/pointretrait">
                        <accountNumber>${credentials.accountNumber}</accountNumber>
                        <password>${credentials.password}</password>
                        <address>${postalCode}</address>
                        <countryCode>${country}</countryCode>
                        <weight>1000</weight>
                        <filterRelay>1</filterRelay>
                        <requestId>routz_${Date.now()}</requestId>
                        ${lat ? `<shippingDate>${new Date().toISOString().split('T')[0]}</shippingDate>` : ''}
                    </findRDVPointRetraitAchworker>
                </soap:Body>
            </soap:Envelope>`;

        try {
            const response = await axios.post(
                CARRIER_CONFIGS.colissimo.api.baseUrl,
                soapBody,
                { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
            );

            return this.parseColissimoResponse(response.data);
        } catch (error) {
            console.error('Colissimo search error:', error);
            return [];
        }
    }

    async searchChronopost(params) {
        const { postalCode, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('chronopost');

        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                <soap:Body>
                    <recherchePointChronopost xmlns="http://cxf.ws.recherchebt.chronopost.fr/">
                        <accountNumber>${credentials.accountNumber}</accountNumber>
                        <password>${credentials.password}</password>
                        <codePostal>${postalCode}</codePostal>
                        <countryCode>${country}</countryCode>
                        <type>T</type>
                        <productCode>86</productCode>
                        <service>L</service>
                        <weight>1</weight>
                        <maxPointChronopost>${maxResults}</maxPointChronopost>
                    </recherchePointChronopost>
                </soap:Body>
            </soap:Envelope>`;

        try {
            const response = await axios.post(
                CARRIER_CONFIGS.chronopost.api.baseUrl,
                soapBody,
                { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
            );

            return this.parseChronopostResponse(response.data);
        } catch (error) {
            console.error('Chronopost search error:', error);
            return [];
        }
    }

    async searchDPD(params) {
        const { lat, lng, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('dpd');

        try {
            const response = await axios.get(
                `${CARRIER_CONFIGS.dpd.api.baseUrl}/findByGeoCoordinates`,
                {
                    params: {
                        latitude: lat,
                        longitude: lng,
                        countryCode: country,
                        limit: maxResults
                    },
                    headers: {
                        'Authorization': `Bearer ${credentials.apiKey}`,
                        'Accept': 'application/json'
                    }
                }
            );

            return this.parseDPDResponse(response.data);
        } catch (error) {
            console.error('DPD search error:', error);
            return [];
        }
    }

    async searchGLS(params) {
        const { lat, lng, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('gls');

        try {
            const response = await axios.get(
                `${CARRIER_CONFIGS.gls.api.baseUrl}/list`,
                {
                    params: {
                        lat,
                        lng,
                        countryCode: country.toLowerCase(),
                        limit: maxResults
                    },
                    headers: {
                        'X-API-Key': credentials.apiKey,
                        'Accept': 'application/json'
                    }
                }
            );

            return this.parseGLSResponse(response.data);
        } catch (error) {
            console.error('GLS search error:', error);
            return [];
        }
    }

    async searchUPS(params) {
        const { lat, lng, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('ups_access_point');

        try {
            const response = await axios.post(
                CARRIER_CONFIGS.ups_access_point.api.baseUrl,
                {
                    LocatorRequest: {
                        Request: {
                            RequestAction: 'Locator',
                            RequestOption: '64' // Access Points
                        },
                        OriginAddress: {
                            Geocode: {
                                Latitude: lat.toString(),
                                Longitude: lng.toString()
                            }
                        },
                        Translate: { Locale: 'fr_FR' },
                        UnitOfMeasurement: { Code: 'KM' },
                        MaximumListSize: maxResults.toString(),
                        SearchFilter: {
                            AccessPointStatus: { Code: '01' }, // Active
                            AccessPointSearchByCountryCode: country
                        }
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${credentials.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return this.parseUPSResponse(response.data);
        } catch (error) {
            console.error('UPS search error:', error);
            return [];
        }
    }

    async searchInPost(params) {
        const { lat, lng, country, maxResults } = params;
        
        const credentials = await this.getCarrierCredentials('inpost');

        try {
            const response = await axios.get(
                `${CARRIER_CONFIGS.inpost.api.baseUrl}/points`,
                {
                    params: {
                        relative_point: `${lat},${lng}`,
                        type: 'parcel_locker',
                        status: 'Operating',
                        per_page: maxResults
                    },
                    headers: {
                        'Authorization': `Bearer ${credentials.apiKey}`,
                        'Accept': 'application/json'
                    }
                }
            );

            return this.parseInPostResponse(response.data);
        } catch (error) {
            console.error('InPost search error:', error);
            return [];
        }
    }

    async searchGeneric(carrier, params) {
        // Generic REST API search for carriers not yet implemented
        console.warn(`Generic search for ${carrier} not implemented`);
        return [];
    }

    // ----------------------------------------
    // RESPONSE PARSERS
    // ----------------------------------------

    parseMondialRelayResponse(xmlData) {
        // Parse SOAP XML response
        const points = [];
        const regex = /<PointRelais_Details>([\s\S]*?)<\/PointRelais_Details>/g;
        let match;

        while ((match = regex.exec(xmlData)) !== null) {
            const pointXml = match[1];
            
            const getValue = (tag) => {
                const m = pointXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1].trim() : '';
            };

            points.push({
                id: getValue('Num'),
                name: getValue('LgAdr1'),
                address: `${getValue('LgAdr3')} ${getValue('LgAdr4')}`.trim(),
                postalCode: getValue('CP'),
                city: getValue('Ville'),
                country: getValue('Pays'),
                latitude: parseFloat(getValue('Latitude').replace(',', '.')),
                longitude: parseFloat(getValue('Longitude').replace(',', '.')),
                distance: parseFloat(getValue('Distance').replace(',', '.')),
                type: this.mapMondialRelayType(getValue('TypeActivite')),
                openingHours: this.parseMondialRelayHours(pointXml),
                photo: getValue('URL_Photo'),
                features: this.parseMondialRelayFeatures(pointXml)
            });
        }

        return points;
    }

    parseColissimoResponse(xmlData) {
        const points = [];
        const regex = /<pointRetraitAchworker>([\s\S]*?)<\/pointRetraitAchworker>/g;
        let match;

        while ((match = regex.exec(xmlData)) !== null) {
            const pointXml = match[1];
            
            const getValue = (tag) => {
                const m = pointXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1].trim() : '';
            };

            points.push({
                id: getValue('identifiant'),
                name: getValue('nom'),
                address: `${getValue('adresse1')} ${getValue('adresse2')}`.trim(),
                postalCode: getValue('codePostal'),
                city: getValue('localite'),
                country: getValue('codePays'),
                latitude: parseFloat(getValue('coordGeolocalisationLatitude')),
                longitude: parseFloat(getValue('coordGeolocalisationLongitude')),
                distance: parseFloat(getValue('distanceEnMetre')) / 1000,
                type: this.mapColissimoType(getValue('typeDePoint')),
                openingHours: this.parseColissimoHours(pointXml),
                features: []
            });
        }

        return points;
    }

    parseChronopostResponse(xmlData) {
        const points = [];
        const regex = /<listePointChronopost>([\s\S]*?)<\/listePointChronopost>/g;
        let match;

        while ((match = regex.exec(xmlData)) !== null) {
            const pointXml = match[1];
            
            const getValue = (tag) => {
                const m = pointXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
                return m ? m[1].trim() : '';
            };

            points.push({
                id: getValue('identifiantChronopostPointA2PAS'),
                name: getValue('nom'),
                address: `${getValue('adresse1')} ${getValue('adresse2')}`.trim(),
                postalCode: getValue('codePostal'),
                city: getValue('localite'),
                country: 'FR',
                latitude: parseFloat(getValue('coordGeoLatitude')),
                longitude: parseFloat(getValue('coordGeoLongitude')),
                distance: parseFloat(getValue('distanceEnMetre')) / 1000,
                type: getValue('typeDePoint'),
                openingHours: this.parseChronopostHours(pointXml),
                features: []
            });
        }

        return points;
    }

    parseDPDResponse(data) {
        if (!data || !data.pickupPoints) return [];

        return data.pickupPoints.map(point => ({
            id: point.pclshopId,
            name: point.name,
            address: point.street,
            postalCode: point.zipCode,
            city: point.city,
            country: point.country,
            latitude: parseFloat(point.latitude),
            longitude: parseFloat(point.longitude),
            distance: point.distance / 1000,
            type: point.type,
            openingHours: this.parseGenericHours(point.openingHours),
            features: point.services || []
        }));
    }

    parseGLSResponse(data) {
        if (!data || !data.parcelShops) return [];

        return data.parcelShops.map(point => ({
            id: point.parcelShopId,
            name: point.name,
            address: point.street,
            postalCode: point.zipcode,
            city: point.city,
            country: point.country.toUpperCase(),
            latitude: parseFloat(point.latitude),
            longitude: parseFloat(point.longitude),
            distance: point.distance,
            type: 'parcel_shop',
            openingHours: this.parseGLSHours(point.openingHours),
            features: []
        }));
    }

    parseUPSResponse(data) {
        const dropLocations = data?.LocatorResponse?.SearchResults?.DropLocation || [];
        
        return dropLocations.map(point => ({
            id: point.LocationID,
            name: point.AddressKeyFormat?.ConsigneeName || 'UPS Access Point',
            address: point.AddressKeyFormat?.AddressLine?.[0] || '',
            postalCode: point.AddressKeyFormat?.PostcodePrimaryLow || '',
            city: point.AddressKeyFormat?.PoliticalDivision2 || '',
            country: point.AddressKeyFormat?.CountryCode || '',
            latitude: parseFloat(point.Geocode?.Latitude || 0),
            longitude: parseFloat(point.Geocode?.Longitude || 0),
            distance: parseFloat(point.Distance?.Value || 0),
            type: this.mapUPSType(point.AccessPointInformation?.AccessPointType?.Code),
            openingHours: this.parseUPSHours(point.OperatingHours),
            features: []
        }));
    }

    parseInPostResponse(data) {
        if (!data || !data.items) return [];

        return data.items.map(point => ({
            id: point.name,
            name: point.name,
            address: point.address?.line1 || '',
            postalCode: point.address?.postcode || '',
            city: point.address?.city || '',
            country: point.address?.countryCode || '',
            latitude: point.location?.latitude,
            longitude: point.location?.longitude,
            distance: point.distance,
            type: 'locker',
            openingHours: point.opening_hours ? this.parseInPostHours(point.opening_hours) : 'Accessible 24/7',
            features: ['locker', '24h'],
            lockerSizes: point.location_description
        }));
    }

    // ----------------------------------------
    // HELPERS
    // ----------------------------------------

    async geocode(postalCode, city, country) {
        const cacheKey = `geocode:${country}:${postalCode}:${city}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        try {
            // Use Nominatim (free) or Google Geocoding API
            const query = `${postalCode || ''} ${city || ''} ${country}`.trim();
            const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: query,
                    format: 'json',
                    limit: 1
                },
                headers: {
                    'User-Agent': 'Routz/1.0'
                }
            });

            if (response.data && response.data.length > 0) {
                const coords = {
                    lat: parseFloat(response.data[0].lat),
                    lng: parseFloat(response.data[0].lon)
                };
                await redis.setex(cacheKey, 86400 * 30, JSON.stringify(coords)); // 30 days
                return coords;
            }
        } catch (error) {
            console.error('Geocoding error:', error);
        }

        throw new Error('Unable to geocode address');
    }

    async getCarrierCredentials(carrier) {
        // In production, fetch from secure storage (env vars, secrets manager)
        return {
            // Mondial Relay
            enseigne: process.env.MONDIAL_RELAY_ENSEIGNE,
            privateKey: process.env.MONDIAL_RELAY_KEY,
            
            // Colissimo
            accountNumber: process.env.COLISSIMO_ACCOUNT,
            password: process.env.COLISSIMO_PASSWORD,
            
            // Generic API key
            apiKey: process.env[`${carrier.toUpperCase()}_API_KEY`],
            accessToken: process.env[`${carrier.toUpperCase()}_ACCESS_TOKEN`]
        };
    }

    generateMondialRelaySignature(credentials, postalCode, country) {
        const data = `${credentials.enseigne}${country}${postalCode}${credentials.privateKey}`;
        return crypto.createHash('md5').update(data).digest('hex').toUpperCase();
    }

    getCacheKey(coords, country, carriers) {
        const rounded = {
            lat: Math.round(coords.lat * 100) / 100,
            lng: Math.round(coords.lng * 100) / 100
        };
        return `sp:${country}:${rounded.lat}:${rounded.lng}:${carriers.sort().join(',')}`;
    }

    filterResults(points, filters) {
        let filtered = points;

        if (filters.maxDistance) {
            filtered = filtered.filter(p => !p.distance || p.distance <= filters.maxDistance);
        }

        if (filters.features && filters.features.length > 0) {
            filtered = filtered.filter(p => 
                filters.features.some(f => p.features?.includes(f))
            );
        }

        // TODO: Filter by weight/dimensions compatibility

        return filtered.slice(0, filters.maxResults || 20);
    }

    // Type mappers
    mapMondialRelayType(typeCode) {
        const types = {
            '24R': 'relay_point',
            '24L': 'locker',
            'DRI': 'drive'
        };
        return types[typeCode] || 'relay_point';
    }

    mapColissimoType(typeCode) {
        const types = {
            'BPR': 'post_office',
            'ACP': 'pickup_relay',
            'CDI': 'locker',
            'BDP': 'parcel_shop'
        };
        return types[typeCode] || 'pickup_relay';
    }

    mapUPSType(typeCode) {
        const types = {
            '01': 'access_point',
            '02': 'locker',
            '03': 'store'
        };
        return types[typeCode] || 'access_point';
    }

    // Opening hours parsers
    parseMondialRelayHours(xml) {
        // Parse Mondial Relay specific format
        const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
        const hours = {};
        
        days.forEach((day, i) => {
            const dayCode = ['L', 'Ma', 'Me', 'J', 'V', 'S', 'D'][i];
            const regex = new RegExp(`<Horaires_${dayCode}><string>([^<]*)</string><string>([^<]*)</string>`);
            const match = xml.match(regex);
            if (match) {
                hours[day.toLowerCase()] = `${match[1]} - ${match[2]}`;
            }
        });
        
        return hours;
    }

    parseColissimoHours(xml) {
        // Parse Colissimo format
        return {}; // Simplified for now
    }

    parseChronopostHours(xml) {
        return {};
    }

    parseGenericHours(hoursData) {
        if (!hoursData) return {};
        if (typeof hoursData === 'string') return { info: hoursData };
        return hoursData;
    }

    parseGLSHours(hoursData) {
        if (!hoursData || !Array.isArray(hoursData)) return {};
        
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const hours = {};
        
        hoursData.forEach((h, i) => {
            if (days[i] && h) {
                hours[days[i]] = h;
            }
        });
        
        return hours;
    }

    parseUPSHours(hoursData) {
        if (!hoursData || !hoursData.StandardHours) return {};
        
        const hours = {};
        const dayHours = hoursData.StandardHours.DayOfWeek;
        
        if (Array.isArray(dayHours)) {
            dayHours.forEach(d => {
                if (d.Day && d.OpenHours) {
                    hours[d.Day.toLowerCase()] = d.OpenHours;
                }
            });
        }
        
        return hours;
    }

    parseInPostHours(hoursString) {
        return hoursString || 'Accessible 24/7';
    }

    parseMondialRelayFeatures(xml) {
        const features = [];
        if (xml.includes('<TypeActivite>24L</TypeActivite>')) features.push('locker');
        if (xml.includes('<TypeActivite>DRI</TypeActivite>')) features.push('drive');
        return features;
    }
}

// ============================================
// WIDGET CONFIGURATION SERVICE
// ============================================

class WidgetConfigService {
    async getWidgetConfig(orgId) {
        const result = await db.query(
            'SELECT * FROM service_point_widget_config WHERE organization_id = $1',
            [orgId]
        );
        
        return result.rows[0] || this.getDefaultConfig();
    }

    getDefaultConfig() {
        return {
            enabled: true,
            
            // Carriers to show
            enabled_carriers: ['mondial_relay', 'colissimo', 'chronopost'],
            
            // Display options
            default_view: 'map', // 'map' or 'list'
            map_provider: 'mapbox', // 'mapbox', 'google', 'leaflet'
            show_carrier_filter: true,
            show_distance: true,
            show_opening_hours: true,
            show_photos: true,
            
            // Search options
            max_results: 20,
            max_distance: 20,
            auto_select_nearest: false,
            
            // Styling
            theme: 'light', // 'light', 'dark', 'auto'
            primary_color: '#2563EB',
            border_radius: '12px',
            font_family: 'Inter, system-ui, sans-serif',
            
            // Map settings
            map_zoom_default: 13,
            map_style: 'streets', // 'streets', 'outdoors', 'light', 'dark'
            
            // Labels (multi-language)
            labels: {
                fr: {
                    title: 'Choisissez votre point relais',
                    search_placeholder: 'Entrez votre code postal ou ville',
                    search_button: 'Rechercher',
                    no_results: 'Aucun point relais trouvé',
                    select_button: 'Sélectionner',
                    selected: 'Sélectionné',
                    distance: 'à {distance} km',
                    opening_hours: 'Horaires d\'ouverture',
                    closed: 'Fermé',
                    open_now: 'Ouvert',
                    filter_all: 'Tous',
                    view_map: 'Carte',
                    view_list: 'Liste'
                },
                en: {
                    title: 'Choose your pickup point',
                    search_placeholder: 'Enter your postal code or city',
                    search_button: 'Search',
                    no_results: 'No pickup points found',
                    select_button: 'Select',
                    selected: 'Selected',
                    distance: '{distance} km away',
                    opening_hours: 'Opening hours',
                    closed: 'Closed',
                    open_now: 'Open',
                    filter_all: 'All',
                    view_map: 'Map',
                    view_list: 'List'
                }
            }
        };
    }

    async saveWidgetConfig(orgId, config) {
        await db.query(`
            INSERT INTO service_point_widget_config (organization_id, config, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (organization_id) DO UPDATE SET
                config = EXCLUDED.config,
                updated_at = NOW()
        `, [orgId, JSON.stringify(config)]);

        return config;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    ServicePointPickerService,
    WidgetConfigService,
    CARRIER_CONFIGS
};
