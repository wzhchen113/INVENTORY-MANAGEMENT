// src/navigation/AppNavigator.tsx
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { useStore } from '../store/useStore';
import { Colors, FontSize, Spacing, Radius } from '../theme/colors';

import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import ItemsScreen from '../screens/ItemsScreen';
import EODCountScreen from '../screens/EODCountScreen';
import WasteLogScreen from '../screens/WasteLogScreen';
import POSImportScreen from '../screens/POSImportScreen';
import ReconciliationScreen from '../screens/ReconciliationScreen';
import {
  RecipesScreen, VendorsScreen, PurchaseOrdersScreen,
  RestockScreen, AuditLogScreen, ReportsScreen, UsersScreen,
} from '../screens/AdminScreens';

const Tab = createBottomTabNavigator();
const AppStack = createStackNavigator();
const RootStack = createStackNavigator();

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'grid-outline',
  Items: 'list-outline',
  EODCount: 'clipboard-outline',
  WasteLog: 'trash-outline',
  More: 'menu-outline',
};

function HeaderRight() {
  const currentUser = useStore((s) => s.currentUser);
  return (
    <View style={[styles.headerAvatar, { backgroundColor: (currentUser?.color || '#378ADD') + '33', marginRight: 16 }]}>
      <Text style={[styles.headerAvatarText, { color: currentUser?.color || '#378ADD' }]}>
        {currentUser?.initials}
      </Text>
    </View>
  );
}

function MoreScreen({ navigation }: any) {
  const { currentUser, logout } = useStore();
  const isAdmin = currentUser?.role === 'admin';

  const items = [
    { label: 'Recipes / BOM', screen: 'Recipes', icon: 'restaurant-outline' as const },
    { label: 'Restock Report', screen: 'Restock', icon: 'arrow-down-circle-outline' as const },
    ...(isAdmin ? [
      { label: 'Vendors', screen: 'Vendors', icon: 'business-outline' as const },
      { label: 'Purchase Orders', screen: 'PurchaseOrders', icon: 'document-text-outline' as const },
      { label: 'POS Import', screen: 'POSImport', icon: 'cloud-upload-outline' as const },
      { label: 'Reconciliation', screen: 'Reconciliation', icon: 'git-compare-outline' as const },
      { label: 'Reports & Analytics', screen: 'Reports', icon: 'bar-chart-outline' as const },
      { label: 'Audit Log', screen: 'AuditLog', icon: 'time-outline' as const },
      { label: 'Users & Access', screen: 'Users', icon: 'people-outline' as const },
    ] : []),
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.bgTertiary }}>
      <View style={styles.moreList}>
        {items.map((item) => (
          <TouchableOpacity
            key={item.screen}
            style={styles.moreItem}
            onPress={() => navigation.navigate(item.screen)}
          >
            <Ionicons name={item.icon} size={20} color={Colors.textSecondary} />
            <Text style={styles.moreLabel}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.signOutSection}>
        <TouchableOpacity style={styles.signOutBtn} onPress={logout}>
          <Ionicons name="log-out-outline" size={16} color={Colors.danger} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const sharedHeaderOptions = {
  headerStyle: { backgroundColor: Colors.bgPrimary, elevation: 0, shadowOpacity: 0 } as const,
  headerTitleStyle: { fontSize: FontSize.base, fontWeight: '500' as const, color: Colors.textPrimary },
  headerTintColor: Colors.textPrimary,
  headerRight: () => <HeaderRight />,
};

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...sharedHeaderOptions,
        tabBarStyle: {
          backgroundColor: Colors.bgPrimary,
          borderTopColor: Colors.borderLight,
          borderTopWidth: 0.5,
          height: 60,
          paddingBottom: 6,
        },
        tabBarActiveTintColor: Colors.textPrimary,
        tabBarInactiveTintColor: Colors.textTertiary,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' as const },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICONS[route.name] || 'ellipse-outline'} size={size - 2} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Items" component={ItemsScreen} options={{ title: 'Items & costs' }} />
      <Tab.Screen name="EODCount" component={EODCountScreen} options={{ title: 'EOD Count' }} />
      <Tab.Screen name="WasteLog" component={WasteLogScreen} options={{ title: 'Waste Log' }} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

function AppStackNavigator() {
  return (
    <AppStack.Navigator screenOptions={sharedHeaderOptions}>
      <AppStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
      <AppStack.Screen name="Recipes" component={RecipesScreen} options={{ title: 'Recipes / BOM' }} />
      <AppStack.Screen name="Vendors" component={VendorsScreen} />
      <AppStack.Screen name="PurchaseOrders" component={PurchaseOrdersScreen} options={{ title: 'Purchase orders' }} />
      <AppStack.Screen name="Restock" component={RestockScreen} options={{ title: 'Restock report' }} />
      <AppStack.Screen name="POSImport" component={POSImportScreen} options={{ title: 'POS import' }} />
      <AppStack.Screen name="Reconciliation" component={ReconciliationScreen} />
      <AppStack.Screen name="Reports" component={ReportsScreen} options={{ title: 'Reports & analytics' }} />
      <AppStack.Screen name="AuditLog" component={AuditLogScreen} options={{ title: 'Audit log' }} />
      <AppStack.Screen name="Users" component={UsersScreen} options={{ title: 'Users & access' }} />
    </AppStack.Navigator>
  );
}

export default function AppNavigator() {
  const currentUser = useStore((s) => s.currentUser);

  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {currentUser ? (
          <RootStack.Screen name="App" component={AppStackNavigator} />
        ) : (
          <RootStack.Screen name="Login" component={LoginScreen} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  moreList: { marginTop: Spacing.lg },
  moreItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    padding: Spacing.lg, backgroundColor: Colors.bgPrimary,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  moreLabel: { flex: 1, fontSize: FontSize.base, color: Colors.textPrimary },
  signOutSection: { padding: Spacing.lg },
  signOutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderWidth: 0.5, borderColor: Colors.dangerBg,
    borderRadius: Radius.md, backgroundColor: Colors.dangerBg,
  },
  signOutText: { fontSize: FontSize.sm, color: Colors.danger, fontWeight: '500' },
  headerAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  headerAvatarText: { fontSize: 10, fontWeight: '600' },
});
