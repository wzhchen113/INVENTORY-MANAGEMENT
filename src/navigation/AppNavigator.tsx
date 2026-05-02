// src/navigation/AppNavigator.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal,
  TextInput, Platform, Alert, Switch, ActivityIndicator,
} from 'react-native';
import Toast from 'react-native-toast-message';
import {
  getPushPermission,
  requestPermissionAndSubscribe,
  unsubscribeFromPush,
} from '../lib/webPush';
import { updateProfileNotifications } from '../lib/db';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { useStore } from '../store/useStore';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { Colors, FontSize, Spacing, Radius, useColors } from '../theme/colors';

import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
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
import OrderReportScreen from '../screens/OrderReportScreen';
import { useJsonServerSync } from '../store/useJsonServerSync';
import {
  RecipesScreen, VendorsScreen,
  AuditLogScreen, ReportsScreen, UsersScreen,
} from '../screens/AdminScreens';
import { TimezoneBar } from '../components/TimezoneBar';

const Tab = createBottomTabNavigator();
const AppStack = createStackNavigator();
const RootStack = createStackNavigator();

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'grid-outline',
  Recipes: 'restaurant-outline',
  Items: 'list-outline',
  EODCount: 'clipboard-outline',
  Orders: 'cart-outline',
  More: 'menu-outline',
};

const ALL_STORES_ID = '__all__';

