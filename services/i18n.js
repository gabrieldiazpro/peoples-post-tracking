/**
 * ROUTZ - Internationalization (i18n) System
 * Multi-language support for API responses, emails, notifications
 */

const config = {
    defaultLocale: 'fr',
    supportedLocales: ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt', 'pl'],
    fallbackLocale: 'en'
};

const translations = {
    fr: {
        common: {
            yes: 'Oui', no: 'Non', ok: 'OK', cancel: 'Annuler', save: 'Enregistrer',
            delete: 'Supprimer', edit: 'Modifier', create: 'Créer', search: 'Rechercher',
            filter: 'Filtrer', export: 'Exporter', import: 'Importer', loading: 'Chargement...',
            error: 'Erreur', success: 'Succès', warning: 'Attention', info: 'Information',
            back: 'Retour', next: 'Suivant', close: 'Fermer', noResults: 'Aucun résultat',
            download: 'Télécharger', upload: 'Téléverser', select: 'Sélectionner',
            actions: 'Actions', details: 'Détails', date: 'Date', time: 'Heure', status: 'Statut'
        },
        errors: {
            generic: 'Une erreur est survenue. Veuillez réessayer.',
            notFound: 'Ressource non trouvée',
            unauthorized: 'Accès non autorisé',
            forbidden: 'Accès interdit',
            validationFailed: 'La validation a échoué',
            serverError: 'Erreur serveur. Veuillez réessayer ultérieurement.',
            networkError: 'Erreur de connexion réseau',
            timeout: 'La requête a expiré',
            rateLimited: 'Trop de requêtes. Veuillez patienter.',
            invalidCredentials: 'Email ou mot de passe incorrect',
            emailExists: 'Cette adresse email est déjà utilisée',
            weakPassword: 'Le mot de passe est trop faible',
            invalidToken: 'Token invalide ou expiré',
            sessionExpired: 'Votre session a expiré',
            insufficientPermissions: 'Permissions insuffisantes'
        },
        shipmentStatus: {
            pending: 'En attente', label_created: 'Étiquette créée', picked_up: 'Pris en charge',
            in_transit: 'En transit', out_for_delivery: 'En cours de livraison', delivered: 'Livré',
            exception: 'Exception', returned: 'Retourné', cancelled: 'Annulé'
        },
        shipments: {
            created: 'Expédition créée avec succès', updated: 'Expédition mise à jour',
            cancelled: 'Expédition annulée', labelGenerated: 'Étiquette générée',
            trackingUpdated: 'Suivi mis à jour', bulkCreated: '{count} expéditions créées',
            noShipments: 'Aucune expédition', weight: 'Poids', dimensions: 'Dimensions',
            reference: 'Référence', trackingNumber: 'Numéro de suivi', carrier: 'Transporteur',
            service: 'Service', sender: 'Expéditeur', recipient: 'Destinataire',
            estimatedDelivery: 'Livraison estimée', signature: 'Signature', insurance: 'Assurance'
        },
        orderStatus: {
            pending: 'En attente', processing: 'En cours', shipped: 'Expédié',
            delivered: 'Livré', cancelled: 'Annulé', refunded: 'Remboursé', on_hold: 'En attente'
        },
        orders: {
            created: 'Commande créée', updated: 'Commande mise à jour', shipped: 'Commande expédiée',
            noOrders: 'Aucune commande', orderNumber: 'N° de commande', customer: 'Client',
            items: 'Articles', total: 'Total', subtotal: 'Sous-total', shipping: 'Frais de port',
            tax: 'TVA', discount: 'Remise'
        },
        returnStatus: {
            requested: 'Demandé', approved: 'Approuvé', rejected: 'Refusé', label_sent: 'Étiquette envoyée',
            in_transit: 'En transit', received: 'Reçu', inspected: 'Inspecté', refunded: 'Remboursé', closed: 'Clôturé'
        },
        returnReasons: {
            defective: 'Produit défectueux', wrong_item: 'Mauvais article',
            not_as_described: 'Non conforme à la description', no_longer_needed: 'Plus besoin',
            arrived_late: 'Arrivé en retard', other: 'Autre'
        },
        auth: {
            login: 'Connexion', logout: 'Déconnexion', register: 'Inscription',
            forgotPassword: 'Mot de passe oublié', resetPassword: 'Réinitialiser le mot de passe',
            changePassword: 'Changer le mot de passe', email: 'Email', password: 'Mot de passe',
            confirmPassword: 'Confirmer le mot de passe', rememberMe: 'Se souvenir de moi',
            loginSuccess: 'Connexion réussie', registerSuccess: 'Inscription réussie',
            resetEmailSent: 'Email de réinitialisation envoyé', passwordChanged: 'Mot de passe modifié',
            mfaRequired: 'Vérification à deux facteurs requise', mfaEnabled: '2FA activée'
        },
        carriers: {
            colissimo: 'Colissimo', chronopost: 'Chronopost', mondial_relay: 'Mondial Relay',
            dhl: 'DHL', ups: 'UPS', fedex: 'FedEx', gls: 'GLS', dpd: 'DPD', tnt: 'TNT',
            connectionSuccess: 'Connexion au transporteur réussie',
            connectionFailed: 'Échec de la connexion au transporteur',
            ratesRetrieved: 'Tarifs récupérés', noRatesAvailable: 'Aucun tarif disponible'
        },
        billing: {
            subscription: 'Abonnement', plan: 'Plan', trial: 'Essai', starter: 'Starter',
            pro: 'Pro', business: 'Business', enterprise: 'Enterprise',
            monthly: 'Mensuel', yearly: 'Annuel', currentPlan: 'Plan actuel',
            upgradePlan: 'Changer de plan', cancelSubscription: 'Annuler l\'abonnement',
            paymentMethod: 'Moyen de paiement', invoice: 'Facture', invoices: 'Factures',
            nextBillingDate: 'Prochaine facturation', usageThisMonth: 'Utilisation ce mois',
            shipmentsUsed: 'Expéditions utilisées', limitReached: 'Limite atteinte'
        },
        notifications: {
            shipmentCreated: 'Nouvelle expédition créée', shipmentDelivered: 'Colis livré',
            shipmentException: 'Exception de livraison', orderReceived: 'Nouvelle commande reçue',
            returnRequested: 'Demande de retour', paymentFailed: 'Échec du paiement',
            markAsRead: 'Marquer comme lu', markAllAsRead: 'Tout marquer comme lu'
        },
        emails: {
            shipmentCreated: {
                subject: 'Votre colis {tracking_number} a été expédié',
                greeting: 'Bonjour {name}',
                body: 'Votre colis avec le numéro de suivi {tracking_number} a été confié à {carrier}.',
                trackButton: 'Suivre mon colis', footer: 'Cordialement'
            },
            shipmentDelivered: {
                subject: 'Votre colis {tracking_number} a été livré',
                body: 'Votre colis a été livré le {date}.', footer: 'Merci pour votre confiance !'
            },
            shipmentException: {
                subject: '⚠️ Problème de livraison - Colis {tracking_number}',
                body: 'Un problème est survenu lors de la livraison de votre colis.'
            },
            passwordReset: {
                subject: 'Réinitialisation de votre mot de passe',
                button: 'Réinitialiser mon mot de passe', expiry: 'Ce lien expire dans 1 heure.',
                ignore: 'Si vous n\'avez pas demandé cette réinitialisation, ignorez cet email.'
            },
            invitation: {
                subject: 'Vous êtes invité à rejoindre {organization} sur Routz',
                body: 'Vous avez été invité à rejoindre {organization} en tant que {role}.',
                button: 'Accepter l\'invitation', expiry: 'Cette invitation expire dans 7 jours.'
            },
            dailyReport: {
                subject: 'Rapport quotidien - {date}', summary: 'Résumé de la journée',
                shipmentsCreated: 'Expéditions créées', shipmentsDelivered: 'Colis livrés',
                exceptions: 'Exceptions', viewDashboard: 'Voir le dashboard'
            }
        },
        api: {
            success: 'Opération réussie', created: 'Ressource créée', updated: 'Ressource mise à jour',
            deleted: 'Ressource supprimée', notFound: 'Ressource non trouvée',
            invalidRequest: 'Requête invalide', missingField: 'Champ requis manquant : {field}',
            invalidField: 'Valeur invalide pour le champ : {field}', duplicateEntry: 'Entrée en double'
        },
        validation: {
            required: 'Ce champ est requis', email: 'Email invalide',
            minLength: 'Minimum {min} caractères', maxLength: 'Maximum {max} caractères',
            pattern: 'Format invalide', numeric: 'Doit être un nombre', positive: 'Doit être positif',
            phone: 'Numéro de téléphone invalide', postalCode: 'Code postal invalide'
        },
        units: { kg: 'kg', g: 'g', cm: 'cm', days: 'jours', day: 'jour', hours: 'heures', hour: 'heure' },
        countries: {
            FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne',
            ES: 'Espagne', IT: 'Italie', NL: 'Pays-Bas', PT: 'Portugal', GB: 'Royaume-Uni',
            AT: 'Autriche', PL: 'Pologne', US: 'États-Unis', CA: 'Canada'
        }
    },
    en: {
        common: {
            yes: 'Yes', no: 'No', ok: 'OK', cancel: 'Cancel', save: 'Save',
            delete: 'Delete', edit: 'Edit', create: 'Create', search: 'Search',
            filter: 'Filter', export: 'Export', import: 'Import', loading: 'Loading...',
            error: 'Error', success: 'Success', warning: 'Warning', info: 'Information',
            back: 'Back', next: 'Next', close: 'Close', noResults: 'No results',
            download: 'Download', upload: 'Upload', select: 'Select',
            actions: 'Actions', details: 'Details', date: 'Date', time: 'Time', status: 'Status'
        },
        errors: {
            generic: 'An error occurred. Please try again.',
            notFound: 'Resource not found', unauthorized: 'Unauthorized access',
            forbidden: 'Access forbidden', validationFailed: 'Validation failed',
            serverError: 'Server error. Please try again later.',
            rateLimited: 'Too many requests. Please wait.',
            invalidCredentials: 'Invalid email or password',
            sessionExpired: 'Your session has expired'
        },
        shipmentStatus: {
            pending: 'Pending', label_created: 'Label created', picked_up: 'Picked up',
            in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered',
            exception: 'Exception', returned: 'Returned', cancelled: 'Cancelled'
        },
        shipments: {
            created: 'Shipment created successfully', updated: 'Shipment updated',
            cancelled: 'Shipment cancelled', labelGenerated: 'Label generated',
            bulkCreated: '{count} shipments created', noShipments: 'No shipments',
            weight: 'Weight', trackingNumber: 'Tracking number', carrier: 'Carrier'
        },
        orderStatus: {
            pending: 'Pending', processing: 'Processing', shipped: 'Shipped',
            delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded'
        },
        returnStatus: {
            requested: 'Requested', approved: 'Approved', rejected: 'Rejected',
            received: 'Received', refunded: 'Refunded', closed: 'Closed'
        },
        returnReasons: {
            defective: 'Defective product', wrong_item: 'Wrong item',
            not_as_described: 'Not as described', no_longer_needed: 'No longer needed', other: 'Other'
        },
        auth: {
            login: 'Login', logout: 'Logout', register: 'Register', email: 'Email',
            password: 'Password', loginSuccess: 'Login successful', resetEmailSent: 'Reset email sent'
        },
        carriers: {
            colissimo: 'Colissimo', chronopost: 'Chronopost', dhl: 'DHL', ups: 'UPS', fedex: 'FedEx'
        },
        billing: {
            subscription: 'Subscription', plan: 'Plan', trial: 'Trial',
            starter: 'Starter', pro: 'Pro', business: 'Business', invoice: 'Invoice'
        },
        emails: {
            shipmentCreated: {
                subject: 'Your package {tracking_number} has been shipped',
                greeting: 'Hello {name}',
                body: 'Your package has been handed over to {carrier}.',
                trackButton: 'Track my package'
            },
            passwordReset: {
                subject: 'Reset your password',
                button: 'Reset my password', expiry: 'This link expires in 1 hour.'
            }
        },
        validation: {
            required: 'This field is required', email: 'Invalid email',
            minLength: 'Minimum {min} characters', maxLength: 'Maximum {max} characters'
        },
        countries: {
            FR: 'France', BE: 'Belgium', CH: 'Switzerland', DE: 'Germany',
            ES: 'Spain', IT: 'Italy', NL: 'Netherlands', GB: 'United Kingdom', US: 'United States'
        }
    },
    de: {
        common: { yes: 'Ja', no: 'Nein', ok: 'OK', cancel: 'Abbrechen', save: 'Speichern', loading: 'Wird geladen...' },
        errors: { generic: 'Ein Fehler ist aufgetreten.', notFound: 'Nicht gefunden' },
        shipmentStatus: { pending: 'Ausstehend', in_transit: 'Unterwegs', delivered: 'Zugestellt', cancelled: 'Storniert' },
        countries: { FR: 'Frankreich', DE: 'Deutschland', CH: 'Schweiz', AT: 'Österreich' }
    },
    es: {
        common: { yes: 'Sí', no: 'No', ok: 'OK', cancel: 'Cancelar', save: 'Guardar', loading: 'Cargando...' },
        errors: { generic: 'Ha ocurrido un error.', notFound: 'No encontrado' },
        shipmentStatus: { pending: 'Pendiente', in_transit: 'En tránsito', delivered: 'Entregado', cancelled: 'Cancelado' },
        countries: { FR: 'Francia', ES: 'España', DE: 'Alemania', IT: 'Italia', PT: 'Portugal' }
    },
    it: {
        common: { yes: 'Sì', no: 'No', ok: 'OK', cancel: 'Annulla', save: 'Salva', loading: 'Caricamento...' },
        shipmentStatus: { pending: 'In attesa', in_transit: 'In transito', delivered: 'Consegnato', cancelled: 'Annullato' },
        countries: { FR: 'Francia', IT: 'Italia', DE: 'Germania', ES: 'Spagna' }
    }
};

