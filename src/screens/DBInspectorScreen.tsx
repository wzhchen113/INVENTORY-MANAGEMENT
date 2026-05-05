// src/screens/DBInspectorScreen.tsx
//
// Admin-only diagnostic screen. Bypasses the Zustand cache and reads
// the DB directly via the admin_db_inspector_probe RPC so an admin can
// see exactly what's in Supabase vs what the app is showing.
//
// Surfaces three things:
//   1. Auth probe — whether YOUR JWT is admin (writes get silently
//      denied by RLS otherwise; this is often the answer to "delete
//      doesn't reach backend").
//   2. Schema state — pre-P3 (per-store) vs post-P3 (brand-scoped),
//      and whether the prep partial unique index from Stage 3a is in.
//   3. Duplicate groups by `(brand_id, lower(name))` for both `recipes`
//      and `prep_recipes`, classified as hard duplicate / version
//      history / orphan-current. Hard duplicates expose a Merge action
//      that calls admin_dedupe_recipes / admin_dedupe_prep_recipes.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useStore } from '../store/useStore';
import { useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { Card, EmptyState } from '../components';
import { TimezoneBar } from '../components/TimezoneBar';

type RecipeRow = {
  id: string;
  menu_item: string;
  created_at: string;
  recipe_ingredients_count: number;
  recipe_prep_items_count: number;
  pos_import_items_count: number;
  pos_recipe_aliases_count: number;
};

type PrepRow = {
  id: string;
  name: string;
  version: number;
  is_current: boolean;
  parent_id: string | null;
  created_at: string;
  prep_recipe_ingredients_count: number;
  recipe_prep_items_count: number;
  sub_recipe_refs_count: number;
};

type RecipeGroup = {
  brand_id: string;
  lname: string;
  display_name: string;
  total: number;
  rows: RecipeRow[];
};

type PrepGroup = {
  brand_id: string;
  lname: string;
  display_name: string;
  total: number;
  current_count: number;
  rows: PrepRow[];
};

type Probe = {
  auth: { is_admin: boolean; app_metadata: any; user_id: string | null };
  schema: {
    recipes_has_store_id: boolean;
    recipes_has_brand_id: boolean;
    prep_has_store_id: boolean;
    prep_has_brand_id: boolean;
    has_p3_unique: boolean;
    has_legacy_unique: boolean;
    has_prep_partial_unique: boolean;
  };
  counts: { recipes_total: number; prep_total: number; prep_current: number };
  recipe_groups: RecipeGroup[];
  prep_groups: PrepGroup[];
};

type PrepClass = 'hard' | 'history' | 'orphan';

function classifyPrep(g: PrepGroup): PrepClass {
  if (g.current_count > 1) return 'hard';
  if (g.current_count === 0) return 'orphan';
  return 'history';
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function describeSchema(s: Probe['schema']): { label: string; tone: 'ok' | 'warn' | 'err' } {
  const postP3 =
    !s.recipes_has_store_id && s.recipes_has_brand_id &&
    !s.prep_has_store_id && s.prep_has_brand_id &&
    s.has_p3_unique && !s.has_legacy_unique;
  if (postP3) return { label: 'Schema: post-P3 (brand-scoped)', tone: 'ok' };

  const preP3 =
    s.recipes_has_store_id && s.has_legacy_unique && !s.has_p3_unique;
  if (preP3) return { label: 'Schema: pre-P3 (per-store)', tone: 'warn' };

  return { label: 'Schema: drift detected — check probe output', tone: 'err' };
}

export default function DBInspectorScreen() {
  const C = useColors();
  const { recipes: cachedRecipes, prepRecipes: cachedPreps } = useStore();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<
    | { kind: 'recipe'; group: RecipeGroup }
    | { kind: 'prep'; group: PrepGroup }
    | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc('admin_db_inspector_probe');
      if (rpcErr) throw rpcErr;
      setProbe(data as Probe);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const schemaInfo = useMemo(() => probe ? describeSchema(probe.schema) : null, [probe]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: Spacing.xxl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Text style={[styles.h1, { color: C.textPrimary }]}>DB Inspector</Text>
          <TouchableOpacity
            onPress={refresh}
            style={[styles.refreshBtn, { borderColor: C.borderLight, backgroundColor: C.bgPrimary }]}
            disabled={loading}
          >
            {loading ? <ActivityIndicator size="small" /> : <Ionicons name="refresh" size={16} color={C.textSecondary} />}
            <Text style={[styles.refreshText, { color: C.textSecondary }]}>{loading ? 'Loading…' : 'Refresh'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.subtitle, { color: C.textSecondary }]}>
          Live state from Supabase, bypassing the Zustand cache. Use this when frontend rows seem out of sync with what an external app sees.
        </Text>

        {error && (
          <Card>
            <View style={styles.row}><Ionicons name="alert-circle" size={18} color={C.danger} /><Text style={[styles.errText, { color: C.danger }]}>{error}</Text></View>
          </Card>
        )}

        {probe && (
          <>
            {/* Auth probe */}
            <Card>
              <Text style={[styles.cardTitle, { color: C.textPrimary }]}>Auth</Text>
              {probe.auth.is_admin ? (
                <View style={styles.row}>
                  <Ionicons name="shield-checkmark" size={18} color={C.success} />
                  <Text style={[styles.bodyText, { color: C.textPrimary }]}>You are admin — writes are authorized.</Text>
                </View>
              ) : (
                <View>
                  <View style={styles.row}>
                    <Ionicons name="warning" size={18} color={C.danger} />
                    <Text style={[styles.bodyText, { color: C.danger, fontWeight: '600' }]}>You are NOT admin per the JWT.</Text>
                  </View>
                  <Text style={[styles.smallText, { color: C.textSecondary, marginTop: 6 }]}>
                    Brand-catalog P5 RLS gates writes by auth_is_admin(). If you expect to be admin, ALL your CRUD is being silently denied — that is the most likely cause of "delete doesn't reach backend".
                  </Text>
                </View>
              )}
              <Text style={[styles.kvLine, { color: C.textTertiary }]}>app_metadata: {JSON.stringify(probe.auth.app_metadata)}</Text>
              <Text style={[styles.kvLine, { color: C.textTertiary }]}>user_id: {probe.auth.user_id ?? '(none)'}</Text>
            </Card>

            {/* Schema state */}
            {schemaInfo && (
              <Card>
                <Text style={[styles.cardTitle, { color: C.textPrimary }]}>Schema</Text>
                <View style={styles.row}>
                  <Ionicons
                    name={schemaInfo.tone === 'ok' ? 'checkmark-circle' : schemaInfo.tone === 'warn' ? 'alert-circle' : 'close-circle'}
                    size={18}
                    color={schemaInfo.tone === 'ok' ? C.success : schemaInfo.tone === 'warn' ? C.warning : C.danger}
                  />
                  <Text style={[styles.bodyText, { color: C.textPrimary }]}>{schemaInfo.label}</Text>
                </View>
                <Text style={[styles.kvLine, { color: C.textTertiary, marginTop: 6 }]}>
                  recipes.brand_id: {probe.schema.recipes_has_brand_id ? '✓' : '✗'} · recipes.store_id: {probe.schema.recipes_has_store_id ? '✓' : '✗'}{'\n'}
                  prep.brand_id: {probe.schema.prep_has_brand_id ? '✓' : '✗'} · prep.store_id: {probe.schema.prep_has_store_id ? '✓' : '✗'}{'\n'}
                  recipes_brand_menu_item_unique: {probe.schema.has_p3_unique ? '✓' : '✗'} · prep_recipes_brand_name_current_unique: {probe.schema.has_prep_partial_unique ? '✓' : '✗'}
                </Text>
              </Card>
            )}

            {/* Recipes section */}
            <Card>
              <View style={styles.headerRow}>
                <Text style={[styles.cardTitle, { color: C.textPrimary }]}>recipes</Text>
                <Text style={[styles.kvLine, { color: C.textSecondary }]}>
                  Cache: {cachedRecipes.length} · DB: {probe.counts.recipes_total} · Δ {cachedRecipes.length - probe.counts.recipes_total}
                </Text>
              </View>

              {probe.recipe_groups.length === 0 ? (
                <EmptyState message="No duplicate (brand_id, name) groups in recipes." />
              ) : (
                probe.recipe_groups.map((g) => {
                  const key = `r:${g.lname}`;
                  const expanded = expandedGroup === key;
                  return (
                    <View key={key} style={[styles.groupRow, { borderColor: C.borderLight }]}>
                      <TouchableOpacity onPress={() => setExpandedGroup(expanded ? null : key)} style={styles.groupHeader}>
                        <View style={styles.row}>
                          <View style={[styles.tag, { backgroundColor: C.danger + '22' }]}>
                            <Text style={[styles.tagText, { color: C.danger }]}>Hard duplicate</Text>
                          </View>
                          <Text style={[styles.groupName, { color: C.textPrimary }]}>{g.display_name}</Text>
                        </View>
                        <View style={styles.row}>
                          <Text style={[styles.kvLine, { color: C.textSecondary }]}>{g.total} rows</Text>
                          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={C.textTertiary} />
                        </View>
                      </TouchableOpacity>
                      {expanded && (
                        <View style={{ marginTop: Spacing.sm }}>
                          {g.rows.map((r) => (
                            <View key={r.id} style={[styles.detailRow, { borderTopColor: C.borderLight }]}>
                              <Text style={[styles.kvLine, { color: C.textPrimary }]}>{shortId(r.id)} · {r.menu_item} · {fmtDate(r.created_at)}</Text>
                              <Text style={[styles.smallText, { color: C.textTertiary }]}>
                                ingredients: {r.recipe_ingredients_count} · prep_items: {r.recipe_prep_items_count} · pos_imports: {r.pos_import_items_count} · pos_aliases: {r.pos_recipe_aliases_count}
                              </Text>
                            </View>
                          ))}
                          <TouchableOpacity
                            onPress={() => setMergeTarget({ kind: 'recipe', group: g })}
                            style={[styles.mergeBtn, { backgroundColor: C.danger }]}
                          >
                            <Ionicons name="git-merge" size={14} color="#fff" />
                            <Text style={styles.mergeBtnText}>Merge…</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  );
                })
              )}
            </Card>

            {/* Prep recipes section */}
            <Card>
              <View style={styles.headerRow}>
                <Text style={[styles.cardTitle, { color: C.textPrimary }]}>prep_recipes</Text>
                <Text style={[styles.kvLine, { color: C.textSecondary }]}>
                  Cache: {cachedPreps.length} · DB current: {probe.counts.prep_current} · DB total (incl. history): {probe.counts.prep_total}
                </Text>
              </View>

              {probe.prep_groups.length === 0 ? (
                <EmptyState message="No (brand_id, name) groups with > 1 row in prep_recipes." />
              ) : (
                probe.prep_groups.map((g) => {
                  const key = `p:${g.lname}`;
                  const expanded = expandedGroup === key;
                  const cls = classifyPrep(g);
                  const tone =
                    cls === 'hard' ? { color: C.danger, label: 'Hard duplicate' } :
                    cls === 'orphan' ? { color: C.warning, label: 'Orphan (no current)' } :
                    { color: C.textTertiary, label: 'Version history' };
                  return (
                    <View key={key} style={[styles.groupRow, { borderColor: C.borderLight }]}>
                      <TouchableOpacity onPress={() => setExpandedGroup(expanded ? null : key)} style={styles.groupHeader}>
                        <View style={[styles.row, { flex: 1, flexShrink: 1 }]}>
                          <View style={[styles.tag, { backgroundColor: tone.color + '22' }]}>
                            <Text style={[styles.tagText, { color: tone.color }]}>{tone.label}</Text>
                          </View>
                          <Text style={[styles.groupName, { color: C.textPrimary }]} numberOfLines={1}>{g.display_name}</Text>
                        </View>
                        <View style={styles.row}>
                          <Text style={[styles.kvLine, { color: C.textSecondary }]}>{g.total} rows · {g.current_count} current</Text>
                          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={C.textTertiary} />
                        </View>
                      </TouchableOpacity>
                      {expanded && (
                        <View style={{ marginTop: Spacing.sm }}>
                          {g.rows.map((r) => (
                            <View key={r.id} style={[styles.detailRow, { borderTopColor: C.borderLight }]}>
                              <Text style={[styles.kvLine, { color: C.textPrimary }]}>
                                {shortId(r.id)} · v{r.version} · {r.is_current ? 'current' : 'history'} · {fmtDate(r.created_at)}
                              </Text>
                              <Text style={[styles.smallText, { color: C.textTertiary }]}>
                                name="{r.name}" · ingredients: {r.prep_recipe_ingredients_count} · used by {r.recipe_prep_items_count} recipes · sub_recipe refs: {r.sub_recipe_refs_count}
                              </Text>
                              {r.parent_id && (
                                <Text style={[styles.smallText, { color: C.textTertiary }]}>parent: {shortId(r.parent_id)}</Text>
                              )}
                            </View>
                          ))}
                          {cls === 'hard' && (
                            <TouchableOpacity
                              onPress={() => setMergeTarget({ kind: 'prep', group: g })}
                              style={[styles.mergeBtn, { backgroundColor: C.danger }]}
                            >
                              <Ionicons name="git-merge" size={14} color="#fff" />
                              <Text style={styles.mergeBtnText}>Merge…</Text>
                            </TouchableOpacity>
                          )}
                          {cls === 'orphan' && (
                            <Text style={[styles.smallText, { color: C.textSecondary, marginTop: Spacing.sm }]}>
                              All rows in this group are is_current=false. The frontend's fetchPrepRecipes filters by is_current=true so the recipe is invisible in the app. Likely from a failed updatePrepRecipeVersioned mid-flight (it flips is_current=false BEFORE inserting the new row; if the insert fails, no row remains current).
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  );
                })
              )}
            </Card>

            {/* External-app perspective */}
            <Card>
              <Text style={[styles.cardTitle, { color: C.textPrimary }]}>What external apps see</Text>
              <Text style={[styles.bodyText, { color: C.textSecondary }]}>
                The pwa-catalog edge function returns ALL prep_recipes rows (no is_current filter). External clients see {probe.counts.prep_total} prep rows total, of which only {probe.counts.prep_current} are current. The other {probe.counts.prep_total - probe.counts.prep_current} are version history that this app filters out.
              </Text>
            </Card>
          </>
        )}
      </ScrollView>

      <MergeModal
        target={mergeTarget}
        onClose={() => setMergeTarget(null)}
        onDone={() => { setMergeTarget(null); refresh(); }}
      />
    </View>
  );
}

// ─── Merge modal ─────────────────────────────────────────────────────────

type MergeTarget =
  | { kind: 'recipe'; group: RecipeGroup }
  | { kind: 'prep'; group: PrepGroup };

function MergeModal({
  target, onClose, onDone,
}: {
  target: MergeTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const C = useColors();
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Default canonical = first row in the eligible set (oldest is_current=true
  // for prep recipes; first row for recipes).
  useEffect(() => {
    if (!target) { setCanonicalId(null); return; }
    const allRows = target.group.rows as Array<RecipeRow | PrepRow>;
    const eligible = target.kind === 'prep'
      ? allRows.filter((r) => (r as PrepRow).is_current)
      : allRows;
    setCanonicalId(eligible[0]?.id || null);
  }, [target]);

  if (!target) return null;
  // For prep recipes, scope the merge to is_current=true rows only.
  // Version-history rows (is_current=false) stay in place by design —
  // the merge dedupes the *current* dupe set, history is audit trail.
  const allRows = target.group.rows as Array<RecipeRow | PrepRow>;
  const rows: Array<RecipeRow | PrepRow> =
    target.kind === 'prep'
      ? allRows.filter((r) => (r as PrepRow).is_current)
      : allRows;
  const dupeIds = rows.filter((r) => r.id !== canonicalId).map((r) => r.id);

  const submit = async () => {
    if (!canonicalId || dupeIds.length === 0) return;
    setSubmitting(true);
    try {
      const fn = target.kind === 'recipe' ? 'admin_dedupe_recipes' : 'admin_dedupe_prep_recipes';
      const { error } = await supabase.rpc(fn, { canonical_id: canonicalId, dupe_ids: dupeIds });
      if (error) throw error;
      Toast.show({
        type: 'success',
        text1: 'Merge complete',
        text2: `${dupeIds.length} row(s) merged into canonical.`,
        visibilityTime: 3000,
      });
      onDone();
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: 'Merge failed',
        text2: e?.message || String(e),
        visibilityTime: 5000,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
          <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Merge {target.kind === 'recipe' ? 'recipes' : 'prep recipes'}</Text>
          <Text style={[styles.smallText, { color: C.textSecondary, marginBottom: Spacing.md }]}>
            Pick the canonical row. All other rows will have their dependents (recipe_ingredients, recipe_prep_items, pos_recipe_aliases, …) repointed to the canonical, then deleted.
          </Text>

          <ScrollView style={{ maxHeight: 280 }}>
            {rows.map((r) => {
              const selected = r.id === canonicalId;
              const label = target.kind === 'recipe'
                ? `${(r as RecipeRow).menu_item} · ${shortId(r.id)} · ${fmtDate(r.created_at)}`
                : `v${(r as PrepRow).version} · ${(r as PrepRow).is_current ? 'current' : 'history'} · ${shortId(r.id)} · ${fmtDate(r.created_at)}`;
              return (
                <TouchableOpacity
                  key={r.id}
                  onPress={() => setCanonicalId(r.id)}
                  style={[
                    styles.canonChoice,
                    { borderColor: selected ? C.success : C.borderLight, backgroundColor: selected ? C.success + '11' : 'transparent' },
                  ]}
                >
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={selected ? C.success : C.textTertiary}
                  />
                  <Text style={[styles.bodyText, { color: C.textPrimary, flex: 1 }]} numberOfLines={2}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <Text style={[styles.smallText, { color: C.textSecondary, marginTop: Spacing.md }]}>
            {dupeIds.length} row(s) will be deleted, dependents repointed to canonical.
          </Text>

          <View style={[styles.row, { marginTop: Spacing.md, gap: Spacing.sm }]}>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.modalBtn, { borderColor: C.borderLight }]}
              disabled={submitting}
            >
              <Text style={[styles.modalBtnText, { color: C.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              style={[styles.modalBtn, { backgroundColor: C.danger, borderColor: C.danger }]}
              disabled={submitting || !canonicalId || dupeIds.length === 0}
            >
              {submitting
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={[styles.modalBtnText, { color: '#fff' }]}>Confirm merge</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: FontSize.xl, fontWeight: '700' },
  subtitle: { fontSize: FontSize.sm, marginBottom: Spacing.md },
  refreshBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.md, borderWidth: 1 },
  refreshText: { fontSize: FontSize.sm, fontWeight: '500' },
  cardTitle: { fontSize: FontSize.base, fontWeight: '600', marginBottom: Spacing.sm },
  bodyText: { fontSize: FontSize.sm, lineHeight: 20 },
  smallText: { fontSize: FontSize.xs, lineHeight: 16 },
  kvLine: { fontSize: FontSize.xs, fontFamily: 'Menlo', lineHeight: 18 },
  errText: { fontSize: FontSize.sm, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm, flexWrap: 'wrap', gap: 6 },
  groupRow: { borderTopWidth: 0.5, paddingVertical: Spacing.sm },
  groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  groupName: { fontSize: FontSize.sm, fontWeight: '600', flexShrink: 1 },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.round },
  tagText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  detailRow: { borderTopWidth: 0.5, paddingTop: 6, paddingBottom: 6 },
  mergeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: Spacing.lg, borderRadius: Radius.md, marginTop: Spacing.sm, alignSelf: 'flex-start' },
  mergeBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: Spacing.lg },
  modalBox: { borderRadius: Radius.xl, padding: Spacing.xl, borderWidth: 0.5, maxWidth: 480, alignSelf: 'center', width: '100%' },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.sm },
  canonChoice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, marginBottom: 6 },
  modalBtn: { flex: 1, borderWidth: 1, borderRadius: Radius.md, paddingVertical: Spacing.md, alignItems: 'center', justifyContent: 'center' },
  modalBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});