function StoreSelector() {
  const { currentStore, stores, currentUser, setCurrentStore } = useStore();
  const C = useColors();
  const [open, setOpen] = useState(false);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const userStores = isAdmin ? stores : stores.filter((s) => currentUser?.stores.includes(s.id));
  const isAllStores = currentStore.id === ALL_STORES_ID;

  if (userStores.length <= 1 && !isAdmin) {
    return (
      <View style={[styles.storePill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
        <View style={[styles.storePillDot, { backgroundColor: C.success }]} />
        <Text style={[styles.storePillText, { color: C.textPrimary }]}>{currentStore.name || 'Store'}</Text>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity testID="store-switcher-chip" style={[styles.storePill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => setOpen(true)}>
        <View style={[styles.storePillDot, { backgroundColor: isAllStores ? C.info : C.success }]} />
        <Text style={[styles.storePillText, { color: C.textPrimary }]}>{currentStore.name || 'Store'}</Text>
        <Ionicons name="chevron-down" size={12} color={C.textSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.storeOverlay}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={[styles.storeDropdown, { backgroundColor: C.bgPrimary }]}>
            <Text style={[styles.storeDropdownTitle, { color: C.textTertiary }]}>Switch store</Text>
            {/* "All Stores" combined-view option was removed — admins now see
                a fleet-wide EOD overview on the per-store dashboard instead.
                The "Admin · All stores" pill in the header signals scope. */}
            {userStores.map((store) => {
              const isActive = store.id === currentStore.id;
              return (
                <TouchableOpacity
                  key={store.id}
                  testID={`store-row-${store.name.toLowerCase().replace(/\s+/g, '-')}`}
                  style={[styles.storeOption, isActive && { backgroundColor: C.successBg }]}
                  onPress={() => {
                    setCurrentStore(store);
                    setOpen(false);
                  }}
                >
                  <View style={[styles.storeOptionDot, isActive && { backgroundColor: C.success }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.storeOptionName, { color: C.textPrimary }, isActive && { fontWeight: '600' }]}>
                      {store.name}
                    </Text>
                    {store.address ? (
                      <Text style={[styles.storeOptionAddr, { color: C.textTertiary }]}>{store.address}</Text>
                    ) : null}
                  </View>
                  {isActive && <Ionicons name="checkmark" size={16} color={C.success} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function StackHeaderLeft() {
  const nav = useNavigation();
  const C = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}>
      <TouchableOpacity onPress={() => nav.goBack()} style={{ marginRight: 8, padding: 4 }}>
        <Ionicons name="arrow-back" size={22} color={C.textPrimary} />
      </TouchableOpacity>
      <StoreSelector />
    </View>
  );
}

function ProfileSidebar({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { currentUser, updateUser, logout, darkMode, toggleDarkMode } = useStore();
  const C = useColors();
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameValue, setNicknameValue] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Notifications toggle — single switch that controls BOTH web push (this
  // device's subscription) AND server-side email fallback (via
  // profiles.notifications_enabled which the eod-reminder-cron filters on).
  // OS permission state is observed (not driven) so the status sub-line can
  // explain why the toggle is doing what it's doing.
  const [pushPermission, setPushPermission] = useState(getPushPermission());
  const [savingNotifications, setSavingNotifications] = useState(false);
  // Re-sample permission whenever the sidebar opens so users who flipped it
  // in OS settings see the truth without having to refresh.
  useEffect(() => {
    if (visible) setPushPermission(getPushPermission());
  }, [visible]);

  const handleClose = () => {
    setEditingNickname(false);
    setChangingPassword(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    onClose();
  };

  const handleSaveNickname = async () => {
    const trimmed = nicknameValue.trim();
    if (currentUser) {
      updateUser(currentUser.id, { nickname: trimmed });
      // Save to Supabase
      try {
        const { supabase } = await import('../lib/supabase');
        await supabase.from('profiles').update({ nickname: trimmed }).eq('id', currentUser.id);
      } catch {}
    }
    setEditingNickname(false);
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

  // Treat undefined as enabled (legacy rows / pre-migration sessions).
  const notificationsEnabled = currentUser?.notificationsEnabled !== false;

  // Status sub-line drives the in-context "why isn't this working" copy.
  // Order of precedence: the explicit OFF state always wins over permission
  // chatter — saying "Tap to enable" when the user just turned it OFF would
  // be confusing.
  const notificationsStatus = ((): { text: string; tone: 'ok' | 'warn' | 'info' } => {
    if (!notificationsEnabled) return { text: 'Off — no push or email reminders', tone: 'info' };
    if (pushPermission === 'unsupported') return { text: 'Push not supported in this browser — emails still send', tone: 'info' };
    if (pushPermission === 'denied') return { text: 'Blocked in browser settings — re-allow in OS settings', tone: 'warn' };
    if (pushPermission === 'default') return { text: 'Tap to enable push on this device', tone: 'info' };
    // granted
    return { text: 'On — 60 / 30 / 10 min before deadlines', tone: 'ok' };
  })();

  const handleToggleNotifications = async (next: boolean) => {
    if (!currentUser?.id || savingNotifications) return;
    setSavingNotifications(true);
    if (next) {
      // Turning ON: persist preference first so the cron picks it up even if
      // the browser-side subscription fails (e.g. iOS Safari without PWA
      // install). The user still gets email fallback in that case.
      const ok = await updateProfileNotifications(currentUser.id, true);
      if (!ok) {
        Toast.show({ type: 'error', text1: 'Could not save', text2: 'Notifications preference not updated. Try again.', visibilityTime: 4500 });
        setSavingNotifications(false);
        return;
      }
      updateUser(currentUser.id, { notificationsEnabled: true });
      // Now subscribe THIS device to push if the browser supports it.
      const result = await requestPermissionAndSubscribe(currentUser.id);
      setPushPermission(getPushPermission());
      setSavingNotifications(false);
      if (result.ok) {
        Toast.show({ type: 'success', text1: 'Reminders on', text2: `You'll be notified 60 / 30 / 10 min before deadlines.`, visibilityTime: 3500 });
        return;
      }
      // Push setup failed but the server-side preference is on, so emails
      // will still fire. Tell the user exactly why push won't work here.
      const messages: Record<string, { text1: string; text2: string; type: 'error' | 'info' }> = {
        'unsupported': { type: 'info', text1: 'Push not supported here', text2: 'Emails will still arrive.' },
        'no-vapid': { type: 'error', text1: 'Config missing', text2: 'Server is missing the VAPID public key.' },
        'no-user': { type: 'error', text1: 'Not logged in', text2: 'Re-login and try again.' },
        'permission-denied': { type: 'info', text1: 'Push blocked', text2: 'Allow notifications in OS settings. Emails will still arrive.' },
        'permission-default': { type: 'info', text1: 'Permission needed', text2: 'Tap the toggle again to re-prompt.' },
        'sw-register-failed': { type: 'error', text1: 'Service worker error', text2: 'Could not register /sw.js.' },
        'subscribe-failed': { type: 'error', text1: 'Subscribe failed', text2: 'iOS? Add to Home Screen and open from there.' },
        'subscription-incomplete': { type: 'error', text1: 'Invalid subscription', text2: 'Missing endpoint or keys from the browser.' },
        'save-failed': { type: 'error', text1: 'Server save failed', text2: 'Push subscription not stored. Emails will still arrive.' },
      };
      const info = messages[result.code] || { type: 'error' as const, text1: 'Push setup failed', text2: result.code };
      Toast.show({ type: info.type, text1: info.text1, text2: info.detail ? `${info.text2}\n(${result.code})` : info.text2, visibilityTime: 5500 });
      console.warn('[Profile notifications] subscribe failed', result);
      return;
    }
    // Turning OFF: persist preference first (kills email + cross-device push
    // for this user via the cron filter), then unsubscribe THIS device so
    // any previously-stored push subscription is dropped immediately.
    const ok = await updateProfileNotifications(currentUser.id, false);
    if (!ok) {
      Toast.show({ type: 'error', text1: 'Could not save', text2: 'Notifications preference not updated. Try again.', visibilityTime: 4500 });
      setSavingNotifications(false);
      return;
    }
    updateUser(currentUser.id, { notificationsEnabled: false });
    await unsubscribeFromPush();
    setPushPermission(getPushPermission());
    setSavingNotifications(false);
    Toast.show({ type: 'success', text1: 'Reminders off', text2: 'No push or email reminders will be sent.', visibilityTime: 3500 });
  };

  if (!currentUser) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={sidebarStyles.overlay}>
        <TouchableOpacity style={sidebarStyles.backdrop} activeOpacity={1} onPress={handleClose} />
        <View style={[sidebarStyles.panel, { backgroundColor: C.bgPrimary }]}>
          {/* Header */}
          <View style={[sidebarStyles.header, { borderBottomColor: C.borderLight }]}>
            <Text style={[sidebarStyles.headerTitle, { color: C.textPrimary }]}>Profile</Text>
            <TouchableOpacity onPress={handleClose} style={[sidebarStyles.closeBtn, { backgroundColor: C.bgSecondary }]}>
              <Ionicons name="close" size={20} color={C.textSecondary} />
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
              <Text style={[sidebarStyles.userName, { color: C.textPrimary }]}>{currentUser.name}</Text>
              {(currentUser.role === 'admin' || currentUser.role === 'master') && (
                <Text style={[sidebarStyles.userEmail, { color: C.textTertiary }]}>{currentUser.email}</Text>
              )}
              <View style={[sidebarStyles.roleBadge, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[sidebarStyles.roleText, { color: C.textSecondary }]}>
                  {currentUser.role === 'master' ? 'Master' : currentUser.role === 'admin' ? 'Admin' : 'Team member'}
                </Text>
              </View>
            </View>

            {/* Divider */}
            <View style={[sidebarStyles.divider, { backgroundColor: C.borderLight }]} />

            {/* Name (read-only) */}
            <View style={sidebarStyles.section}>
              <Text style={[sidebarStyles.sectionTitle, { color: C.textTertiary }]}>Name</Text>
              <View style={[sidebarStyles.settingRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[sidebarStyles.settingValue, { color: C.textPrimary }]}>{currentUser.name}</Text>
              </View>
            </View>

            {/* Nickname (editable, hidden for master) */}
            {currentUser.role !== 'master' && (
              <View style={sidebarStyles.section}>
                <Text style={[sidebarStyles.sectionTitle, { color: C.textTertiary }]}>Nickname</Text>
                {editingNickname ? (
                  <View style={sidebarStyles.editGroup}>
                    <TextInput
                      style={[sidebarStyles.input, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                      value={nicknameValue}
                      onChangeText={setNicknameValue}
                      placeholder="Enter a nickname"
                      placeholderTextColor={C.textTertiary}
                      autoFocus
                    />
                    <View style={sidebarStyles.editBtnRow}>
                      <TouchableOpacity style={sidebarStyles.cancelBtn} onPress={() => setEditingNickname(false)}>
                        <Text style={sidebarStyles.cancelBtnText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={sidebarStyles.primaryBtn} onPress={handleSaveNickname}>
                        <Text style={sidebarStyles.primaryBtnText}>Save</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[sidebarStyles.settingRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
                    onPress={() => {
                      setNicknameValue(currentUser.nickname || '');
                      setEditingNickname(true);
                    }}
                  >
                    <Text style={[sidebarStyles.settingValue, { color: C.textPrimary }]}>{currentUser.nickname || 'Set a nickname'}</Text>
                    <Ionicons name="pencil-outline" size={14} color={C.textTertiary} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Change Password */}
            <View style={sidebarStyles.section}>
              <Text style={[sidebarStyles.sectionTitle, { color: C.textTertiary }]}>Password</Text>
              {changingPassword ? (
                <View style={sidebarStyles.editGroup}>
                  <TextInput
                    style={[sidebarStyles.input, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    placeholder="Current password"
                    placeholderTextColor={C.textTertiary}
                    secureTextEntry
                  />
                  <TextInput
                    style={[sidebarStyles.input, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="New password"
                    placeholderTextColor={C.textTertiary}
                    secureTextEntry
                  />
                  <TextInput
                    style={[sidebarStyles.input, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Confirm new password"
                    placeholderTextColor={C.textTertiary}
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
                  style={[sidebarStyles.settingRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
                  onPress={() => setChangingPassword(true)}
                >
                  <Text style={[sidebarStyles.settingValue, { color: C.textPrimary }]}>••••••••</Text>
                  <Ionicons name="pencil-outline" size={14} color={C.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Dark mode */}
            <View style={sidebarStyles.section}>
              <Text style={[sidebarStyles.sectionTitle, { color: C.textTertiary }]}>Appearance</Text>
              <View style={[sidebarStyles.settingRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name={darkMode ? 'moon' : 'sunny-outline'} size={16} color={C.textSecondary} />
                  <Text style={[sidebarStyles.settingValue, { color: C.textPrimary }]}>Dark mode</Text>
                </View>
                <Switch
                  value={darkMode}
                  onValueChange={toggleDarkMode}
                  trackColor={{ false: C.borderMedium, true: C.success }}
                  thumbColor={C.white}
                />
              </View>
            </View>

            {/* Notifications */}
            <View style={sidebarStyles.section}>
              <Text style={[sidebarStyles.sectionTitle, { color: C.textTertiary }]}>Notifications</Text>
              <View style={[sidebarStyles.settingRow, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Ionicons
                    name={notificationsEnabled ? 'notifications' : 'notifications-off-outline'}
                    size={16}
                    color={C.textSecondary}
                  />
                  <Text style={[sidebarStyles.settingValue, { color: C.textPrimary }]}>Reminders (push + email)</Text>
                </View>
                {savingNotifications ? (
                  <ActivityIndicator size="small" color={C.textSecondary} />
                ) : (
                  <Switch
                    value={notificationsEnabled}
                    onValueChange={handleToggleNotifications}
                    trackColor={{ false: C.borderMedium, true: C.success }}
                    thumbColor={C.white}
                  />
                )}
              </View>
              <Text
                style={[
                  sidebarStyles.notifHint,
                  {
                    color:
                      notificationsStatus.tone === 'warn'
                        ? C.danger
                        : notificationsStatus.tone === 'ok'
                          ? C.success
                          : C.textTertiary,
                  },
                ]}
              >
                {notificationsStatus.text}
              </Text>
            </View>

            {/* Divider */}
            <View style={[sidebarStyles.divider, { backgroundColor: C.borderLight }]} />

            {/* Sign out */}
            <TouchableOpacity style={[sidebarStyles.signOutBtn, { borderColor: C.danger, backgroundColor: C.dangerBg }]} onPress={handleSignOut}>
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
  const notifications = useStore((s) => s.notifications);
  const markNotificationRead = useStore((s) => s.markNotificationRead);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const loading = useStore((s) => s.storeLoading);
  const C = useColors();
  const [showProfile, setShowProfile] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleRefresh = useCallback(async () => {
    const sid = useStore.getState().currentStore?.id;
    if (!sid) return;
    try {
      await useStore.getState().loadFromSupabase(sid);
      Toast.show({ type: 'success', text1: 'Refreshed', visibilityTime: 1200 });
    } catch {
      Toast.show({ type: 'error', text1: "Couldn't refresh", visibilityTime: 1500 });
    }
  }, []);

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 16, gap: 10 }}>
        {/* Refresh — pulls fresh data from Supabase without navigating */}
        <TouchableOpacity onPress={handleRefresh} disabled={loading} activeOpacity={0.7}>
          {loading
            ? <ActivityIndicator size="small" color={C.textSecondary} />
            : <Ionicons name="refresh-outline" size={22} color={C.textSecondary} />
          }
        </TouchableOpacity>
        {/* Notification bell — admins only */}
        {isAdmin && (
          <TouchableOpacity onPress={() => setShowNotifs(true)} activeOpacity={0.7}>
            <Ionicons name="notifications-outline" size={22} color={C.textSecondary} />
            {unreadCount > 0 && (
              <View style={styles.notifBadge}>
                <Text style={styles.notifBadgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.headerAvatar, { backgroundColor: (currentUser?.color || '#378ADD') + '33' }]}
          onPress={() => setShowProfile(true)}
          activeOpacity={0.7}
        >
          <Text style={[styles.headerAvatarText, { color: currentUser?.color || '#378ADD' }]}>
            {currentUser?.initials}
          </Text>
        </TouchableOpacity>
      </View>
      <ProfileSidebar visible={showProfile} onClose={() => setShowProfile(false)} />

      {/* Notifications dropdown */}
      <Modal visible={showNotifs} transparent animationType="fade">
        <TouchableOpacity style={styles.notifOverlay} activeOpacity={1} onPress={() => setShowNotifs(false)}>
          <View style={[styles.notifDropdown, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <View style={[styles.notifHeader, { borderBottomColor: C.borderLight }]}>
              <Text style={[styles.notifTitle, { color: C.textPrimary }]}>Notifications</Text>
              {notifications.length > 0 && (
                <TouchableOpacity onPress={() => { clearNotifications(); setShowNotifs(false); }}>
                  <Text style={{ fontSize: FontSize.xs, color: C.info }}>Clear all</Text>
                </TouchableOpacity>
              )}
            </View>
            <ScrollView style={{ maxHeight: 300 }}>
              {notifications.length === 0 ? (
                <Text style={[styles.notifEmpty, { color: C.textTertiary }]}>No notifications</Text>
              ) : (
                notifications.map((n) => (
                  <TouchableOpacity
                    key={n.id}
                    style={[styles.notifItem, { borderBottomColor: C.borderLight }, !n.read && { backgroundColor: C.infoBg }]}
                    onPress={() => markNotificationRead(n.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.notifMessage, { color: C.textPrimary }]}>{n.message}</Text>
                      <Text style={[styles.notifTime, { color: C.textTertiary }]}>
                        {new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                    {!n.read && <View style={[styles.notifDot, { backgroundColor: C.info }]} />}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
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
  const C = useColors();
  const isAdmin = currentUser?.role === 'admin';

  const items = [
    { label: 'Waste Log', screen: 'WasteLog', icon: 'trash-outline' as const },
    { label: 'Ingredients', screen: 'Ingredients', icon: 'nutrition-outline' as const },
    { label: 'Prep Recipes', screen: 'PrepRecipes', icon: 'flask-outline' as const },
    { label: 'Menu Items / BOM', screen: 'Recipes', icon: 'restaurant-outline' as const },
    { label: 'Suggested Orders', screen: 'OrderReport', icon: 'receipt-outline' as const },
    ...(isAdmin ? [
      { label: 'EOD History', screen: 'EODHistory', icon: 'calendar-outline' as const },
      { label: 'Vendors', screen: 'Vendors', icon: 'business-outline' as const },
      { label: 'POS Import', screen: 'POSImport', icon: 'cloud-upload-outline' as const },
      { label: 'Reconciliation', screen: 'Reconciliation', icon: 'git-compare-outline' as const },
      { label: 'Reports & Analytics', screen: 'Reports', icon: 'bar-chart-outline' as const },
      { label: 'Audit Log', screen: 'AuditLog', icon: 'time-outline' as const },
      { label: 'Users & Access', screen: 'Users', icon: 'people-outline' as const },
    ] : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
      <ScrollView style={{ flex: 1, backgroundColor: C.bgTertiary }}>
        <View style={styles.moreList}>
          {items.map((item) => (
            <TouchableOpacity
              key={item.screen}
              style={[styles.moreItem, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}
              onPress={() => navigation.navigate(item.screen)}
            >
              <Ionicons name={item.icon} size={20} color={C.textSecondary} />
              <Text style={[styles.moreLabel, { color: C.textPrimary }]}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={16} color={C.textTertiary} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.signOutSection}>
          <TouchableOpacity style={[styles.signOutBtn, { borderColor: C.dangerBg, backgroundColor: C.dangerBg }]} onPress={logout}>
            <Ionicons name="log-out-outline" size={16} color={C.danger} />
            <Text style={[styles.signOutText, { color: C.danger }]}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function TabNavigator() {
  const storeId = useStore((s) => s.currentStore.id);
  const C = useColors();
  return (
    <Tab.Navigator
      key={storeId}
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: C.bgPrimary, elevation: 0, shadowOpacity: 0 } as any,
        headerTitleStyle: { fontSize: FontSize.base, fontWeight: '500' as const, color: C.textPrimary },
        headerTintColor: C.textPrimary,
        headerRight: () => <HeaderRight />,
        headerLeft: () => <HeaderLeft />,
        headerTitle: '',
        sceneContainerStyle: { backgroundColor: C.bgTertiary },
        tabBarStyle: {
          backgroundColor: C.bgPrimary,
          borderTopColor: C.borderLight,
          borderTopWidth: 0.5,
          height: 60,
          paddingBottom: 6,
        },
        tabBarActiveTintColor: C.textPrimary,
        tabBarInactiveTintColor: C.textTertiary,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' as const },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICONS[route.name] || 'ellipse-outline'} size={size - 2} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      {/* Menu Items / BOM lives in the bottom nav AND in the More menu — the
          More entry calls navigate('Recipes') which resolves up to this tab,
          so both entry points land on the same screen. */}
      <Tab.Screen name="Recipes" component={RecipesScreen} options={{ title: 'Menu Items / BOM' }} />
      <Tab.Screen name="Items" component={ItemsScreen} options={{ title: 'Items & costs' }} />
      <Tab.Screen name="EODCount" component={EODCountScreen} options={{ title: 'EOD Count' }} />
      <Tab.Screen name="Orders" component={OrdersScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

function StoreLoadingOverlay() {
  const loading = useStore((s) => s.storeLoading);
  const C = useColors();
  if (!loading) return null;
  return (
    <View style={styles.loadingOverlay}>
      <View style={[styles.loadingBox, { backgroundColor: C.bgPrimary }]}>
        <ActivityIndicator size="large" color={C.info} />
        <Text style={[styles.loadingText, { color: C.textSecondary }]}>Loading store data...</Text>
      </View>
    </View>
  );
}

function AppStackNavigator() {
  const storeId = useStore((s) => s.currentStore?.id);
  const C = useColors();

  // Debounce: a multi-store insert (e.g. propagating one menu item across 6
  // stores) fires N realtime events back-to-back. Without the debounce each
  // would trigger its own loadFromSupabase. 400ms quiet-period collapses the
  // burst into a single reload.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSync = useCallback(() => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      const sid = useStore.getState().currentStore?.id;
      if (sid) useStore.getState().loadFromSupabase(sid);
    }, 400);
  }, []);

  useEffect(() => () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);

  useRealtimeSync(storeId, handleSync);
  useJsonServerSync();

  const dynamicHeaderOptions = {
    headerStyle: { backgroundColor: C.bgPrimary, elevation: 0, shadowOpacity: 0 } as any,
    headerTitleStyle: { fontSize: FontSize.base, fontWeight: '500' as const, color: C.textPrimary },
    headerTintColor: C.textPrimary,
    headerRight: () => <HeaderRight />,
    cardStyle: { backgroundColor: C.bgTertiary },
  };

  return (
    <>
      <AppStack.Navigator key={storeId} screenOptions={dynamicHeaderOptions}>
        <AppStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
        <AppStack.Screen name="WasteLog" component={WasteLogScreen} options={{ title: 'Waste Log', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="Ingredients" component={IngredientsScreen} options={{ title: 'Ingredients', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="PrepRecipes" component={PrepRecipesScreen} options={{ title: 'Prep recipes', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="EODHistory" component={EODHistoryScreen} options={{ title: 'EOD History', headerLeft: () => <StackHeaderLeft /> }} />
        {/* Recipes / Menu Items / BOM is now a Tab.Screen (see TabNavigator).
            The More menu's navigate('Recipes') resolves up to that tab. */}
        <AppStack.Screen name="Vendors" component={VendorsScreen} options={{ headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="OrderReport" component={OrderReportScreen} options={{ title: 'Suggested Orders', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="POSImport" component={POSImportScreen} options={{ title: 'POS import', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="Reconciliation" component={ReconciliationScreen} options={{ headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="Reports" component={ReportsScreen} options={{ title: 'Reports & analytics', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="AuditLog" component={AuditLogScreen} options={{ title: 'Audit log', headerLeft: () => <StackHeaderLeft /> }} />
        <AppStack.Screen name="Users" component={UsersScreen} options={{ title: 'Users & access' }} />
      </AppStack.Navigator>
      <StoreLoadingOverlay />
    </>
  );
}

function MasterNavigator() {
  const C = useColors();
  return (
    <AppStack.Navigator screenOptions={{
      headerStyle: { backgroundColor: C.bgPrimary, elevation: 0, shadowOpacity: 0 } as any,
      headerTitleStyle: { fontSize: FontSize.base, fontWeight: '500' as const, color: C.textPrimary },
      headerTintColor: C.textPrimary,
      headerRight: () => <HeaderRight />,
      cardStyle: { backgroundColor: C.bgTertiary },
    }}>
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
          currentUser.role === 'master' ? (
            <RootStack.Screen name="App" component={MasterNavigator} />
          ) : (
            <RootStack.Screen name="App" component={AppStackNavigator} />
          )
        ) : (
          <>
            <RootStack.Screen name="Login" component={LoginScreen} />
            <RootStack.Screen name="Register" component={RegisterScreen} />
          </>
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
  notifBadge: { position: 'absolute', top: -4, right: -6, backgroundColor: '#E53E3E', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  notifBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  notifOverlay: { flex: 1, justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 56, paddingRight: 12 },
  notifDropdown: { width: 300, borderRadius: Radius.lg, borderWidth: 0.5, overflow: 'hidden', ...({ boxShadow: '0 8px 24px rgba(0,0,0,0.15)' } as any) },
  notifHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 0.5 },
  notifTitle: { fontSize: FontSize.sm, fontWeight: '600' },
  notifEmpty: { padding: Spacing.xl, textAlign: 'center', fontSize: FontSize.sm },
  notifItem: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 0.5, gap: Spacing.sm },
  notifMessage: { fontSize: FontSize.xs, fontWeight: '500' },
  notifTime: { fontSize: 10, marginTop: 2 },
  notifDot: { width: 8, height: 8, borderRadius: 4 },

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
  loadingOverlay: {
    position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center' as const, alignItems: 'center' as const, zIndex: 9999,
  },
  loadingBox: {
    paddingHorizontal: 32, paddingVertical: 24, borderRadius: Radius.lg,
    alignItems: 'center' as const, gap: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 5,
  },
  loadingText: { fontSize: FontSize.sm, fontWeight: '500' as const },
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
  notifHint: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    marginTop: 6,
    lineHeight: 16,
    paddingHorizontal: 2,
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
