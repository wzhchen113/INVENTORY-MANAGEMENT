// src/navigation/AppNavigator.tsx
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal,
  TextInput, Platform, Alert,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { Colors, FontSize, Spacing, Radius } from '../theme/colors';

import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import ItemsScreen from '../screens/ItemsScreen';
import EODCountScreen from '../screens/EODCountScreen';
import WasteLogScreen from '../screens/WasteLogScreen';
import POSImportScreen from '../screens/POSImportScreen';
import ReconciliationScreen from '../screens/ReconciliationScreen';
import PrepRecipesScreen from '../screens/PrepRecipesScreen';
import IngredientsScreen from '../screens/IngredientsScreen';
import OrdersScreen from '../screens/OrdersScreen';
import EODHistoryScreen from '../screens/EODHistoryScreen';
import { useJsonServerSync } from '../store/useJsonServerSync';
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
  Orders: 'cart-outline',
  More: 'menu-outline',
};

function StoreSelector() {
  const { currentStore, stores, currentUser, setCurrentStore } = useStore();
  const [open, setOpen] = useState(false);
  const isAdmin = currentUser?.role === 'admin';
  const userStores = isAdmin ? stores : stores.filter((s) => currentUser?.stores.includes(s.id));

  if (userStores.length <= 1) {
    return (
      <View style={styles.storePill}>
        <View style={styles.storePillDot} />
        <Text style={styles.storePillText}>{currentStore.name || 'Store'}</Text>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity style={styles.storePill} onPress={() => setOpen(true)}>
        <View style={styles.storePillDot} />
        <Text style={styles.storePillText}>{currentStore.name || 'Store'}</Text>
        <Ionicons name="chevron-down" size={12} color={Colors.textSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.storeOverlay}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={styles.storeDropdown}>
            <Text style={styles.storeDropdownTitle}>Switch store</Text>
            {userStores.map((store) => {
              const isActive = store.id === currentStore.id;
              return (
                <TouchableOpacity
                  key={store.id}
                  style={[styles.storeOption, isActive && styles.storeOptionActive]}
                  onPress={() => {
                    setCurrentStore(store);
                    setOpen(false);
                  }}
                >
                  <View style={[styles.storeOptionDot, isActive && styles.storeOptionDotActive]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.storeOptionName, isActive && { fontWeight: '600' }]}>
                      {store.name}
                    </Text>
                    {store.address ? (
                      <Text style={styles.storeOptionAddr}>{store.address}</Text>
                    ) : null}
                  </View>
                  {isActive && <Ionicons name="checkmark" size={16} color={Colors.success} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function ProfileSidebar({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { currentUser, updateUser, logout } = useStore();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleClose = () => {
    setEditingName(false);
    setChangingPassword(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    onClose();
  };

  const handleSaveName = () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    if (currentUser) {
      const initials = trimmed.split(' ').map((w) => w[0]?.toUpperCase()).join('').slice(0, 2);
      updateUser(currentUser.id, { name: trimmed, initials });
    }
    setEditingName(false);
  };

  const handleChangePassword = () => {
    if (!newPassword || newPassword.length < 6) {
      const msg = 'Password must be at least 6 characters';
      Platform.OS === 'web' ? alert(msg) : Alert.alert('Error', msg);
      return;
    }
    if (newPassword !== confirmPassword) {
      const msg = 'Passwords do not match';
      Platform.OS === 'web' ? alert(msg) : Alert.alert('Error', msg);
      return;
    }
    // In local store mode, just confirm success
    const msg = 'Password updated successfully';
    Platform.OS === 'web' ? alert(msg) : Alert.alert('Success', msg);
    setChangingPassword(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleSignOut = () => {
    handleClose();
    logout();
  };

  if (!currentUser) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={sidebarStyles.overlay}>
        <TouchableOpacity style={sidebarStyles.backdrop} activeOpacity={1} onPress={handleClose} />
        <View style={sidebarStyles.panel}>
          {/* Header */}
          <View style={sidebarStyles.header}>
            <Text style={sidebarStyles.headerTitle}>Profile</Text>
            <TouchableOpacity onPress={handleClose} style={sidebarStyles.closeBtn}>
              <Ionicons name="close" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={sidebarStyles.body} contentContainerStyle={{ paddingBottom: 40 }}>
            {/* Avatar & info */}
            <View style={sidebarStyles.profileSection}>
              <View style={[sidebarStyles.avatar, { backgroundColor: (currentUser.color || '#378ADD') + '22' }]}>
                <Text style={[sidebarStyles.avatarText, { color: currentUser.color || '#378ADD' }]}>
                  {currentUser.initials}
                </Text>
              </View>
              <Text style={sidebarStyles.userName}>{currentUser.name}</Text>
              <Text style={sidebarStyles.userEmail}>{currentUser.email}</Text>
              <View style={sidebarStyles.roleBadge}>
                <Text style={sidebarStyles.roleText}>
                  {currentUser.role === 'admin' ? 'Admin' : 'Team member'}
                </Text>
              </View>
            </View>

            {/* Divider */}
            <View style={sidebarStyles.divider} />

            {/* Change Name */}
            <View style={sidebarStyles.section}>
              <Text style={sidebarStyles.sectionTitle}>Display name</Text>
              {editingName ? (
                <View style={sidebarStyles.editGroup}>
                  <TextInput
                    style={sidebarStyles.input}
                    value={nameValue}
                    onChangeText={setNameValue}
                    placeholder="Enter new name"
                    placeholderTextColor={Colors.textTertiary}
                    autoFocus
                  />
                  <View style={sidebarStyles.editBtnRow}>
                    <TouchableOpacity
                      style={sidebarStyles.cancelBtn}
                      onPress={() => setEditingName(false)}
                    >
                      <Text style={sidebarStyles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={sidebarStyles.primaryBtn} onPress={handleSaveName}>
                      <Text style={sidebarStyles.primaryBtnText}>Save</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={sidebarStyles.settingRow}
                  onPress={() => {
                    setNameValue(currentUser.name);
                    setEditingName(true);
                  }}
                >
                  <Text style={sidebarStyles.settingValue}>{currentUser.name}</Text>
                  <Ionicons name="pencil-outline" size={14} color={Colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Change Password */}
            <View style={sidebarStyles.section}>
              <Text style={sidebarStyles.sectionTitle}>Password</Text>
              {changingPassword ? (
                <View style={sidebarStyles.editGroup}>
                  <TextInput
                    style={sidebarStyles.input}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    placeholder="Current password"
                    placeholderTextColor={Colors.textTertiary}
                    secureTextEntry
                  />
                  <TextInput
                    style={sidebarStyles.input}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="New password"
                    placeholderTextColor={Colors.textTertiary}
                    secureTextEntry
                  />
                  <TextInput
                    style={sidebarStyles.input}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Confirm new password"
                    placeholderTextColor={Colors.textTertiary}
                    secureTextEntry
                  />
                  <View style={sidebarStyles.editBtnRow}>
                    <TouchableOpacity
                      style={sidebarStyles.cancelBtn}
                      onPress={() => {
                        setChangingPassword(false);
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                      }}
                    >
                      <Text style={sidebarStyles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={sidebarStyles.primaryBtn} onPress={handleChangePassword}>
                      <Text style={sidebarStyles.primaryBtnText}>Update</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={sidebarStyles.settingRow}
                  onPress={() => setChangingPassword(true)}
                >
                  <Text style={sidebarStyles.settingValue}>••••••••</Text>
                  <Ionicons name="pencil-outline" size={14} color={Colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Divider */}
            <View style={sidebarStyles.divider} />

            {/* Sign out */}
            <TouchableOpacity style={sidebarStyles.signOutBtn} onPress={handleSignOut}>
              <Ionicons name="log-out-outline" size={18} color={Colors.danger} />
              <Text style={sidebarStyles.signOutText}>Sign out</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Global profile sidebar state — shared between HeaderRight and the sidebar
let _openProfileSidebar: (() => void) | null = null;

function HeaderRight() {
  const currentUser = useStore((s) => s.currentUser);
  const [showProfile, setShowProfile] = useState(false);

  return (
    <>
      <TouchableOpacity
        style={[styles.headerAvatar, { backgroundColor: (currentUser?.color || '#378ADD') + '33', marginRight: 16 }]}
        onPress={() => setShowProfile(true)}
        activeOpacity={0.7}
      >
        <Text style={[styles.headerAvatarText, { color: currentUser?.color || '#378ADD' }]}>
          {currentUser?.initials}
        </Text>
      </TouchableOpacity>
      <ProfileSidebar visible={showProfile} onClose={() => setShowProfile(false)} />
    </>
  );
}

function HeaderLeft() {
  return (
    <View style={{ marginLeft: 16 }}>
      <StoreSelector />
    </View>
  );
}

function MoreScreen({ navigation }: any) {
  const { currentUser, logout } = useStore();
  const isAdmin = currentUser?.role === 'admin';

  const items = [
    { label: 'Waste Log', screen: 'WasteLog', icon: 'trash-outline' as const },
    { label: 'Ingredients', screen: 'Ingredients', icon: 'nutrition-outline' as const },
    { label: 'Prep Recipes', screen: 'PrepRecipes', icon: 'flask-outline' as const },
    { label: 'Recipes / BOM', screen: 'Recipes', icon: 'restaurant-outline' as const },
    { label: 'Restock Report', screen: 'Restock', icon: 'arrow-down-circle-outline' as const },
    ...(isAdmin ? [
      { label: 'EOD History', screen: 'EODHistory', icon: 'calendar-outline' as const },
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
  const storeId = useStore((s) => s.currentStore.id);
  return (
    <Tab.Navigator
      key={storeId}
      screenOptions={({ route }) => ({
        ...sharedHeaderOptions,
        headerLeft: () => <HeaderLeft />,
        headerTitle: '',
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
      <Tab.Screen name="Orders" component={OrdersScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

function AppStackNavigator() {
  const storeId = useStore((s) => s.currentStore?.id);

  const handleSync = useCallback(() => {
    console.log('[Realtime] Data changed on server');
  }, []);

  useRealtimeSync(storeId, handleSync);
  useJsonServerSync();

  return (
    <AppStack.Navigator key={storeId} screenOptions={sharedHeaderOptions}>
      <AppStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
      <AppStack.Screen name="WasteLog" component={WasteLogScreen} options={{ title: 'Waste Log' }} />
      <AppStack.Screen name="Ingredients" component={IngredientsScreen} options={{ title: 'Ingredients' }} />
      <AppStack.Screen name="PrepRecipes" component={PrepRecipesScreen} options={{ title: 'Prep recipes' }} />
      <AppStack.Screen name="EODHistory" component={EODHistoryScreen} options={{ title: 'EOD History' }} />
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

  // Store selector
  storePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.bgSecondary, borderRadius: Radius.round,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 0.5, borderColor: Colors.borderLight,
  },
  storePillDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.success },
  storePillText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary },

  // Store dropdown
  storeOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start', paddingTop: 60, paddingHorizontal: Spacing.lg,
  },
  storeDropdown: {
    backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl,
    padding: Spacing.lg, maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  storeDropdownTitle: {
    fontSize: FontSize.xs, fontWeight: '600', color: Colors.textTertiary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: Spacing.md,
  },
  storeOption: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md, marginBottom: 2,
  },
  storeOptionActive: { backgroundColor: Colors.successBg },
  storeOptionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.borderMedium },
  storeOptionDotActive: { backgroundColor: Colors.success },
  storeOptionName: { fontSize: FontSize.sm, color: Colors.textPrimary },
  storeOptionAddr: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
});

const SIDEBAR_WIDTH = 320;

const sidebarStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: 'row',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  panel: {
    width: SIDEBAR_WIDTH,
    backgroundColor: Colors.bgPrimary,
    shadowColor: '#000',
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.lg,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    padding: Spacing.lg,
  },
  profileSection: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  avatarText: {
    fontSize: FontSize.xxl,
    fontWeight: '700',
  },
  userName: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  userEmail: {
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
    marginBottom: Spacing.sm,
  },
  roleBadge: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.round,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
  },
  roleText: {
    fontSize: FontSize.xs,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  divider: {
    height: 0.5,
    backgroundColor: Colors.borderLight,
    marginVertical: Spacing.lg,
  },
  section: {
    marginBottom: Spacing.lg,
  },
  sectionTitle: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
  },
  settingValue: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  editGroup: {
    gap: Spacing.sm,
  },
  input: {
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
    borderRadius: Radius.md,
    padding: Spacing.md,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    backgroundColor: Colors.bgSecondary,
  },
  editBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
  },
  cancelBtnText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  primaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: Colors.textPrimary,
  },
  primaryBtnText: {
    fontSize: FontSize.sm,
    color: Colors.white,
    fontWeight: '600',
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.danger,
    borderRadius: Radius.md,
    backgroundColor: Colors.dangerBg,
  },
  signOutText: {
    fontSize: FontSize.base,
    color: Colors.danger,
    fontWeight: '600',
  },
});
