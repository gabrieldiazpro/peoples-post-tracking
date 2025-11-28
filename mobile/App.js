/**
 * Routz Mobile App - React Native
 * Application mobile iOS/Android pour la gestion logistique
 */

// ==========================================
// App.js - Point d'entrée
// ==========================================

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Provider } from 'react-redux';
import { store } from './store';

// Screens
import DashboardScreen from './screens/DashboardScreen';
import ShipmentsScreen from './screens/ShipmentsScreen';
import ShipmentDetailScreen from './screens/ShipmentDetailScreen';
import ScanScreen from './screens/ScanScreen';
import OrdersScreen from './screens/OrdersScreen';
import ProfileScreen from './screens/ProfileScreen';

// Icons
import { Ionicons } from '@expo/vector-icons';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Stack Navigator pour Shipments
function ShipmentsStack() {
    return (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="ShipmentsList" component={ShipmentsScreen} />
            <Stack.Screen name="ShipmentDetail" component={ShipmentDetailScreen} />
        </Stack.Navigator>
    );
}

// Tab Navigator principal
function MainTabs() {
    return (
        <Tab.Navigator
            screenOptions={({ route }) => ({
                tabBarIcon: ({ focused, color, size }) => {
                    let iconName;
                    switch (route.name) {
                        case 'Dashboard': iconName = focused ? 'home' : 'home-outline'; break;
                        case 'Shipments': iconName = focused ? 'cube' : 'cube-outline'; break;
                        case 'Scan': iconName = focused ? 'scan' : 'scan-outline'; break;
                        case 'Orders': iconName = focused ? 'cart' : 'cart-outline'; break;
                        case 'Profile': iconName = focused ? 'person' : 'person-outline'; break;
                    }
                    return <Ionicons name={iconName} size={size} color={color} />;
                },
                tabBarActiveTintColor: '#00FF88',
                tabBarInactiveTintColor: '#9CA3AF',
                tabBarStyle: {
                    backgroundColor: '#FFFFFF',
                    borderTopWidth: 1,
                    borderTopColor: '#E5E7EB',
                    paddingBottom: 8,
                    paddingTop: 8,
                    height: 85,
                },
                tabBarLabelStyle: {
                    fontSize: 12,
                    fontWeight: '500',
                },
                headerShown: false,
            })}
        >
            <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Accueil' }} />
            <Tab.Screen name="Shipments" component={ShipmentsStack} options={{ title: 'Expéditions' }} />
            <Tab.Screen name="Scan" component={ScanScreen} options={{ title: 'Scanner' }} />
            <Tab.Screen name="Orders" component={OrdersScreen} options={{ title: 'Commandes' }} />
            <Tab.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profil' }} />
        </Tab.Navigator>
    );
}

export default function App() {
    return (
        <Provider store={store}>
            <NavigationContainer>
                <StatusBar style="dark" />
                <MainTabs />
            </NavigationContainer>
        </Provider>
    );
}

// ==========================================
// screens/DashboardScreen.js
// ==========================================

