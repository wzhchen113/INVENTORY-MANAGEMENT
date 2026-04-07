// src/screens/AdminScreens.tsx
// Contains: RecipesScreen, VendorsScreen,
//           RestockScreen, AuditLogScreen, ReportsScreen, UsersScreen

import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  FlatList, TextInput, Modal, Alert, Platform,
} from 'react-native';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge, WhoChip, KpiCard, EmptyState } from '../components';
import IngredientEditor from '../components/IngredientEditor';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { Recipe, Vendor, RecipeIngredient, RecipePrepItem } from '../types';
import { calculateWeeklyUsageTrend } from '../utils/usageCalculations';

// ─── RECIPES ────────────────────────────────────────────────────────────────
export function RecipesScreen() {
  const C = useColors();
  const {
    recipes, inventory, prepRecipes,
    getRecipeCost, getRecipeFoodCostPct,
    addRecipe, updateRecipe,
  } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [menuItem, setMenuItem] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [category, setCategory] = useState('Mains');

  // Ingredient editing state
  const [showIngModal, setShowIngModal] = useState(false);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [editIngredients, setEditIngredients] = useState<RecipeIngredient[]>([]);
  const [editPrepItems, setEditPrepItems] = useState<RecipePrepItem[]>([]);

  const [dupWarning, setDupWarning] = useState('');

  const handleSave = () => {
    if (!menuItem.trim()) { Alert.alert('Error', 'Recipe name required'); return; }

    const trimmedName = menuItem.trim().toLowerCase();
    const duplicate = recipes.some((r) => r.menuItem.toLowerCase() === trimmedName);

    if (duplicate) {
      setDupWarning(`A recipe named "${menuItem.trim()}" already exists.`);
      return;
    }
    setDupWarning('');

    addRecipe({
      menuItem: menuItem.trim(), category, sellPrice: parseFloat(sellPrice) || 0,
      ingredients: [], prepItems: [], storeId: 's1',
    });
    setMenuItem(''); setSellPrice(''); setShowModal(false);
  };

  const openIngredientEditor = (recipe: Recipe) => {
    setEditingRecipeId(recipe.id);
    setEditIngredients([...recipe.ingredients]);
    setEditPrepItems([...(recipe.prepItems || [])]);
    setShowIngModal(true);
  };

  const saveIngredients = () => {
    if (editingRecipeId) {
      updateRecipe(editingRecipeId, {
        ingredients: editIngredients,
        prepItems: editPrepItems,
      });
    }
    setShowIngModal(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <View style={[styles.infoBar, { backgroundColor: C.infoBg }]}>
        <Text style={[styles.infoText, { color: C.info }]}>Map each menu item to exact ingredient quantities. POS sales will auto-deduct inventory using these ratios.</Text>
      </View>
      <WebScrollView id="recipes-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]} onPress={() => { setDupWarning(''); setShowModal(true); }}>
          <Text style={[styles.addRowText, { color: C.info }]}>+ New recipe / menu item</Text>
        </TouchableOpacity>
        {recipes.map((recipe) => {
          const cost = getRecipeCost(recipe.id);
          const fcPct = getRecipeFoodCostPct(recipe.id);
          const fcOk = fcPct < 35;
          const preps = recipe.prepItems || [];
          return (
            <View key={recipe.id} style={[styles.recipeCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
              <View style={styles.recipeTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.recipeName, { color: C.textPrimary }]}>{recipe.menuItem}</Text>
                  <Text style={[styles.recipeCat, { color: C.textSecondary }]}>{recipe.category}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.fcPct, { color: fcOk ? C.success : C.danger }]}>
                    {fcPct.toFixed(1)}% food cost
                  </Text>
                  <Text style={[styles.recipePrices, { color: C.textSecondary }]}>
                    ${cost.toFixed(2)} cost · ${recipe.sellPrice.toFixed(2)} sell
                  </Text>
                </View>
              </View>
              <View style={[styles.ingList, { backgroundColor: C.bgSecondary }]}>
                {recipe.ingredients.map((ing, idx) => (
                  <View key={idx} style={styles.ingRow}>
                    <Text style={[styles.ingName, { color: C.textPrimary }]}>{ing.itemName}</Text>
                    <Text style={[styles.ingQty, { color: C.textSecondary }]}>{ing.quantity} {ing.unit}</Text>
                  </View>
                ))}
                {preps.map((prep, idx) => (
                  <View key={`prep-${idx}`} style={styles.ingRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={[styles.prepTag, { backgroundColor: C.infoBg }]}><Text style={[styles.prepTagText, { color: C.info }]}>Prep</Text></View>
                      <Text style={[styles.ingName, { color: C.textPrimary }]}>{prep.prepRecipeName}</Text>
                    </View>
                    <Text style={[styles.ingQty, { color: C.textSecondary }]}>{prep.quantity} {prep.unit}</Text>
                  </View>
                ))}
                {recipe.ingredients.length === 0 && preps.length === 0 && (
                  <Text style={[styles.noIng, { color: C.textTertiary }]}>No ingredients mapped yet — tap Edit to add</Text>
                )}
              </View>
              <TouchableOpacity style={[styles.editRecipeBtn, { borderColor: C.borderMedium }]} onPress={() => openIngredientEditor(recipe)}>
                <Text style={[styles.editRecipeBtnText, { color: C.textSecondary }]}>Edit ingredients</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </WebScrollView>

      {/* New recipe modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>New recipe</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Menu item name</Text>
            <TextInput style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={menuItem} onChangeText={setMenuItem} placeholder="e.g. Grilled Chicken Plate" placeholderTextColor={C.textTertiary} />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Sell price ($)</Text>
            <TextInput style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={sellPrice} onChangeText={setSellPrice} keyboardType="decimal-pad" placeholder="14.00" placeholderTextColor={C.textTertiary} />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Category</Text>
            {['Mains', 'Salads', 'Starters', 'Desserts'].map((c) => (
              <TouchableOpacity key={c} style={[styles.catPill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, category === c && { backgroundColor: C.textPrimary }]} onPress={() => setCategory(c)}>
                <Text style={[styles.catPillText, { color: C.textSecondary }, category === c && { color: C.white }]}>{c}</Text>
              </TouchableOpacity>
            ))}
            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}
            <View style={styles.mfRow}>
              <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
                <Text style={[styles.saveBtnText, { color: C.white }]}>Save recipe</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Edit ingredients modal */}
      <Modal visible={showIngModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Edit ingredients</Text>
            <TouchableOpacity onPress={() => setShowIngModal(false)}>
              <Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <IngredientEditor
              ingredients={editIngredients}
              onIngredientsChange={setEditIngredients}
              availableItems={inventory}
              prepItems={editPrepItems}
              onPrepItemsChange={setEditPrepItems}
              availablePrepRecipes={prepRecipes}
              showPrepRecipes={true}
            />
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }]} onPress={saveIngredients}>
              <Text style={[styles.saveBtnText, { color: C.white }]}>Save ingredients</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── VENDORS ────────────────────────────────────────────────────────────────
export function VendorsScreen() {
  const C = useColors();
  const { vendors, addVendor } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [dupWarning, setDupWarning] = useState('');
  const [form, setForm] = useState({ name: '', contactName: '', phone: '', email: '', accountNumber: '', leadTimeDays: '2' });

  const handleSave = () => {
    if (!form.name.trim()) {
      if (Platform.OS === 'web') alert('Vendor name is required');
      else Alert.alert('Error', 'Vendor name is required');
      return;
    }

    const trimmedName = form.name.trim().toLowerCase();
    const duplicate = vendors.some((v) => v.name.toLowerCase() === trimmedName);

    if (duplicate) {
      setDupWarning(`A vendor named "${form.name.trim()}" already exists.`);
      return;
    }
    setDupWarning('');

    addVendor({ ...form, leadTimeDays: parseInt(form.leadTimeDays) || 2, deliveryDays: [], categories: [] });
    setShowModal(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <WebScrollView id="vendors-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]} onPress={() => { setDupWarning(''); setShowModal(true); }}>
          <Text style={[styles.addRowText, { color: C.info }]}>+ Add vendor</Text>
        </TouchableOpacity>
        {vendors.map((vendor) => (
          <View key={vendor.id} style={[styles.vendorCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <View style={styles.vendorTop}>
              <View style={[styles.vendorLogo, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                <Text style={[styles.vendorLogoText, { color: C.textSecondary }]}>{vendor.name.slice(0, 2).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.vendorName, { color: C.textPrimary }]}>{vendor.name}</Text>
                <Text style={[styles.vendorContact, { color: C.textSecondary }]}>{vendor.contactName} · {vendor.phone}</Text>
              </View>
              <View style={[styles.leadBadge, { backgroundColor: C.infoBg }]}>
                <Text style={[styles.leadText, { color: C.info }]}>{vendor.leadTimeDays}d lead</Text>
              </View>
            </View>
            <View style={styles.vendorMeta}>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Account</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.accountNumber}</Text>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Categories</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.categories.join(', ') || '—'}</Text>
              <Text style={[styles.metaLabel, { color: C.textTertiary }]}>Last order</Text>
              <Text style={[styles.metaValue, { color: C.textPrimary }]}>{vendor.lastOrderDate || '—'}</Text>
            </View>
          </View>
        ))}
      </WebScrollView>
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Add vendor</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            {[
              { label: 'Company name', key: 'name' },
              { label: 'Contact name', key: 'contactName' },
              { label: 'Phone', key: 'phone' },
              { label: 'Email', key: 'email' },
              { label: 'Account number', key: 'accountNumber' },
              { label: 'Lead time (days)', key: 'leadTimeDays', keyboard: 'numeric' },
            ].map((f) => (
              <View key={f.key}>
                <Text style={[styles.formLabel, { color: C.textSecondary }]}>{f.label}</Text>
                <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={(form as any)[f.key]} onChangeText={(v) => setForm((p) => ({ ...p, [f.key]: v }))} keyboardType={(f.keyboard as any) || 'default'} placeholderTextColor={C.textTertiary} />
              </View>
            ))}
            {dupWarning ? (
              <View style={[styles.dupWarning, { backgroundColor: C.warningBg, borderColor: C.warning }]}>
                <Text style={[styles.dupWarningText, { color: C.warning }]}>{dupWarning}</Text>
              </View>
            ) : null}
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleSave}>
              <Text style={[styles.saveBtnText, { color: C.white }]}>Save vendor</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── RESTOCK REPORT ─────────────────────────────────────────────────────────
// ─── AUDIT LOG ──────────────────────────────────────────────────────────────
export function AuditLogScreen() {
  const C = useColors();
  const { auditLog } = useStore();
  const [filter, setFilter] = useState('');

  const userColors: Record<string, string> = {
    Admin: C.userAdmin, 'Maria G.': C.userMaria,
    'James T.': C.userJames, 'Ana R.': C.userAna,
  };

  const filtered = filter
    ? auditLog.filter((e) => e.action.includes(filter) || e.userName.includes(filter))
    : auditLog;

  const actionColor = (action: string) => {
    if (action === 'EOD entry') return C.success;
    if (action === 'Waste log') return C.warning;
    if (action === 'POS import' || action === 'PO sent') return C.info;
    if (action === 'Item edit' || action === 'Item added') return '#7F77DD';
    return C.textSecondary;
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.filterScroll, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        {['', 'EOD entry', 'Waste log', 'Item edit', 'POS import', 'Stock adjusted'].map((f) => (
          <TouchableOpacity key={f || 'all'} style={[styles.filterChip, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, filter === f && { backgroundColor: C.textPrimary }]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, { color: C.textSecondary }, filter === f && { color: C.white }]}>{f || 'All'}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <WebScrollView id="audit-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        {filtered.length === 0 ? (
          <EmptyState message="No audit events" />
        ) : (
          filtered.map((event) => {
            const color = userColors[event.userName] || C.userAdmin;
            return (
              <View key={event.id} style={[styles.auditRow, { borderBottomColor: C.borderLight }]}>
                <View style={[styles.auditDot, { backgroundColor: actionColor(event.action) }]} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <WhoChip name={event.userName} color={color} />
                    <View style={[styles.actionTag, { backgroundColor: actionColor(event.action) + '22' }]}>
                      <Text style={[styles.actionTagText, { color: actionColor(event.action) }]}>{event.action}</Text>
                    </View>
                    <Text style={[styles.auditStore, { color: C.textTertiary }]}>{event.storeName}</Text>
                  </View>
                  <Text style={[styles.auditDetail, { color: C.textPrimary }]}>{event.detail} · {event.itemRef}</Text>
                  <Text style={[styles.auditMeta, { color: C.textTertiary }]}>{event.value} · {event.timestamp}</Text>
                </View>
              </View>
            );
          })
        )}
      </WebScrollView>
    </View>
  );
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────
export function ReportsScreen() {
  const C = useColors();
  const [tab, setTab] = useState<'foodcost' | 'usage' | 'waste'>('foodcost');
  const { recipes, getRecipeCost, getRecipeFoodCostPct, wasteLog, posImports, currentStore } = useStore();

  const totalWaste = wasteLog.reduce((s, e) => s + e.quantity * e.costPerUnit, 0);
  const usageTrend = React.useMemo(
    () => calculateWeeklyUsageTrend(posImports, recipes, currentStore.id, 4),
    [posImports, recipes, currentStore.id]
  );

  return (
    <WebScrollView id="reports-scroll" contentContainerStyle={{ padding: Spacing.lg, backgroundColor: C.bgTertiary }}>
      {/* Tabs */}
      <View style={[styles.tabBar, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}>
        {(['foodcost', 'usage', 'waste'] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tabItem, tab === t && { borderBottomColor: C.textPrimary }]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, { color: C.textSecondary }, tab === t && { color: C.textPrimary }]}>
              {t === 'foodcost' ? 'Food cost' : t === 'usage' ? 'Usage' : 'Waste'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'foodcost' && (
        <>
          <View style={styles.kpiRow}>
            <KpiCard label="Overall food cost %" value="31.4%" sub="Target 28–35% ✓" variant="success" />
            <View style={{ width: Spacing.sm }} />
            <KpiCard label="COGS this week" value="$2,840" sub="vs $9,040 revenue" />
          </View>
          <Card>
            <CardHeader title="Food cost % by recipe" />
            {recipes.map((r) => {
              const cost = getRecipeCost(r.id);
              const pct = getRecipeFoodCostPct(r.id);
              const ok = pct < 35;
              return (
                <View key={r.id} style={[styles.reportRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.reportName, { color: C.textPrimary }]}>{r.menuItem}</Text>
                    <Text style={[styles.reportSub, { color: C.textSecondary }]}>${cost.toFixed(2)} cost · ${r.sellPrice.toFixed(2)} sell</Text>
                  </View>
                  <Text style={[styles.reportPct, { color: ok ? C.success : C.danger }]}>{pct.toFixed(1)}%</Text>
                </View>
              );
            })}
          </Card>
          <Card>
            <CardHeader title="By category" />
            {[
              { cat: 'Protein', pct: 32.9, ok: true },
              { cat: 'Seafood', pct: 38.0, ok: false },
              { cat: 'Produce', pct: 25.0, ok: true },
              { cat: 'Dairy', pct: 28.0, ok: true },
              { cat: 'Dry goods', pct: 29.7, ok: true },
            ].map((c) => (
              <View key={c.cat} style={styles.catFcRow}>
                <Text style={[styles.catFcName, { color: C.textPrimary }]}>{c.cat}</Text>
                <View style={[styles.fcBar, { backgroundColor: C.borderLight }]}>
                  <View style={[styles.fcFill, { width: `${Math.min(100, c.pct / 50 * 100)}%`, backgroundColor: c.ok ? C.success : C.danger }]} />
                </View>
                <Text style={[styles.fcPctVal, { color: c.ok ? C.success : C.danger }]}>{c.pct}%</Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {tab === 'usage' && (
        <Card>
          <CardHeader title={`Weekly ingredient usage — ${currentStore.name}`} />
          {usageTrend.length === 0 ? (
            <EmptyState message="No POS data imported yet. Import sales from the POS screen to see usage trends." />
          ) : (
            usageTrend.map((u) => {
              const maxVal = Math.max(...u.weeklyAmounts, 1);
              return (
                <View key={u.itemId} style={[styles.usageRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.usageName, { color: C.textPrimary }]}>{u.itemName}</Text>
                    <Text style={[styles.usageSub, { color: C.textSecondary }]}>Avg: {u.average} {u.unit}/week</Text>
                  </View>
                  <View style={styles.usageWeeks}>
                    {u.weeklyAmounts.map((v, i) => (
                      <View key={i} style={styles.weekCol}>
                        <View style={[styles.weekBar, { height: Math.max(4, (v / maxVal) * 50), backgroundColor: i === u.weeklyAmounts.length - 1 ? C.info : C.borderMedium }]} />
                        <Text style={[styles.weekLabel, { color: C.textTertiary }]}>W{i + 1}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              );
            })
          )}
        </Card>
      )}

      {tab === 'waste' && (
        <>
          <View style={styles.kpiRow}>
            <KpiCard label="Total waste" value={`$${totalWaste.toFixed(0)}`} sub="This week" variant="warning" />
            <View style={{ width: Spacing.sm }} />
            <KpiCard label="As % of revenue" value="1.6%" sub="Industry avg 2–4%" variant="success" />
          </View>
          <Card>
            <CardHeader title="Waste entries" />
            {wasteLog.map((e) => (
              <View key={e.id} style={[styles.wasteReportRow, { borderBottomColor: C.borderLight }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.reportName, { color: C.textPrimary }]}>{e.itemName}</Text>
                  <Text style={[styles.reportSub, { color: C.textSecondary }]}>{e.reason} · {e.quantity} {e.unit}</Text>
                </View>
                <Text style={[styles.reportPct, { color: C.warning }]}>${(e.quantity * e.costPerUnit).toFixed(2)}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </WebScrollView>
  );
}

// ─── USERS ──────────────────────────────────────────────────────────────────
export function UsersScreen() {
  const C = useColors();
  const { users, stores, currentUser, inviteUser } = useStore();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'user' as 'admin' | 'user', storeIds: ['s1'] });

  const handleInvite = () => {
    if (!form.name || !form.email) { Alert.alert('Error', 'Name and email required'); return; }
    inviteUser({ ...form, stores: form.storeIds, status: 'pending', initials: form.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(), color: C.userAdmin });
    setShowModal(false);
  };

  const userColors: Record<string, string> = { '#378ADD': C.userAdmin, '#1D9E75': C.userMaria, '#D85A30': C.userJames, '#D4537E': C.userAna };

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <WebScrollView id="users-scroll" contentContainerStyle={{ padding: Spacing.lg }}>
        <TouchableOpacity style={[styles.addRow, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]} onPress={() => setShowModal(true)}>
          <Text style={[styles.addRowText, { color: C.info }]}>+ Invite user</Text>
        </TouchableOpacity>
        {users.map((user) => (
          <View key={user.id} style={[styles.userCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <View style={styles.userTop}>
              <View style={[styles.userAvatar, { backgroundColor: user.color + '22' }]}>
                <Text style={[styles.userInitials, { color: user.color }]}>{user.initials}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.userName, { color: C.textPrimary }]}>{user.name}</Text>
                <Text style={[styles.userEmail, { color: C.textSecondary }]}>{user.email}</Text>
              </View>
              <Badge label={user.role === 'admin' ? 'Admin' : 'Store user'} variant={user.role === 'admin' ? 'admin' : 'user'} />
            </View>
            <View style={styles.userMeta}>
              <Text style={[styles.userMetaLabel, { color: C.textTertiary }]}>Store access</Text>
              <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                {user.stores.map((sid) => {
                  const store = stores.find((s) => s.id === sid);
                  return store ? (
                    <View key={sid} style={[styles.storeTag, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                      <Text style={[styles.storeTagText, { color: C.textSecondary }]}>{store.name}</Text>
                    </View>
                  ) : null;
                })}
              </View>
            </View>
            <View style={[styles.userFooter, { borderTopColor: C.borderLight }]}>
              <Badge label={user.status === 'active' ? 'Active' : 'Pending invite'} variant={user.status === 'active' ? 'ok' : 'pending'} />
            </View>
          </View>
        ))}
      </WebScrollView>
      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Invite user</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}><Text style={[styles.modalClose, { color: C.info }]}>Cancel</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: Spacing.lg }}>
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Full name</Text>
            <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={form.name} onChangeText={(v) => setForm((p) => ({ ...p, name: v }))} placeholderTextColor={C.textTertiary} placeholder="e.g. Maria Garcia" />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Email address</Text>
            <TextInput style={[styles.formInput, { marginBottom: Spacing.md, color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]} value={form.email} onChangeText={(v) => setForm((p) => ({ ...p, email: v }))} keyboardType="email-address" autoCapitalize="none" placeholderTextColor={C.textTertiary} placeholder="maria@restaurant.com" />
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Role</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: Spacing.md }}>
              {(['user', 'admin'] as const).map((r) => (
                <TouchableOpacity key={r} style={[styles.roleBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderMedium }, form.role === r && { backgroundColor: C.textPrimary }]} onPress={() => setForm((p) => ({ ...p, role: r }))}>
                  <Text style={[styles.roleBtnText, { color: C.textSecondary }, form.role === r && { color: C.white }]}>{r === 'admin' ? 'Admin' : 'Store user'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.formLabel, { color: C.textSecondary }]}>Store access</Text>
            {stores.map((store) => {
              const selected = form.storeIds.includes(store.id);
              return (
                <TouchableOpacity key={store.id} style={[styles.storeSelector, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }, selected && { borderColor: C.textPrimary, backgroundColor: C.textPrimary + '11' }]}
                  onPress={() => setForm((p) => ({ ...p, storeIds: selected ? p.storeIds.filter((s) => s !== store.id) : [...p.storeIds, store.id] }))}>
                  <View style={[styles.checkbox, { borderColor: C.borderMedium }, selected && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}>
                    {selected && <Text style={{ color: C.white, fontSize: 10 }}>✓</Text>}
                  </View>
                  <Text style={[styles.storeName, { color: C.textPrimary }]}>{store.name}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={[styles.saveBtn, { marginTop: Spacing.xl, backgroundColor: C.textPrimary }]} onPress={handleInvite}>
              <Text style={[styles.saveBtnText, { color: C.white }]}>Send invite</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  infoBar: { backgroundColor: Colors.infoBg, margin: Spacing.lg, marginBottom: 0, borderRadius: Radius.md, padding: Spacing.md },
  infoText: { fontSize: FontSize.xs, color: Colors.info, lineHeight: 17 },
  addRow: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.borderLight, alignItems: 'center', borderStyle: 'dashed' },
  addRowText: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '500' },
  recipeCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  recipeTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  recipeName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  recipeCat: { fontSize: FontSize.xs, color: Colors.textSecondary },
  fcPct: { fontSize: FontSize.sm, fontWeight: '600' },
  recipePrices: { fontSize: 10, color: Colors.textSecondary, marginTop: 2 },
  ingList: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.sm, marginBottom: Spacing.sm },
  ingRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  ingName: { fontSize: FontSize.xs, color: Colors.textPrimary },
  ingQty: { fontSize: FontSize.xs, color: Colors.textSecondary },
  noIng: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.sm },
  editRecipeBtn: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: 6, alignItems: 'center' },
  editRecipeBtnText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  prepTag: { backgroundColor: Colors.infoBg, borderRadius: Radius.round, paddingHorizontal: 5, paddingVertical: 1 },
  prepTagText: { fontSize: 8, fontWeight: '600', color: Colors.info },
  vendorCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  vendorTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  vendorLogo: { width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: Colors.borderLight },
  vendorLogoText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  vendorName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  vendorContact: { fontSize: FontSize.xs, color: Colors.textSecondary },
  leadBadge: { backgroundColor: Colors.infoBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  leadText: { fontSize: 9, color: Colors.info, fontWeight: '500' },
  vendorMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metaLabel: { fontSize: 9, color: Colors.textTertiary, marginRight: 4 },
  metaValue: { fontSize: FontSize.xs, color: Colors.textPrimary },
  tabBar: { flexDirection: 'row', backgroundColor: Colors.bgPrimary, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  tabItem: { flex: 1, paddingVertical: Spacing.md, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabItemActive: { borderBottomColor: Colors.textPrimary },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  tabTextActive: { color: Colors.textPrimary, fontWeight: '500' },
  filterScroll: { backgroundColor: Colors.bgPrimary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight, flexGrow: 0 },
  filterChip: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  filterChipActive: { backgroundColor: Colors.textPrimary },
  filterText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterTextActive: { color: Colors.white, fontWeight: '500' },
  auditRow: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  auditDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
  actionTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.round },
  actionTagText: { fontSize: 9, fontWeight: '500' },
  auditStore: { fontSize: 9, color: Colors.textTertiary },
  auditDetail: { fontSize: FontSize.xs, color: Colors.textPrimary, marginTop: 3 },
  auditMeta: { fontSize: 9, color: Colors.textTertiary, marginTop: 2 },
  kpiRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  reportRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  reportName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  reportSub: { fontSize: 10, color: Colors.textSecondary },
  reportPct: { fontSize: FontSize.base, fontWeight: '600' },
  catFcRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6 },
  catFcName: { width: 80, fontSize: FontSize.xs, color: Colors.textPrimary },
  fcBar: { flex: 1, height: 6, backgroundColor: Colors.borderLight, borderRadius: 3, overflow: 'hidden' },
  fcFill: { height: 6, borderRadius: 3 },
  fcPctVal: { width: 36, fontSize: FontSize.xs, fontWeight: '500', textAlign: 'right' },
  usageRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  usageName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  usageSub: { fontSize: 10, color: Colors.textSecondary },
  usageWeeks: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 40 },
  weekCol: { alignItems: 'center', gap: 2 },
  weekBar: { width: 14, borderRadius: 2 },
  weekLabel: { fontSize: 8, color: Colors.textTertiary },
  wasteReportRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  userCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  userTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  userAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  userInitials: { fontSize: FontSize.sm, fontWeight: '600' },
  userName: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary },
  userEmail: { fontSize: FontSize.xs, color: Colors.textSecondary },
  userMeta: { marginBottom: Spacing.sm },
  userMetaLabel: { fontSize: 9, color: Colors.textTertiary, marginBottom: 4 },
  userFooter: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: Colors.borderLight, paddingTop: Spacing.sm },
  storeTag: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: Colors.borderLight },
  storeTagText: { fontSize: 9, color: Colors.textSecondary },
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  modalClose: { color: Colors.info, fontSize: FontSize.base },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 5, marginTop: Spacing.sm },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  catPill: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.round, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 6, borderWidth: 0.5, borderColor: Colors.borderLight },
  catPillActive: { backgroundColor: Colors.textPrimary },
  catPillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  mfRow: { marginTop: Spacing.xl },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center' },
  saveBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },
  roleBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: 8, alignItems: 'center', backgroundColor: Colors.bgSecondary },
  roleBtnActive: { backgroundColor: Colors.textPrimary },
  roleBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  storeSelector: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.md, borderWidth: 0.5, borderColor: Colors.borderLight, marginBottom: 6, backgroundColor: Colors.bgSecondary },
  storeSelectorActive: { borderColor: Colors.textPrimary, backgroundColor: Colors.textPrimary + '11' },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: Colors.borderMedium, alignItems: 'center', justifyContent: 'center' },
  checkboxActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  storeName: { fontSize: FontSize.sm, color: Colors.textPrimary },
  dupWarning: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  dupWarningText: { fontSize: FontSize.sm, fontWeight: '500' },
});