class I18nService {
    constructor() {
        this.translations = translations;
        this.defaultLocale = config.defaultLocale;
        this.fallbackLocale = config.fallbackLocale;
    }

    t(key, locale = this.defaultLocale, params = {}) {
        const keys = key.split('.');
        let translation = this.getNestedTranslation(this.translations[locale], keys);
        if (!translation && locale !== this.fallbackLocale) {
            translation = this.getNestedTranslation(this.translations[this.fallbackLocale], keys);
        }
        if (!translation) return key;
        return this.interpolate(translation, params);
    }

    getNestedTranslation(obj, keys) {
        return keys.reduce((current, key) => current && current[key] !== undefined ? current[key] : null, obj);
    }

    interpolate(str, params) {
        if (typeof str !== 'string') return str;
        return str.replace(/{(\w+)}/g, (match, key) => params[key] !== undefined ? params[key] : match);
    }

    getNamespace(namespace, locale = this.defaultLocale) {
        return this.translations[locale]?.[namespace] || this.translations[this.fallbackLocale]?.[namespace] || {};
    }

    isSupported(locale) { return config.supportedLocales.includes(locale); }
    getSupportedLocales() { return config.supportedLocales; }

    detectLocale(req) {
        if (req.query?.lang && this.isSupported(req.query.lang)) return req.query.lang;
        if (req.user?.language && this.isSupported(req.user.language)) return req.user.language;
        const acceptLanguage = req.headers?.['accept-language'];
        if (acceptLanguage) {
            const preferred = acceptLanguage.split(',').map(l => l.split(';')[0].trim().substring(0, 2).toLowerCase())
                .find(l => this.isSupported(l));
            if (preferred) return preferred;
        }
        return this.defaultLocale;
    }

