# 🚀 Routz Branded Tracking & Returns System

Système complet de tracking brandé et portail de retours self-service pour Routz.

## 📋 Table des matières

- [Aperçu](#aperçu)
- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Intégration](#intégration)
- [Personnalisation](#personnalisation)

---

## 🎯 Aperçu

Ce module ajoute à Routz deux fonctionnalités majeures comparables à Sendcloud et ShippingBo :

1. **Pages de Tracking Brandées** - Pages de suivi personnalisées aux couleurs de la marque
2. **Portail de Retours Self-Service** - Interface client pour gérer les retours sans intervention manuelle

### Avantages

| Métrique | Avant | Après |
|----------|-------|-------|
| Taux d'ouverture emails | ~20% | ~89% |
| Tickets support "Où est mon colis?" | 100% | -60% |
| Temps traitement retour | 15-30 min | 2-5 min |
| Cross-sell sur page tracking | 0% | 5-15% CTR |

---

## ✨ Fonctionnalités

### 📍 Tracking Brandé

- **Page de suivi personnalisée**
  - Logo, couleurs, fonts customisables
  - Timeline des événements en temps réel
  - Barre de progression visuelle
  - Estimation de livraison
  - Produits commandés avec images
  - Bannière promo configurable
  - Intégration Instagram
  - Liens réseaux sociaux

- **Emails de tracking**
  - Templates responsive multi-devices
  - Support 7 langues (FR, EN, DE, ES, IT, NL, PT)
  - Envoi automatique sur événements
  - Preview avant envoi
  - Sujet et preheader personnalisables

- **Notifications SMS** (optionnel)
  - Alertes livraison jour-même
  - Notification de livraison
  - Gestion des exceptions

- **Widget embeddable**
  - Intégration sur site e-commerce
  - Version compacte disponible
  - Script léger (<5KB)

### ↩️ Portail de Retours

- **Interface client self-service**
  - Recherche commande par N° + email/code postal
  - Sélection des articles à retourner
  - 11 motifs de retour prédéfinis
  - Upload de photos (défauts)
  - Choix du mode de retour

- **Modes de retour**
  - Point relais (gratuit ou payant)
  - Enlèvement à domicile
  - Retour en magasin

- **Génération automatique**
  - Étiquettes de retour
  - QR codes (paperless)
  - Instructions d'emballage

- **Paiement intégré** (Stripe)
  - Retours payants si configuré
  - Frais de restockage optionnels

- **Gestion admin**
  - Approbation automatique ou manuelle
  - Workflow de réception/inspection
  - Remboursements automatiques

---

## 🏗️ Architecture

```
routz-tracking-system/
├── services/
│   ├── branded-tracking.js    # Service de tracking brandé
│   └── returns-portal.js      # Service portail retours
├── templates/
│   ├── tracking-page.hbs      # Template page tracking
│   ├── tracking-email.hbs     # Template email tracking
│   └── returns-portal.hbs     # Template portail retours
├── locales/
│   └── (7 langues supportées)
├── public/
│   └── assets/
├── api-routes.js              # Routes Express
├── schema.sql                 # Tables PostgreSQL
└── README.md
```

### Technologies

- **Backend**: Node.js, Express
- **Templates**: Handlebars
- **Base de données**: PostgreSQL
- **Cache**: Redis
- **Emails**: Resend / SendGrid / Mailgun
- **SMS**: Twilio
- **Paiements**: Stripe

---

## 🛠️ Installation

### Prérequis

- Node.js 18+
- PostgreSQL 14+
- Redis 6+

### 1. Installation des dépendances

```bash
npm install express handlebars pg ioredis uuid stripe multer resend twilio
```

### 2. Variables d'environnement

```env
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/routz

# Redis
REDIS_URL=redis://localhost:6379

# Base URL
BASE_URL=https://track.votre-domaine.com

# Email (choisir un provider)
RESEND_API_KEY=re_xxxx
# ou
SENDGRID_API_KEY=SG.xxxx

# SMS (optionnel)
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_PHONE_NUMBER=+33xxxxxxxxx

# Paiements (pour retours payants)
STRIPE_SECRET_KEY=sk_xxxx
STRIPE_PUBLISHABLE_KEY=pk_xxxx
```

### 3. Migration base de données

```bash
psql $DATABASE_URL < schema.sql
```

### 4. Intégration Express

```javascript
const express = require('express');
const trackingRoutes = require('./routz-tracking-system/api-routes');

const app = express();
app.use(express.json());

// Monter les routes
app.use('/', trackingRoutes);

app.listen(3000);
```

---

## ⚙️ Configuration

### Configuration de marque

```javascript
// PUT /api/admin/brand
{
  "name": "Ma Boutique",
  "logo_url": "https://...",
  "primary_color": "#FF6B00",
  "secondary_color": "#CC5500",
  "accent_color": "#FFB800",
  "background_color": "#FFFAF5",
  "text_color": "#1A1A1A",
  "font_family": "Poppins, sans-serif",
  "border_radius": "16px",
  
  "show_carrier_logo": true,
  "show_estimated_delivery": true,
  "show_products": true,
  
  "show_promo_banner": true,
  "promo_banner_text": "-10% sur votre prochaine commande",
  "promo_banner_url": "https://...",
  
  "instagram_url": "https://instagram.com/maboutique",
  "instagram_embed": true,
  
  "support_email": "support@maboutique.fr",
  "support_phone": "01 23 45 67 89",
  
  "notifications": {
    "email": {
      "enabled": true,
      "events": ["label_created", "in_transit", "out_for_delivery", "delivered", "exception"]
    },
    "sms": {
      "enabled": true,
      "events": ["out_for_delivery", "delivered"]
    }
  }
}
```

### Configuration du portail retours

```javascript
// PUT /api/admin/returns/config
{
  "enabled": true,
  "return_window_days": 30,
  "auto_approve": true,
  "require_photos": false,
  "allow_partial_returns": true,
  
  "methods": {
    "dropoff": { "enabled": true, "price": 0, "label": "Point relais" },
    "pickup": { "enabled": true, "price": 4.99, "label": "Enlèvement à domicile" },
    "store": { "enabled": false }
  },
  
  "restocking_fee_percent": 10,
  "free_return_threshold": 100,
  
  "return_carriers": ["colissimo", "mondial_relay"],
  "default_carrier": "colissimo",
  
  "refund_methods": ["original_payment", "store_credit"],
  "default_refund_method": "original_payment",
  
  "enable_qr_code": true,
  
  "terms_url": "https://maboutique.fr/cgv"
}
```

---

## 📚 API Reference

### Tracking

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/t/:trackingNumber` | GET | Page de tracking publique |
| `/api/tracking/:trackingNumber` | GET | Données tracking JSON |
| `/api/tracking/widget/:trackingNumber` | GET | Widget HTML embeddable |
| `/api/admin/brand` | GET/PUT | Configuration marque |
| `/api/admin/brand/preview` | POST | Preview email |

### Retours

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/returns/:orgId` | GET | Portail retours public |
| `/api/returns/find-order` | POST | Rechercher une commande |
| `/api/returns/create` | POST | Créer demande de retour |
| `/api/returns/track/:rmaId` | GET | Suivre un retour |
| `/api/returns/upload-photos` | POST | Upload photos |
| `/api/returns/create-payment` | POST | Créer paiement Stripe |
| `/api/returns/confirm-payment` | POST | Confirmer paiement |
| `/api/admin/returns/config` | GET/PUT | Configuration portail |

### Webhooks

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/webhooks/carrier/:carrier` | POST | Mises à jour transporteur |

---

## 🔌 Intégration

### Widget de tracking sur votre site

```html
<!-- Inclure le script -->
<script src="https://track.routz.io/embed/tracking.js"></script>

<!-- Container pour le widget -->
<div id="tracking-widget"></div>

<!-- Initialiser -->
<script>
  RoutzTracking.init({ apiKey: 'votre-api-key' });
  
  // Afficher le tracking
  RoutzTracking.render('#tracking-widget', 'TRACKING123', {
    lang: 'fr',
    height: '500px'
  });
  
  // Ou version compacte
  RoutzTracking.widget('#tracking-widget', 'TRACKING123', {
    compact: true
  });
</script>
```

### Lien de tracking dans vos emails

```
https://track.routz.io/t/{{tracking_number}}?lang=fr
```

### Lien vers portail retours

```
https://track.routz.io/returns/{{org_id}}?order={{order_number}}&lang=fr
```

### Webhook transporteur

Configurez vos transporteurs pour envoyer les mises à jour vers :
```
POST https://track.routz.io/webhooks/carrier/colissimo
POST https://track.routz.io/webhooks/carrier/chronopost
POST https://track.routz.io/webhooks/carrier/mondial_relay
```

---

## 🎨 Personnalisation

### CSS personnalisé

Ajoutez du CSS custom dans la configuration de marque :

```css
/* Exemple de personnalisation */
.tracking-header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.promo-banner {
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.02); }
}
```

### Templates email personnalisés

Créez des templates personnalisés par événement dans la table `email_templates` :

```sql
INSERT INTO email_templates (organization_id, event_type, language, subject, html_content)
VALUES (
  'org-uuid',
  'delivered',
  'fr',
  '🎉 {{customer_name}}, votre colis est arrivé !',
  '<html>...</html>'
);
```

### Motifs de retour personnalisés

```javascript
{
  "custom_reasons": [
    { "code": "CUSTOM_1", "label": "Motif spécifique", "icon": "🔧", "refundable": true },
    // ...
  ]
}
```

---

## 📊 Analytics

Le système collecte automatiquement des statistiques :

- Vues de pages de tracking
- Clics sur bannière promo
- Clics réseaux sociaux
- Initiations de retour
- Temps passé sur la page
- Device/navigateur
- Géolocalisation

Accédez aux analytics via :
```sql
SELECT 
  DATE(viewed_at) as date,
  COUNT(*) as views,
  COUNT(DISTINCT visitor_id) as unique_visitors,
  SUM(CASE WHEN clicked_promo THEN 1 ELSE 0 END) as promo_clicks,
  AVG(time_on_page) as avg_time
FROM tracking_analytics
WHERE organization_id = 'your-org-id'
GROUP BY DATE(viewed_at)
ORDER BY date DESC;
```

---

## 🌍 Langues supportées

| Code | Langue |
|------|--------|
| `fr` | Français |
| `en` | English |
| `de` | Deutsch |
| `es` | Español |
| `it` | Italiano |
| `nl` | Nederlands |
| `pt` | Português |
| `pl` | Polski |

---

## 🔒 Sécurité

- Validation des entrées utilisateur
- Rate limiting sur les API publiques
- Vérification commande par email/code postal
- Tokens JWT pour l'admin API
- Logs des notifications
- RGPD compliant (données minimales)

---

## 📈 Roadmap

- [ ] Notifications WhatsApp Business
- [ ] Carte temps réel du colis
- [ ] A/B testing des bannières promo
- [ ] Intégration Instagram Shopping
- [ ] Chatbot support intégré
- [ ] App mobile tracking

---

## 🤝 Support

Pour toute question ou assistance :
- Documentation : https://docs.routz.io
- Email : support@routz.io
- Discord : https://discord.gg/routz

---

**Routz** - Simplifiez votre logistique e-commerce 🚀
