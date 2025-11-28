/**
 * Routz v4.0 - Service Worker
 * PWA avec cache offline et background sync
 */

const CACHE_NAME = 'routz-v4.0.0';
const STATIC_CACHE = 'routz-static-v4.0.0';
const DYNAMIC_CACHE = 'routz-dynamic-v4.0.0';
const API_CACHE = 'routz-api-v4.0.0';

// Assets statiques à mettre en cache immédiatement
const STATIC_ASSETS = [
    '/',
    '/dashboard-v2.html',
    '/shipments.html',
    '/orders.html',
    '/customers.html',
    '/settings.html',
    '/login.html',
    '/offline.html',
    '/manifest.json'
];

// URLs API à mettre en cache
const API_ROUTES = [
    '/api/v1/carriers',
    '/api/v1/user/profile'
];

// ==========================================
// INSTALLATION
// ==========================================
self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker v4.0.0');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// ==========================================
// ACTIVATION
// ==========================================
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            return name.startsWith('routz-') && 
                                   name !== STATIC_CACHE && 
                                   name !== DYNAMIC_CACHE &&
                                   name !== API_CACHE;
                        })
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

// ==========================================
// FETCH STRATEGIES
// ==========================================

// Cache First (pour assets statiques)
const cacheFirst = async (request) => {
    const cached = await caches.match(request);
    if (cached) return cached;
    
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        return caches.match('/offline.html');
    }
};

// Network First (pour API)
const networkFirst = async (request) => {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(API_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        
        return new Response(
            JSON.stringify({ error: 'offline', message: 'Vous êtes hors ligne' }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    }
};

// Stale While Revalidate (pour contenu dynamique)
const staleWhileRevalidate = async (request) => {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cached = await cache.match(request);
    
    const fetchPromise = fetch(request)
        .then((response) => {
            if (response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => cached);
    
    return cached || fetchPromise;
};

// ==========================================
// FETCH HANDLER
// ==========================================
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Ignorer les requêtes non-GET
    if (request.method !== 'GET') return;
    
    // Ignorer les requêtes externes
    if (url.origin !== location.origin) return;
    
    // API requests -> Network First
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request));
        return;
    }
    
    // Static assets -> Cache First
    if (request.destination === 'style' || 
        request.destination === 'script' ||
        request.destination === 'image' ||
        url.pathname.endsWith('.html')) {
        event.respondWith(cacheFirst(request));
        return;
    }
    
    // Autres -> Stale While Revalidate
    event.respondWith(staleWhileRevalidate(request));
});

// ==========================================
// BACKGROUND SYNC
// ==========================================
self.addEventListener('sync', (event) => {
    console.log('[SW] Background Sync:', event.tag);
    
    if (event.tag === 'sync-shipments') {
        event.waitUntil(syncShipments());
    }
    
    if (event.tag === 'sync-tracking') {
        event.waitUntil(syncTracking());
    }
});

async function syncShipments() {
    try {
        const db = await openDB();
        const pendingShipments = await db.getAll('pending-shipments');
        
        for (const shipment of pendingShipments) {
            try {
                const response = await fetch('/api/v1/shipments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(shipment.data)
                });
                
                if (response.ok) {
                    await db.delete('pending-shipments', shipment.id);
                    await notifyClients('shipment-synced', shipment.id);
                }
            } catch (error) {
                console.log('[SW] Failed to sync shipment:', shipment.id);
            }
        }
    } catch (error) {
        console.error('[SW] Sync shipments error:', error);
    }
}

async function syncTracking() {
    try {
        const response = await fetch('/api/v1/tracking/updates');
        if (response.ok) {
            const updates = await response.json();
            await notifyClients('tracking-updates', updates);
        }
    } catch (error) {
        console.error('[SW] Sync tracking error:', error);
    }
}

// ==========================================
// PUSH NOTIFICATIONS
// ==========================================
self.addEventListener('push', (event) => {
    console.log('[SW] Push notification received');
    
    let data = { title: 'Routz', body: 'Nouvelle notification' };
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }
    
    const options = {
        body: data.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        vibrate: [100, 50, 100],
        data: data.data || {},
        actions: data.actions || [
            { action: 'view', title: 'Voir' },
            { action: 'dismiss', title: 'Fermer' }
        ],
        tag: data.tag || 'routz-notification',
        renotify: true
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event.action);
    
    event.notification.close();
    
    if (event.action === 'dismiss') return;
    
    const urlToOpen = event.notification.data?.url || '/dashboard-v2.html';
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((windowClients) => {
                // Chercher une fenêtre existante
                for (const client of windowClients) {
                    if (client.url.includes(urlToOpen) && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Sinon ouvrir une nouvelle fenêtre
                if (clients.openWindow) {
                    return clients.openWindow(urlToOpen);
                }
            })
    );
});

// ==========================================
// MESSAGE HANDLER
// ==========================================
self.addEventListener('message', (event) => {
    console.log('[SW] Message received:', event.data);
    
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'CACHE_URLS') {
        event.waitUntil(
            caches.open(DYNAMIC_CACHE)
                .then((cache) => cache.addAll(event.data.urls))
        );
    }
    
    if (event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then((names) => 
                Promise.all(names.map((name) => caches.delete(name)))
            )
        );
    }
});

// ==========================================
// HELPERS
// ==========================================
async function notifyClients(type, data) {
    const allClients = await clients.matchAll({ includeUncontrolled: true });
    for (const client of allClients) {
        client.postMessage({ type, data });
    }
}

// Simple IndexedDB wrapper
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('routz-offline', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            resolve({
                getAll: (store) => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readonly');
                    const req = tx.objectStore(store).getAll();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => rej(req.error);
                }),
                delete: (store, key) => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readwrite');
                    const req = tx.objectStore(store).delete(key);
                    req.onsuccess = () => res();
                    req.onerror = () => rej(req.error);
                })
            });
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('pending-shipments')) {
                db.createObjectStore('pending-shipments', { keyPath: 'id' });
            }
        };
    });
}

console.log('[SW] Service Worker loaded');