import React from 'react';
import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity,
    SafeAreaView, RefreshControl
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export default function DashboardScreen({ navigation }) {
    const [refreshing, setRefreshing] = React.useState(false);

    const stats = [
        { label: 'Expéditions', value: '127', change: '+12%', color: '#00FF88' },
        { label: 'En transit', value: '43', change: '', color: '#00B4D8' },
        { label: 'Livrées', value: '84', change: '+8%', color: '#9B5DE5' },
        { label: 'Retours', value: '5', change: '-2', color: '#F15BB5' },
    ];

    const recentShipments = [
        { id: '6L123456789FR', status: 'delivered', customer: 'Jean D.', time: 'Il y a 2h' },
        { id: '6L987654321FR', status: 'in_transit', customer: 'Marie L.', time: 'Il y a 4h' },
        { id: 'XY123456789', status: 'shipped', customer: 'Pierre M.', time: 'Il y a 6h' },
    ];

    const statusColors = {
        delivered: '#10B981',
        in_transit: '#3B82F6',
        shipped: '#8B5CF6',
        pending: '#F59E0B',
    };

    const onRefresh = React.useCallback(() => {
        setRefreshing(true);
        setTimeout(() => setRefreshing(false), 2000);
    }, []);

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#00FF88" />}
            >
                {/* Header */}
                <View style={styles.header}>
                    <View>
                        <Text style={styles.greeting}>Bonjour 👋</Text>
                        <Text style={styles.title}>Ma Boutique</Text>
                    </View>
                    <TouchableOpacity style={styles.notificationBtn}>
                        <Ionicons name="notifications-outline" size={24} color="#1F2937" />
                        <View style={styles.notificationBadge} />
                    </TouchableOpacity>
                </View>

                {/* Stats Cards */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statsContainer}>
                    {stats.map((stat, i) => (
                        <LinearGradient
                            key={i}
                            colors={[stat.color + '20', stat.color + '10']}
                            style={styles.statCard}
                        >
                            <Text style={styles.statValue}>{stat.value}</Text>
                            <Text style={styles.statLabel}>{stat.label}</Text>
                            {stat.change && (
                                <Text style={[styles.statChange, { color: stat.change.startsWith('+') ? '#10B981' : '#EF4444' }]}>
                                    {stat.change}
                                </Text>
                            )}
                        </LinearGradient>
                    ))}
                </ScrollView>

                {/* Quick Actions */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Actions rapides</Text>
                    <View style={styles.actionsGrid}>
                        {[
                            { icon: 'add-circle', label: 'Nouvelle\nexpédition', color: '#00FF88' },
                            { icon: 'scan', label: 'Scanner\ncolis', color: '#00B4D8' },
                            { icon: 'print', label: 'Imprimer\nétiquettes', color: '#9B5DE5' },
                            { icon: 'sync', label: 'Synchro\ncommandes', color: '#F15BB5' },
                        ].map((action, i) => (
                            <TouchableOpacity key={i} style={styles.actionCard}>
                                <View style={[styles.actionIcon, { backgroundColor: action.color + '20' }]}>
                                    <Ionicons name={action.icon} size={24} color={action.color} />
                                </View>
                                <Text style={styles.actionLabel}>{action.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>

                {/* Recent Shipments */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>Expéditions récentes</Text>
                        <TouchableOpacity onPress={() => navigation.navigate('Shipments')}>
                            <Text style={styles.seeAll}>Voir tout</Text>
                        </TouchableOpacity>
                    </View>
                    {recentShipments.map((shipment, i) => (
                        <TouchableOpacity key={i} style={styles.shipmentCard}>
                            <View style={[styles.statusDot, { backgroundColor: statusColors[shipment.status] }]} />
                            <View style={styles.shipmentInfo}>
                                <Text style={styles.shipmentId}>{shipment.id}</Text>
                                <Text style={styles.shipmentCustomer}>{shipment.customer}</Text>
                            </View>
                            <Text style={styles.shipmentTime}>{shipment.time}</Text>
                            <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
                        </TouchableOpacity>
                    ))}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F9FAFB' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
    greeting: { fontSize: 14, color: '#6B7280' },
    title: { fontSize: 24, fontWeight: '700', color: '#1F2937' },
    notificationBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10 },
    notificationBadge: { position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
    statsContainer: { paddingHorizontal: 16, marginBottom: 20 },
    statCard: { width: 130, padding: 16, borderRadius: 16, marginRight: 12 },
    statValue: { fontSize: 28, fontWeight: '700', color: '#1F2937' },
    statLabel: { fontSize: 13, color: '#6B7280', marginTop: 4 },
    statChange: { fontSize: 12, fontWeight: '600', marginTop: 8 },
    section: { padding: 20 },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    sectionTitle: { fontSize: 18, fontWeight: '600', color: '#1F2937', marginBottom: 16 },
    seeAll: { fontSize: 14, color: '#00D4AA', fontWeight: '500' },
    actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    actionCard: { width: '47%', backgroundColor: '#FFF', borderRadius: 16, padding: 16, alignItems: 'center' },
    actionIcon: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
    actionLabel: { fontSize: 13, color: '#1F2937', textAlign: 'center', fontWeight: '500' },
    shipmentCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginBottom: 8 },
    statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
    shipmentInfo: { flex: 1 },
    shipmentId: { fontSize: 14, fontWeight: '600', color: '#1F2937' },
    shipmentCustomer: { fontSize: 12, color: '#6B7280', marginTop: 2 },
    shipmentTime: { fontSize: 12, color: '#9CA3AF', marginRight: 8 },
});

// ==========================================
// screens/ScanScreen.js
// ==========================================

import React, { useState, useEffect } from 'react';
import {
    View, Text, StyleSheet, TouchableOpacity, Vibration,
    SafeAreaView, Alert, Animated
} from 'react-native';
import { Camera } from 'expo-camera';
import { BarCodeScanner } from 'expo-barcode-scanner';
import { Ionicons } from '@expo/vector-icons';

export default function ScanScreen() {
    const [hasPermission, setHasPermission] = useState(null);
    const [scanned, setScanned] = useState(false);
    const [flashOn, setFlashOn] = useState(false);
    const [scanResult, setScanResult] = useState(null);
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    useEffect(() => {
        (async () => {
            const { status } = await Camera.requestCameraPermissionsAsync();
            setHasPermission(status === 'granted');
        })();

        // Animation de pulse pour le cadre
        Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, useNativeDriver: true }),
                Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
            ])
        ).start();
    }, []);

    const handleBarCodeScanned = ({ type, data }) => {
        if (scanned) return;
        setScanned(true);
        Vibration.vibrate(100);

        // Simuler la recherche du colis
        setScanResult({
            tracking: data,
            status: 'in_transit',
            carrier: 'Colissimo',
            customer: 'Jean Dupont',
            destination: 'Paris 75001',
        });
    };

    const resetScan = () => {
        setScanned(false);
        setScanResult(null);
    };

    if (hasPermission === null) {
        return <View style={styles.container}><Text>Demande d'accès caméra...</Text></View>;
    }
    if (hasPermission === false) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.permissionError}>
                    <Ionicons name="camera-off" size={64} color="#9CA3AF" />
                    <Text style={styles.errorText}>Accès caméra refusé</Text>
                    <Text style={styles.errorSubtext}>Activez l'accès caméra dans les paramètres</Text>
                </View>
            </SafeAreaView>
        );
    }

    return (
        <View style={styles.container}>
            <Camera
                style={StyleSheet.absoluteFillObject}
                barCodeScannerSettings={{
                    barCodeTypes: [BarCodeScanner.Constants.BarCodeType.qr, BarCodeScanner.Constants.BarCodeType.code128],
                }}
                onBarCodeScanned={handleBarCodeScanned}
                flashMode={flashOn ? Camera.Constants.FlashMode.torch : Camera.Constants.FlashMode.off}
            />

            {/* Overlay */}
            <View style={styles.overlay}>
                <SafeAreaView style={styles.topBar}>
                    <Text style={styles.topTitle}>Scanner un colis</Text>
                    <TouchableOpacity style={styles.flashBtn} onPress={() => setFlashOn(!flashOn)}>
                        <Ionicons name={flashOn ? 'flash' : 'flash-off'} size={24} color="#FFF" />
                    </TouchableOpacity>
                </SafeAreaView>

                {/* Scan Frame */}
                <View style={styles.scanArea}>
                    <Animated.View style={[styles.scanFrame, { transform: [{ scale: pulseAnim }] }]}>
                        <View style={[styles.corner, styles.topLeft]} />
                        <View style={[styles.corner, styles.topRight]} />
                        <View style={[styles.corner, styles.bottomLeft]} />
                        <View style={[styles.corner, styles.bottomRight]} />
                    </Animated.View>
                    <Text style={styles.scanHint}>Placez le code-barres dans le cadre</Text>
                </View>

                {/* Action Buttons */}
                <View style={styles.bottomActions}>
                    <TouchableOpacity style={styles.actionBtn}>
                        <Ionicons name="images-outline" size={24} color="#FFF" />
                        <Text style={styles.actionBtnText}>Galerie</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionBtn}>
                        <Ionicons name="create-outline" size={24} color="#FFF" />
                        <Text style={styles.actionBtnText}>Manuel</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Result Modal */}
            {scanResult && (
                <View style={styles.resultModal}>
                    <View style={styles.resultCard}>
                        <View style={styles.resultHeader}>
                            <Ionicons name="checkmark-circle" size={32} color="#10B981" />
                            <Text style={styles.resultTitle}>Colis trouvé</Text>
                        </View>
                        <View style={styles.resultInfo}>
                            <View style={styles.resultRow}>
                                <Text style={styles.resultLabel}>Tracking</Text>
                                <Text style={styles.resultValue}>{scanResult.tracking}</Text>
                            </View>
                            <View style={styles.resultRow}>
                                <Text style={styles.resultLabel}>Transporteur</Text>
                                <Text style={styles.resultValue}>{scanResult.carrier}</Text>
                            </View>
                            <View style={styles.resultRow}>
                                <Text style={styles.resultLabel}>Client</Text>
                                <Text style={styles.resultValue}>{scanResult.customer}</Text>
                            </View>
                            <View style={styles.resultRow}>
                                <Text style={styles.resultLabel}>Destination</Text>
                                <Text style={styles.resultValue}>{scanResult.destination}</Text>
                            </View>
                        </View>
                        <View style={styles.resultActions}>
                            <TouchableOpacity style={styles.resultActionBtn} onPress={resetScan}>
                                <Text style={styles.resultActionText}>Scanner un autre</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.resultActionBtn, styles.primaryBtn]}>
                                <Text style={styles.primaryBtnText}>Voir détails</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 60 },
    topTitle: { fontSize: 18, fontWeight: '600', color: '#FFF' },
    flashBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
    scanArea: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    scanFrame: { width: 250, height: 250, position: 'relative' },
    corner: { position: 'absolute', width: 30, height: 30, borderColor: '#00FF88', borderWidth: 3 },
    topLeft: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
    topRight: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
    bottomLeft: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
    bottomRight: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
    scanHint: { color: '#FFF', marginTop: 24, fontSize: 14 },
    bottomActions: { flexDirection: 'row', justifyContent: 'space-around', padding: 30, paddingBottom: 50 },
    actionBtn: { alignItems: 'center' },
    actionBtnText: { color: '#FFF', fontSize: 12, marginTop: 4 },
    permissionError: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
    errorText: { fontSize: 18, fontWeight: '600', color: '#1F2937', marginTop: 16 },
    errorSubtext: { fontSize: 14, color: '#6B7280', marginTop: 8 },
    resultModal: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
    resultCard: { backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
    resultHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
    resultTitle: { fontSize: 20, fontWeight: '600', color: '#1F2937', marginLeft: 12 },
    resultInfo: { backgroundColor: '#F9FAFB', borderRadius: 12, padding: 16 },
    resultRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
    resultLabel: { fontSize: 14, color: '#6B7280' },
    resultValue: { fontSize: 14, fontWeight: '500', color: '#1F2937' },
    resultActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
    resultActionBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#F3F4F6', alignItems: 'center' },
    resultActionText: { fontSize: 14, fontWeight: '500', color: '#1F2937' },
    primaryBtn: { backgroundColor: '#00FF88' },
    primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#000' },
});

// ==========================================
// package.json
// ==========================================

/*
{
  "name": "routz-mobile",
  "version": "1.0.0",
  "main": "App.js",
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web"
  },
  "dependencies": {
    "@expo/vector-icons": "^14.0.0",
    "@react-navigation/bottom-tabs": "^6.5.11",
    "@react-navigation/native": "^6.1.9",
    "@react-navigation/native-stack": "^6.9.17",
    "@reduxjs/toolkit": "^2.0.1",
    "expo": "~50.0.0",
    "expo-barcode-scanner": "~12.6.0",
    "expo-camera": "~14.0.0",
    "expo-linear-gradient": "~12.5.0",
    "expo-status-bar": "~1.11.0",
    "react": "18.2.0",
    "react-native": "0.73.0",
    "react-native-safe-area-context": "4.8.2",
    "react-native-screens": "~3.29.0",
    "react-redux": "^9.0.4"
  },
  "devDependencies": {
    "@babel/core": "^7.20.0"
  }
}
*/
