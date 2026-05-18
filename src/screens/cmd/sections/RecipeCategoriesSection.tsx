import React from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { confirmAction } from '../../../utils/confirmAction';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { getLocalizedName } from '../../../i18n/localizedName';
import { translateOnSave } from '../../../lib/translate';
import type { LocalizedNames } from '../../../types';

// Spec 048 — Cmd UI admin section for `recipe_categories` (global, no
// brand-scoping). Mirrors `CategoriesSection.tsx` (ingredient categories)
// for rhythm; the differences are:
//   - usage counts are summed across `recipes` + `prepRecipes` (both
//     free-form `category` text columns, no FK) instead of `inventory`.
//   - the block-on-use toast splits the combined total into N (recipes)
//     and M (prep recipes) so the user knows which list to retag.
//   - in-memory only — no new `src/lib/db.ts` helper, no new store
//     action; reuses `addRecipeCategory` / `updateRecipeCategory` /
//     `deleteRecipeCategory` / `setRecipeCategoryI18nNames`.
export default function RecipeCategoriesSection() {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const recipeCategories      = useStore((s) => s.recipeCategories);
  const recipes               = useStore((s) => s.recipes);
  const prepRecipes           = useStore((s) => s.prepRecipes);
  const addRecipeCategory     = useStore((s) => s.addRecipeCategory);
  const updateRecipeCategory  = useStore((s) => s.updateRecipeCategory);
  const deleteRecipeCategory  = useStore((s) => s.deleteRecipeCategory);

  const [newName, setNewName]                 = React.useState('');
  const [newEs, setNewEs]                     = React.useState('');
  const [newZh, setNewZh]                     = React.useState('');
  const [newTranslating, setNewTranslating]   = React.useState(false);
  const [editingName, setEditingName]         = React.useState<string | null>(null);
  const [editValue, setEditValue]             = React.useState('');
  const [editI18n, setEditI18n]               = React.useState<LocalizedNames>({});
  const [editTranslating, setEditTranslating] = React.useState(false);
  const [warning, setWarning]                 = React.useState('');

  // Sorted by current-locale name with usage counts summed across
  // `recipes` + `prepRecipes`. recipes/prepRecipes are brand-shared so
  // there is no per-store filtering. Counts are split internally so the
  // negative-delete toast can surface N / M; the displayed column is the
  // combined total per AC #2.
  const sorted = React.useMemo(() => {
    const recipeCounts = new Map<string, number>();
    const prepCounts   = new Map<string, number>();
    for (const r of recipes) {
      if (r.category) recipeCounts.set(r.category, (recipeCounts.get(r.category) || 0) + 1);
    }
    for (const p of prepRecipes) {
      if (p.category) prepCounts.set(p.category, (prepCounts.get(p.category) || 0) + 1);
    }
    return [...recipeCategories]
      .map((c) => {
        const recipeUsageCount     = recipeCounts.get(c.name) || 0;
        const prepRecipeUsageCount = prepCounts.get(c.name) || 0;
        return {
          ...c,
          recipeUsageCount,
          prepRecipeUsageCount,
          totalUsageCount: recipeUsageCount + prepRecipeUsageCount,
          label: getLocalizedName({ name: c.name, i18nNames: c.i18nNames }, locale),
        };
      })
      // Spec 040 P3 / Q5 — sort by current-locale label. zh-CN falls
      // back to codepoint order without ICU (documented Known Limitation).
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [recipeCategories, recipes, prepRecipes, locale]);

  // Hybrid debounce/blur trigger for auto-fill on the + ADD form and the
  // per-row edit form. AbortController cancels in-flight requests when a
  // newer keystroke arrives, saving DeepL quota.
  const newAbortRef  = React.useRef<AbortController | null>(null);
  const newTimerRef  = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const editAbortRef = React.useRef<AbortController | null>(null);
  const editTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    newAbortRef.current?.abort();
    editAbortRef.current?.abort();
    if (newTimerRef.current)  clearTimeout(newTimerRef.current);
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
  }, []);

  const fetchTranslations = React.useCallback(
    async (
      text: string,
      ref: React.MutableRefObject<AbortController | null>,
      setEs: (v: string) => void,
      setZh: (v: string) => void,
      setBusy: (v: boolean) => void,
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      ref.current?.abort();
      const ctrl = new AbortController();
      ref.current = ctrl;
      setBusy(true);
      try {
        const { data, error } = await translateOnSave(trimmed, ['es', 'zh-CN'], ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (error || !data) {
          // Graceful degrade — leave override fields blank so user can
          // fill them in manually. notifyBackendError is too noisy for
          // an auto-fill best-effort.
          return;
        }
        const es = data.translations?.es;
        const zh = data.translations?.['zh-CN'];
        if (typeof es === 'string' && es.trim().length > 0) setEs(es);
        if (typeof zh === 'string' && zh.trim().length > 0) setZh(zh);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    },
    [],
  );

  const scheduleNewTranslate = (text: string) => {
    if (newTimerRef.current) clearTimeout(newTimerRef.current);
    newTimerRef.current = setTimeout(() => {
      fetchTranslations(text, newAbortRef, setNewEs, setNewZh, setNewTranslating);
    }, 600);
  };

  const handleNewBlur = () => {
    if (newTimerRef.current) clearTimeout(newTimerRef.current);
    fetchTranslations(newName, newAbortRef, setNewEs, setNewZh, setNewTranslating);
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    if (recipeCategories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      setWarning(T('section.recipes.categories.alreadyExists', { name }));
      return;
    }
    setWarning('');
    const i18n: LocalizedNames = {};
    if (newEs.trim()) i18n.es = newEs.trim();
    if (newZh.trim()) i18n['zh-CN'] = newZh.trim();
    addRecipeCategory(name, i18n);
    Toast.show({ type: 'success', text1: T('section.recipes.categories.added'), text2: name });
    setNewName('');
    setNewEs('');
    setNewZh('');
  };

  const startEdit = (cat: { name: string; i18nNames: LocalizedNames }) => {
    setEditingName(cat.name);
    setEditValue(cat.name);
    setEditI18n({ ...cat.i18nNames });
    setWarning('');
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditValue('');
    setEditI18n({});
  };

  const scheduleEditTranslate = (text: string) => {
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
    editTimerRef.current = setTimeout(() => {
      fetchTranslations(
        text,
        editAbortRef,
        (v) => setEditI18n((p) => ({ ...p, es: v })),
        (v) => setEditI18n((p) => ({ ...p, 'zh-CN': v })),
        setEditTranslating,
      );
    }, 600);
  };

  const handleEditBlur = () => {
    if (editTimerRef.current) clearTimeout(editTimerRef.current);
    fetchTranslations(
      editValue,
      editAbortRef,
      (v) => setEditI18n((p) => ({ ...p, es: v })),
      (v) => setEditI18n((p) => ({ ...p, 'zh-CN': v })),
      setEditTranslating,
    );
  };

  const saveEdit = (oldName: string) => {
    const next = editValue.trim();
    if (!next) return;
    if (
      next !== oldName &&
      recipeCategories.some((c) => c.name.toLowerCase() === next.toLowerCase())
    ) {
      setWarning(T('section.recipes.categories.alreadyExists', { name: next }));
      return;
    }
    setWarning('');
    const i18n: LocalizedNames = {};
    const es = (editI18n.es ?? '').trim();
    const zh = (editI18n['zh-CN'] ?? '').trim();
    if (es) i18n.es = es;
    if (zh) i18n['zh-CN'] = zh;
    if (next !== oldName) {
      updateRecipeCategory(oldName, next, i18n);
      Toast.show({
        type: 'success',
        text1: T('section.recipes.categories.renamed'),
        text2: `${oldName} → ${next}`,
      });
    } else {
      // Same name, just update translations.
      useStore.getState().setRecipeCategoryI18nNames(oldName, i18n);
      Toast.show({
        type: 'success',
        text1: T('section.recipes.categories.renamed'),
        text2: oldName,
      });
    }
    setEditingName(null);
    setEditValue('');
    setEditI18n({});
  };

  const handleDelete = (name: string) => {
    // Read from the sorted memo so the count source matches the displayed
    // column (AC #3 — single source of truth). Falls back to zero if the
    // row is missing for any reason (defensive — shouldn't happen).
    // Spec 048 / code-reviewer SF3 — `total` reads `row?.totalUsageCount`
    // directly rather than re-summing the split counts, so the displayed
    // column, the guard, and the toast all share a single source.
    const row = sorted.find((c) => c.name === name);
    const recipeUsageCount     = row?.recipeUsageCount     ?? 0;
    const prepRecipeUsageCount = row?.prepRecipeUsageCount ?? 0;
    const total                = row?.totalUsageCount      ?? 0;
    if (total > 0) {
      setWarning(
        T('section.recipes.categories.cannotDeleteInUse', {
          name,
          recipes: recipeUsageCount,
          preps: prepRecipeUsageCount,
        }),
      );
      Toast.show({
        type: 'error',
        text1: T('section.recipes.categories.inUseToast'),
        text2: T('section.recipes.categories.inUseToastBody', {
          name,
          recipes: recipeUsageCount,
          preps: prepRecipeUsageCount,
        }),
      });
      return; // no DELETE issued — block-on-use guard
    }
    confirmAction(
      T('section.recipes.categories.deleteConfirmTitle', { name }),
      T('section.recipes.categories.deleteConfirmBody'),
      () => {
        deleteRecipeCategory(name);
        Toast.show({
          type: 'success',
          text1: T('section.recipes.categories.deleted'),
          text2: name,
        });
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
      {/* Top bar */}
      <View
        style={{
          paddingHorizontal: 22, paddingTop: 14, paddingBottom: 10,
          borderBottomWidth: 1, borderBottomColor: C.border,
          flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
          backgroundColor: C.panel,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
          <Text style={[Type.h2, { color: C.fg }]}>
            {T('section.recipes.categories.title')}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {T('section.recipes.categories.active', { count: sorted.length })}
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            {T('section.recipes.categories.description')}
          </Text>
        </View>

        {/* Add new category card */}
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 }}>
          <SectionCaption tone="fg3" size={10.5}>
            {T('section.recipes.categories.newCategoryCaption')}
          </SectionCaption>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TextInput
              value={newName}
              onChangeText={(v) => { setNewName(v); scheduleNewTranslate(v); }}
              onBlur={handleNewBlur}
              placeholder={T('section.recipes.categories.namePlaceholder')}
              placeholderTextColor={C.fg3}
              onSubmitEditing={handleAdd}
              style={{
                flex: 1, height: 32, paddingHorizontal: 10,
                fontFamily: sans(500), fontSize: 13, color: C.fg,
                backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
            <TouchableOpacity
              onPress={handleAdd}
              disabled={!newName.trim()}
              accessibilityRole="button"
              accessibilityLabel={T('section.recipes.categories.newCategoryButton')}
              style={{
                paddingVertical: 7, paddingHorizontal: 14,
                backgroundColor: newName.trim() ? C.accent : C.panel2,
                borderRadius: CmdRadius.sm,
                opacity: newName.trim() ? 1 : 0.55,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: newName.trim() ? '#000' : C.fg3 }}>
                {T('section.recipes.categories.newCategoryButton')}
              </Text>
            </TouchableOpacity>
          </View>
          {newName.trim() ? (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>Español</Text>
                <TextInput
                  value={newEs}
                  onChangeText={setNewEs}
                  placeholder={newTranslating ? 'translating…' : '—'}
                  placeholderTextColor={C.fg3}
                  style={{
                    flex: 1, height: 28, paddingHorizontal: 8,
                    fontFamily: sans(500), fontSize: 12, color: C.fg,
                    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>中文 (简体)</Text>
                <TextInput
                  value={newZh}
                  onChangeText={setNewZh}
                  placeholder={newTranslating ? 'translating…' : '—'}
                  placeholderTextColor={C.fg3}
                  style={{
                    flex: 1, height: 28, paddingHorizontal: 8,
                    fontFamily: sans(500), fontSize: 12, color: C.fg,
                    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>
            </View>
          ) : null}
          {warning ? (
            <View style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: C.warnBg, borderWidth: 1, borderColor: C.warn, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.warn }}>{warning}</Text>
            </View>
          ) : null}
        </View>

        {/* Categories list */}
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>categories.tsv</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
              {T('section.recipes.categories.rowsCount', { count: sorted.length })}
            </Text>
          </View>
          {sorted.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.recipes.categories.emptyState')}
            </Text>
          ) : (
            sorted.map(({ name, totalUsageCount, label, i18nNames }, i) => {
              const isEditing = editingName === name;
              return (
                <View
                  key={name}
                  style={{
                    flexDirection: 'column', paddingVertical: 9, paddingHorizontal: 14, gap: 6,
                    borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {isEditing ? (
                      <TextInput
                        value={editValue}
                        onChangeText={(v) => { setEditValue(v); scheduleEditTranslate(v); }}
                        onBlur={handleEditBlur}
                        onSubmitEditing={() => saveEdit(name)}
                        autoFocus
                        style={{
                          flex: 1, height: 28, paddingHorizontal: 8,
                          fontFamily: sans(500), fontSize: 13, color: C.fg,
                          backgroundColor: C.panel2, borderWidth: 1, borderColor: C.accent, borderRadius: CmdRadius.sm,
                          ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                        }}
                      />
                    ) : (
                      <Text style={{ flex: 1, fontFamily: sans(600), fontSize: 13, color: C.fg }}>{label}</Text>
                    )}
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 100, textAlign: 'right' }}>
                      {T('section.recipes.categories.uses', { count: totalUsageCount })}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 6, width: 130, justifyContent: 'flex-end' }}>
                      {isEditing ? (
                        <>
                          <TouchableOpacity onPress={() => saveEdit(name)} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                            <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>
                              {T('section.recipes.categories.saveButton')}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={cancelEdit} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                            <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>
                              {T('section.recipes.categories.cancelButton')}
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <>
                          <TouchableOpacity
                            onPress={() => startEdit({ name, i18nNames: i18nNames || {} })}
                            style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
                          >
                            <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>
                              {T('section.recipes.categories.editButton')}
                            </Text>
                          </TouchableOpacity>
                          {/* DELETE is always enabled; the in-use check happens
                              inside `handleDelete` and surfaces a Toast +
                              inline warning if blocked. Keeping the button
                              clickable preserves the "why can't I delete?"
                              affordance, matching CategoriesSection. */}
                          <TouchableOpacity
                            onPress={() => handleDelete(name)}
                            style={{
                              paddingVertical: 4, paddingHorizontal: 10,
                              borderWidth: 1, borderColor: C.danger,
                              borderRadius: CmdRadius.sm,
                            }}
                          >
                            <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.danger }}>
                              {T('section.recipes.categories.deleteButton')}
                            </Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </View>
                  {isEditing ? (
                    <View style={{ gap: 4, paddingLeft: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>Español</Text>
                        <TextInput
                          value={editI18n.es ?? ''}
                          onChangeText={(v) => setEditI18n((p) => ({ ...p, es: v }))}
                          placeholder={editTranslating ? 'translating…' : '—'}
                          placeholderTextColor={C.fg3}
                          style={{
                            flex: 1, height: 26, paddingHorizontal: 8,
                            fontFamily: sans(500), fontSize: 12, color: C.fg,
                            backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text style={{ width: 90, fontFamily: mono(500), fontSize: 10.5, color: C.fg3 }}>中文 (简体)</Text>
                        <TextInput
                          value={editI18n['zh-CN'] ?? ''}
                          onChangeText={(v) => setEditI18n((p) => ({ ...p, 'zh-CN': v }))}
                          placeholder={editTranslating ? 'translating…' : '—'}
                          placeholderTextColor={C.fg3}
                          style={{
                            flex: 1, height: 26, paddingHorizontal: 8,
                            fontFamily: sans(500), fontSize: 12, color: C.fg,
                            backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm,
                            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}
