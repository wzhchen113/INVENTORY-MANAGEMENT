// src/navigation/AppNavigator.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator, DrawerContentScrollView, DrawerItemList, DrawerItem } from '@react-navigation/drawer';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStore } from '../store/useSupabaseStore';
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

const Drawer = createDrawerNavigator();
const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

// Bottom tab icons
const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'grid-outline',
  Items: 'list-outline',
  'EOD Count': 'clipboard-outline',
  'Waste Log': 'trash-outline',
  More: 'menu-outline',
};

function TabNavigator() {
  const currentUser = useStore((s) => s.currentUser);
  const isAdmin = currentUser?.role === 'admin';

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.bgPrimary,
          borderTopColor: Colors.borderLight,
          borderTopWidth: 0.5,
          height: 60,
          paddingBottom: 6,
        },
        tabBarActiveTintColor: Colors.textPrimary,
        tabBarInactiveTintColor: Colors.textTertiary,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICONS[route.name] || 'ellipse-outline'} size={size - 2} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Items" component={ItemsScreen} />
      <Tab.Screen name="EOD Count" component={EODCountScreen} />
      <Tab.Screen name="Waste Log" component={WasteLogScreen} />
    </Tab.Navigator>
  );
}

// Custom drawer content
function CustomDrawerContent(props: any) {
  const { currentUser, logout } = useStore();
  const isAdmin = currentUser?.role === 'admin';

  return (
    <DrawerContentScrollView {...props} contentContainerStyle={{ flex: 1 }}>
      {/* User header */}
      <View style={styles.drawerHeader}>
        <View style={[styles.drawerAvatar, { backgroundColor: (currentUser?.color || '#378ADD') + '33' }]}>
          <Text style={[styles.drawerAvatarText, { color: currentUser?.color || '#378ADD' }]}>
            {currentUser?.initials}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.drawerName}>{currentUser?.name}</Text>
          <Text style={styles.drawerRole}>{isAdmin ? 'Administrator' : 'Store user'}</Text>
        </View>
        <View style={[styles.rolePill, { backgroundColor: isAdmin ? Colors.infoBg : Colors.successBg }]}>
          <Text style={[styles.rolePillText, { color: isAdmin ? Colors.info : Colors.success }]}>
            {isAdmin ? 'Admin' : 'Staff'}
          </Text>
        </View>
      </View>

      {/* Inventory section */}
      <View style={styles.drawerSection}>
        <Text style={styles.drawerSectionTitle}>INVENTORY</Text>
        {[
          { name: 'Dashboard', icon: 'grid-outline' as const },
          { name: 'Items', icon: 'list-outline' as const },
          { name: 'Recipes', icon: 'restaurant-outline' as const },
          { name: 'EODCount', label: 'EOD Count', icon: 'clipboard-outline' as const },
          { name: 'WasteLog', label: 'Waste Log', icon: 'trash-outline' as const },
          { name: 'Restock', label: 'Restock Report', icon: 'arrow-down-circle-outline' as const },
        ].map((item) => (
          <DrawerItem
            key={item.name}
            label={item.label || item.name}
            onPress={() => props.navigation.navigate(item.name)}
            icon={({ color, size }) => <Ionicons name={item.icon} size={size} color={color} />}
            labelStyle={styles.drawerLabel}
            activeTintColor={Colors.textPrimary}
            inactiveTintColor={Colors.textSecondary}
          />
        ))}
      </View>

      {/* Purchasing section — admin only */}
      {isAdmin && (
        <View style={styles.drawerSection}>
          <Text style={styles.drawerSectionTitle}>PURCHASING</Text>
          {[
            { name: 'Vendors', icon: 'business-outline' as const },
            { name: 'PurchaseOrders', label: 'Purchase Orders', icon: 'document-text-outline' as const },
          ].map((item) => (
            <DrawerItem
              key={item.name}
              label={item.label || item.name}
              onPress={() => props.navigation.navigate(item.name)}
              icon={({ color, size }) => <Ionicons name={item.icon} size={size} color={color} />}
              labelStyle={styles.drawerLabel}
              activeTintColor={Colors.textPrimary}
              inactiveTintColor={Colors.textSecondary}
            />
          ))}
        </View>
      )}

      {/* Sales & Reports — admin only */}
      {isAdmin && (
        <View style={styles.drawerSection}>
          <Text style={styles.drawerSectionTitle}>SALES & REPORTS</Text>
          {[
            { name: 'POSImport', label: 'POS Import', icon: 'cloud-upload-outline' as const },
            { name: 'Reconciliation', icon: 'git-compare-outline' as const },
            { name: 'Reports', icon: 'bar-chart-outline' as const },
          ].map((item) => (
            <DrawerItem
              key={item.name}
              label={item.label || item.name}
              onPress={() => props.navigation.navigate(item.name)}
              icon={({ color, size }) => <Ionicons name={item.icon} size={size} color={color} />}
              labelStyle={styles.drawerLabel}
              activeTintColor={Colors.textPrimary}
              inactiveTintColor={Colors.textSecondary}
            />
          ))}
        </View>
      )}

      {/* Admin section */}
      {isAdmin && (
        <View style={styles.drawerSection}>
          <Text style={styles.drawerSectionTitle}>ADMIN</Text>
          {[
            { name: 'AuditLog', label: 'Audit Log', icon: 'time-outline' as const },
            { name: 'Users', icon: 'people-outline' as const },
          ].map((item) => (
            <DrawerItem
              key={item.name}
              label={item.label || item.name}
              onPress={() => props.navigation.navigate(item.name)}
              icon={({ color, size }) => <Ionicons name={item.icon} size={size} color={color} />}
              labelStyle={styles.drawerLabel}
              activeTintColor={Colors.textPrimary}
              inactiveTintColor={Colors.textSecondary}
            />
          ))}
        </View>
      )}

      {/* Sign out */}
      <View style={{ marginTop: 'auto', padding: Spacing.md }}>
        <TouchableOpacity style={styles.signOutBtn} onPress={logout}>
          <Ionicons name="log-out-outline" size={16} color={Colors.danger} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </DrawerContentScrollView>
  );
}