    formatDate(date, locale = this.defaultLocale, options = {}) {
        return new Date(date).toLocaleDateString(locale, { dateStyle: 'medium', ...options });
    }

    formatNumber(number, locale = this.defaultLocale, options = {}) {
        return new Intl.NumberFormat(locale, options).format(number);
    }

    formatCurrency(amount, currency = 'EUR', locale = this.defaultLocale) {
        return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
    }

    plural(count, key, locale = this.defaultLocale) {
        const forms = this.t(key, locale);
        if (typeof forms === 'object') {
            if (count === 0 && forms.zero) return this.interpolate(forms.zero, { count });
            if (count === 1 && forms.one) return this.interpolate(forms.one, { count });
            return this.interpolate(forms.other || forms.many, { count });
        }
        return this.interpolate(forms, { count });
    }
}

const i18n = new I18nService();

const i18nMiddleware = (req, res, next) => {
    req.locale = i18n.detectLocale(req);
    req.t = (key, params) => i18n.t(key, req.locale, params);
    req.formatDate = (date, options) => i18n.formatDate(date, req.locale, options);
    req.formatNumber = (num, options) => i18n.formatNumber(num, req.locale, options);
    req.formatCurrency = (amount, currency) => i18n.formatCurrency(amount, currency, req.locale);
    res.set('Content-Language', req.locale);
    next();
};

module.exports = { I18nService, i18n, i18nMiddleware, translations, config };
