/**
 * Routz v4.0 - International Shipping & Customs Service
 * Gestion douanes, HS codes, documents export, réglementations
 */

class InternationalService {
    constructor(config = {}) {
        this.db = config.db;
        this.hsCodeApi = config.hsCodeApi;
        this.dutiesApi = config.dutiesApi;
    }

    // ==========================================
    // CUSTOMS DECLARATIONS
    // ==========================================

    async createCustomsDeclaration(shipmentData) {
        const declaration = {
            id: this.generateId('CUST'),
            shipmentId: shipmentData.shipmentId,
            type: this.determineDeclarationType(shipmentData),
            
            // Parties
            exporter: {
                name: shipmentData.sender.company || `${shipmentData.sender.firstName} ${shipmentData.sender.lastName}`,
                address: shipmentData.sender,
                eoriNumber: shipmentData.sender.eoriNumber,
                vatNumber: shipmentData.sender.vatNumber
            },
            importer: {
                name: shipmentData.recipient.company || `${shipmentData.recipient.firstName} ${shipmentData.recipient.lastName}`,
                address: shipmentData.recipient,
                eoriNumber: shipmentData.recipient.eoriNumber,
                taxId: shipmentData.recipient.taxId
            },

            // Contenu
            items: await Promise.all(shipmentData.items.map(async item => ({
                description: item.description,
                hsCode: item.hsCode || await this.suggestHSCode(item.description, item.category),
                quantity: item.quantity,
                unitValue: item.unitValue,
                totalValue: item.quantity * item.unitValue,
                weight: item.weight,
                countryOfOrigin: item.countryOfOrigin || shipmentData.sender.country,
                currency: shipmentData.currency || 'EUR'
            }))),

            // Valeurs
            totalValue: 0, // Calculé ci-dessous
            currency: shipmentData.currency || 'EUR',
            incoterm: shipmentData.incoterm || 'DAP',
            
            // Shipping
            originCountry: shipmentData.sender.country,
            destinationCountry: shipmentData.recipient.country,
            transportMode: 'road', // road, air, sea, rail
            
            // Documents requis
            requiredDocuments: [],
            
            // Duties & Taxes estimation
            estimatedDuties: null,
            estimatedTaxes: null,
            
            createdAt: new Date().toISOString()
        };

        // Calculer le total
        declaration.totalValue = declaration.items.reduce((sum, item) => sum + item.totalValue, 0);

        // Déterminer les documents requis
        declaration.requiredDocuments = this.getRequiredDocuments(declaration);

        // Estimer les droits et taxes
        const dutiesEstimate = await this.estimateDutiesAndTaxes(declaration);
        declaration.estimatedDuties = dutiesEstimate.duties;
        declaration.estimatedTaxes = dutiesEstimate.taxes;

        // Sauvegarder
        await this.db.query(
            `INSERT INTO customs_declarations (id, shipment_id, type, exporter, importer, items, total_value, currency, incoterm, origin_country, destination_country, required_documents, estimated_duties, estimated_taxes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [declaration.id, declaration.shipmentId, declaration.type, JSON.stringify(declaration.exporter), JSON.stringify(declaration.importer), JSON.stringify(declaration.items), declaration.totalValue, declaration.currency, declaration.incoterm, declaration.originCountry, declaration.destinationCountry, JSON.stringify(declaration.requiredDocuments), declaration.estimatedDuties, declaration.estimatedTaxes, declaration.createdAt]
        );

        return declaration;
    }

    determineDeclarationType(shipmentData) {
        const origin = shipmentData.sender.country;
        const destination = shipmentData.recipient.country;
        
        // EU countries
        const euCountries = ['FR', 'DE', 'ES', 'IT', 'BE', 'NL', 'PT', 'AT', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'SE', 'DK', 'FI', 'IE', 'LU', 'MT', 'CY', 'EE', 'LV', 'LT', 'SI', 'HR'];
        
        const originEU = euCountries.includes(origin);
        const destEU = euCountries.includes(destination);

        if (originEU && destEU) {
            return 'intra_eu'; // Pas de déclaration douanière, juste Intrastat si seuils
        } else if (originEU && !destEU) {
            return 'export';
        } else if (!originEU && destEU) {
            return 'import';
        } else {
            return 'transit';
        }
    }

    // ==========================================
    // HS CODES
    // ==========================================

    async suggestHSCode(description, category = null) {
        // Base de données simplifiée de HS codes
        const hsCodeDatabase = {
            // Vêtements
            'tshirt': '6109.10',
            't-shirt': '6109.10',
            'chemise': '6205.20',
            'jean': '6203.42',
            'pantalon': '6203.42',
            'robe': '6204.42',
            'veste': '6201.93',
            'manteau': '6201.11',
            'pull': '6110.20',
            'sweat': '6110.20',
            
            // Chaussures
            'chaussure': '6403.99',
            'sneaker': '6404.11',
            'basket': '6404.11',
            'botte': '6403.91',
            'sandale': '6403.99',
            
            // Accessoires
            'sac': '4202.22',
            'ceinture': '4203.30',
            'montre': '9102.11',
            'bijou': '7117.19',
            'lunettes': '9004.10',
            
            // Électronique
            'telephone': '8517.12',
            'smartphone': '8517.12',
            'ordinateur': '8471.30',
            'tablette': '8471.30',
            'ecouteur': '8518.30',
            'casque': '8518.30',
            
            // Cosmétiques
            'parfum': '3303.00',
            'creme': '3304.99',
            'maquillage': '3304.10',
            'shampooing': '3305.10'
        };

        const lowerDesc = description.toLowerCase();
        
        for (const [keyword, hsCode] of Object.entries(hsCodeDatabase)) {
            if (lowerDesc.includes(keyword)) {
                return hsCode;
            }
        }

        // Codes par défaut par catégorie
        const categoryDefaults = {
            'clothing': '6211.43',
            'footwear': '6404.19',
            'accessories': '4202.99',
            'electronics': '8543.70',
            'cosmetics': '3304.99',
            'toys': '9503.00',
            'food': '2106.90'
        };

        return categoryDefaults[category?.toLowerCase()] || '9999.99';
    }

    async validateHSCode(hsCode, destinationCountry) {
        // Vérifier si le HS code est valide pour le pays de destination
        const restrictions = await this.getHSCodeRestrictions(hsCode, destinationCountry);
        
        return {
            valid: !restrictions.prohibited,
            hsCode,
            description: await this.getHSCodeDescription(hsCode),
            restrictions
        };
    }

    async getHSCodeDescription(hsCode) {
        const descriptions = {
            '6109.10': 'T-shirts et maillots de corps, en bonneterie, de coton',
            '6205.20': 'Chemises pour hommes, de coton',
            '6203.42': 'Pantalons pour hommes, de coton',
            '6404.11': 'Chaussures de sport, à semelles extérieures en caoutchouc ou en matière plastique',
            '4202.22': 'Sacs à main, en feuilles de matières plastiques ou en matières textiles',
            '8517.12': 'Téléphones portables et autres réseaux sans fil',
            '3303.00': 'Parfums et eaux de toilette'
        };
        
        return descriptions[hsCode] || 'Description non disponible';
    }

    async getHSCodeRestrictions(hsCode, country) {
        // Restrictions par pays
        const countryRestrictions = {
            'US': {
                prohibited: ['4303'], // Fourrures de certains animaux
                requiresLicense: ['8471'], // Certains équipements tech
                quotas: ['6109'] // Textiles
            },
            'CN': {
                prohibited: [],
                requiresLicense: ['8517', '9102'],
                requiresCCC: ['8471', '8518'] // China Compulsory Certification
            },
            'RU': {
                sanctioned: true,
                prohibited: ['*'] // Sanctions
            }
        };

        const restrictions = countryRestrictions[country] || {};
        const hsPrefix = hsCode.substring(0, 4);

        return {
            prohibited: restrictions.prohibited?.includes(hsPrefix) || restrictions.sanctioned,
            requiresLicense: restrictions.requiresLicense?.includes(hsPrefix),
            quotas: restrictions.quotas?.includes(hsPrefix),
            specialCertification: restrictions.requiresCCC?.includes(hsPrefix)
        };
    }

    // ==========================================
    // DUTIES & TAXES ESTIMATION
    // ==========================================

    async estimateDutiesAndTaxes(declaration) {
        const country = declaration.destinationCountry;
        
        // Taux de droits de douane par pays et HS code (simplifié)
        const dutyRates = {
            'US': { default: 0.05, '6109': 0.167, '6403': 0.10, '8517': 0 },
            'GB': { default: 0.04, '6109': 0.12, '8517': 0 },
            'CH': { default: 0.03 },
            'CN': { default: 0.10, '6109': 0.14, '8517': 0.08 },
            'JP': { default: 0.05, '6109': 0.109 },
            'AU': { default: 0.05 },
            'CA': { default: 0.07 }
        };

        // Taux de TVA/GST par pays
        const vatRates = {
            'US': 0, // Pas de TVA fédérale
            'GB': 0.20,
            'CH': 0.077,
            'CN': 0.13,
            'JP': 0.10,
            'AU': 0.10,
            'CA': 0.05
        };

        // Seuils de minimis (exonération)
        const deMinimis = {
            'US': 800,
            'GB': 135,
            'CH': 65,
            'CN': 50,
            'JP': 10000, // JPY
            'AU': 1000,
            'CA': 20
        };

        const countryDutyRates = dutyRates[country] || { default: 0.05 };
        const vatRate = vatRates[country] || 0.20;
        const threshold = deMinimis[country] || 150;

        // Vérifier le seuil de minimis
        if (declaration.totalValue < threshold) {
            return {
                duties: 0,
                taxes: 0,
                deMinimisApplied: true,
                threshold
            };
        }

        // Calculer les droits par item
        let totalDuties = 0;
        for (const item of declaration.items) {
            const hsPrefix = item.hsCode?.substring(0, 4);
            const dutyRate = countryDutyRates[hsPrefix] || countryDutyRates.default;
            totalDuties += item.totalValue * dutyRate;
        }

        // Calculer la TVA/GST
        const taxableAmount = declaration.totalValue + totalDuties;
        const taxes = taxableAmount * vatRate;

        return {
            duties: Math.round(totalDuties * 100) / 100,
            taxes: Math.round(taxes * 100) / 100,
            total: Math.round((totalDuties + taxes) * 100) / 100,
            dutyRate: countryDutyRates.default,
            vatRate,
            deMinimisApplied: false
        };
    }

    // ==========================================
    // DOCUMENTS
    // ==========================================

    getRequiredDocuments(declaration) {
        const docs = [];
        const type = declaration.type;
        const dest = declaration.destinationCountry;
        const value = declaration.totalValue;

        // Documents de base
        if (type === 'export' || type === 'import') {
            docs.push({
                type: 'commercial_invoice',
                name: 'Facture commerciale',
                required: true,
                description: 'Facture détaillée avec valeur des marchandises'
            });

            docs.push({
                type: 'packing_list',
                name: 'Liste de colisage',
                required: true,
                description: 'Détail du contenu de chaque colis'
            });
        }

        // Certificat d'origine si nécessaire
        const requiresCO = ['US', 'CA', 'AU', 'JP', 'CN'].includes(dest);
        if (requiresCO && value > 1000) {
            docs.push({
                type: 'certificate_of_origin',
                name: 'Certificat d\'origine',
                required: true,
                description: 'Attestation du pays de fabrication'
            });
        }

        // EUR.1 pour certains pays avec accords préférentiels
        const eur1Countries = ['CH', 'NO', 'IS', 'TR', 'MA', 'TN'];
        if (eur1Countries.includes(dest) && declaration.originCountry === 'FR') {
            docs.push({
                type: 'eur1',
                name: 'Certificat EUR.1',
                required: false,
                description: 'Pour bénéficier de droits de douane réduits'
            });
        }

        // Documents spécifiques par destination
        if (dest === 'US' && value > 2500) {
            docs.push({
                type: 'aes_filing',
                name: 'AES (Automated Export System)',
                required: true,
                description: 'Déclaration électronique obligatoire'
            });
        }

        if (dest === 'GB') {
            docs.push({
                type: 'customs_declaration',
                name: 'Déclaration CN22/CN23',
                required: true,
                description: 'Déclaration douanière post-Brexit'
            });
        }

        // Documents pour produits réglementés
        const hasRegulatedProducts = declaration.items.some(item => 
            this.isRegulatedProduct(item.hsCode)
        );

        if (hasRegulatedProducts) {
            docs.push({
                type: 'compliance_certificate',
                name: 'Certificat de conformité',
                required: true,
                description: 'Certification produit requise'
            });
        }

        return docs;
    }

    isRegulatedProduct(hsCode) {
        const regulatedPrefixes = ['3004', '3303', '3304', '8471', '9503'];
        return regulatedPrefixes.some(prefix => hsCode?.startsWith(prefix));
    }

    async generateCommercialInvoice(declaration) {
        return {
            invoiceNumber: `INV-${Date.now()}`,
            date: new Date().toISOString().split('T')[0],
            exporter: declaration.exporter,
            importer: declaration.importer,
            items: declaration.items.map(item => ({
                description: item.description,
                hsCode: item.hsCode,
                countryOfOrigin: item.countryOfOrigin,
                quantity: item.quantity,
                unitPrice: item.unitValue,
                totalPrice: item.totalValue,
                currency: item.currency
            })),
            subtotal: declaration.totalValue,
            shipping: 0,
            insurance: 0,
            total: declaration.totalValue,
            currency: declaration.currency,
            incoterm: declaration.incoterm,
            paymentTerms: 'Prepaid',
            declarationText: 'We declare that the information contained in this invoice is true and correct.'
        };
    }

    // ==========================================
    // COUNTRY REGULATIONS
    // ==========================================

    async getCountryRegulations(countryCode) {
        const regulations = {
            'US': {
                name: 'United States',
                currency: 'USD',
                customsAuthority: 'CBP (Customs and Border Protection)',
                deMinimis: 800,
                vatRate: 0,
                importRestrictions: ['Certain food products', 'Plants and seeds', 'Medications'],
                requiredDocuments: ['Commercial Invoice', 'Packing List', 'Bill of Lading'],
                labeling: ['Country of origin required', 'English labeling for consumer goods'],
                notes: 'Section 321 de minimis for shipments under $800'
            },
            'GB': {
                name: 'United Kingdom',
                currency: 'GBP',
                customsAuthority: 'HMRC',
                deMinimis: 135,
                vatRate: 0.20,
                importRestrictions: ['Plants', 'Animal products', 'Weapons'],
                requiredDocuments: ['Commercial Invoice', 'CN22/CN23', 'EORI Number'],
                labeling: ['CE/UKCA marking required'],
                notes: 'Post-Brexit customs procedures apply'
            },
            'CH': {
                name: 'Switzerland',
                currency: 'CHF',
                customsAuthority: 'BAZG/OFDF',
                deMinimis: 65,
                vatRate: 0.077,
                importRestrictions: ['Meat products', 'Dairy'],
                requiredDocuments: ['Commercial Invoice', 'EUR.1 for preferential rates'],
                notes: 'Not EU member, bilateral agreements apply'
            },
            'CN': {
                name: 'China',
                currency: 'CNY',
                customsAuthority: 'GACC',
                deMinimis: 50,
                vatRate: 0.13,
                importRestrictions: ['Many categories require licenses'],
                requiredDocuments: ['Commercial Invoice', 'Packing List', 'CCC Certificate for electronics'],
                labeling: ['Chinese labeling required'],
                notes: 'Cross-border e-commerce has special rules'
            }
        };

        return regulations[countryCode] || {
            name: countryCode,
            deMinimis: 150,
            vatRate: 0.20,
            notes: 'Contact customs authority for specific requirements'
        };
    }

    // ==========================================
    // PROHIBITED & RESTRICTED ITEMS
    // ==========================================

    async checkProhibitedItems(items, destinationCountry) {
        const results = [];
        
        for (const item of items) {
            const check = await this.isItemProhibited(item, destinationCountry);
            results.push({
                item: item.description,
                hsCode: item.hsCode,
                ...check
            });
        }

        return {
            items: results,
            hasProhibited: results.some(r => r.prohibited),
            hasRestricted: results.some(r => r.restricted),
            canShip: !results.some(r => r.prohibited)
        };
    }

    async isItemProhibited(item, country) {
        // Liste simplifiée des items prohibés/restreints
        const universalProhibited = [
            'weapons', 'explosives', 'narcotics', 'counterfeit', 
            'endangered species', 'hazardous materials'
        ];

        const countrySpecific = {
            'US': ['Kinder eggs', 'Cuban cigars', 'Absinthe (certain types)'],
            'AU': ['Food products', 'Seeds', 'Wood products'],
            'NZ': ['Honey', 'Dairy products'],
            'SG': ['Chewing gum', 'E-cigarettes'],
            'SA': ['Alcohol', 'Pork products', 'Religious materials']
        };

        const itemLower = item.description.toLowerCase();
        
        const isUniversalProhibited = universalProhibited.some(p => itemLower.includes(p));
        const countryProhibited = countrySpecific[country]?.some(p => 
            itemLower.includes(p.toLowerCase())
        );

        return {
            prohibited: isUniversalProhibited || countryProhibited,
            restricted: false,
            reason: isUniversalProhibited ? 'Universally prohibited' : 
                    countryProhibited ? 'Prohibited in destination country' : null
        };
    }

    // ==========================================
    // HELPERS
    // ==========================================

    generateId(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`.toUpperCase();
    }
}

module.exports = { InternationalService };