// Header right component with user avatar
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

// Main app navigator (post-login)
function AppDrawer() {
  const sharedHeaderOptions = {
    headerStyle: { backgroundColor: Colors.bgPrimary, elevation: 0, shadowOpacity: 0 },
    headerTitleStyle: { fontSize: FontSize.base, fontWeight: '500' as const, color: Colors.textPrimary },
    headerTintColor: Colors.textPrimary,
    headerRight: () => <HeaderRight />,
    drawerStyle: { width: 260, backgroundColor: Colors.bgPrimary },
  };

  return (
    <Drawer.Navigator
      drawerContent={(props) => <CustomDrawerContent {...props} />}
      screenOptions={sharedHeaderOptions}
    >
      <Drawer.Screen name="Dashboard" component={DashboardScreen} />
      <Drawer.Screen name="Items" component={ItemsScreen} options={{ title: 'Items & costs' }} />
      <Drawer.Screen name="Recipes" component={RecipesScreen} options={{ title: 'Recipes / BOM' }} />
      <Drawer.Screen name="EODCount" component={EODCountScreen} options={{ title: 'End-of-day count' }} />
      <Drawer.Screen name="WasteLog" component={WasteLogScreen} options={{ title: 'Waste log' }} />
      <Drawer.Screen name="Restock" component={RestockScreen} options={{ title: 'Restock report' }} />
      <Drawer.Screen name="Vendors" component={VendorsScreen} />
      <Drawer.Screen name="PurchaseOrders" component={PurchaseOrdersScreen} options={{ title: 'Purchase orders' }} />
      <Drawer.Screen name="POSImport" component={POSImportScreen} options={{ title: 'POS import' }} />
      <Drawer.Screen name="Reconciliation" component={ReconciliationScreen} />
      <Drawer.Screen name="Reports" component={ReportsScreen} options={{ title: 'Reports & analytics' }} />
      <Drawer.Screen name="AuditLog" component={AuditLogScreen} options={{ title: 'Audit log' }} />
      <Drawer.Screen name="Users" component={UsersScreen} options={{ title: 'Users & access' }} />
    </Drawer.Navigator>
  );
}

// Root navigator with auth gate
export default function AppNavigator() {
  const currentUser = useStore((s) => s.currentUser);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {currentUser ? (
          <Stack.Screen name="App" component={AppDrawer} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  drawerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
    marginBottom: Spacing.sm,
  },
  drawerAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  drawerAvatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  drawerName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  drawerRole: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  rolePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  rolePillText: { fontSize: 9, fontWeight: '500' },
  drawerSection: { marginTop: Spacing.xs },
  drawerSectionTitle: { fontSize: 9, fontWeight: '600', color: Colors.textTertiary, letterSpacing: 0.6, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.xs },
  drawerLabel: { fontSize: FontSize.sm },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md, borderWidth: 0.5, borderColor: Colors.dangerBg, borderRadius: Radius.md, backgroundColor: Colors.dangerBg },
  signOutText: { fontSize: FontSize.sm, color: Colors.danger, fontWeight: '500' },
  headerAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  headerAvatarText: { fontSize: 10, fontWeight: '600' },
});
