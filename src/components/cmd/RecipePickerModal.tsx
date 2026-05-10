import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';

// Spec 015 §8 — shared centered-overlay recipe picker. Used by:
//   1. BreadbotPreviewCard per-row pill (allowNoMatch: true)
//   2. MappingTab unmapped row → upsert alias + retroactive flip
//   3. MappingTab confirmed row edit → upsert alias to a different recipe
//
// Reads `recipes` from the store internally so call sites don't pass the
// list. Mirrors FetchBreadbotModal / RunImportModal shape: backdrop tap +
// Escape-to-close (web) + explicit Cancel button. Empty render returns
// null when `visible === false` to avoid mounting Modal at all.
export interface RecipePickerModalProps {
  /** Modal visibility. Caller toggles. */
  visible: boolean;
  /** Closed without picking. Caller should clear any "picker open for row
   *  X" state. Backdrop tap, Escape (web), Cancel button. */
  onClose: () => void;
  /** POS string shown at the top of the modal. Read-only. */
  posName: string;
  /** Currently-bound recipe id, if any. Drives the active-row highlight.
   *  Used by Surface 1 overrides and Surface 2 edit. */
  currentRecipeId?: string | null;
  /** When true, render a "— No match (skip this item) —" entry at the top
   *  of the list. Picking it fires `onPick(null)`. Used by Surface 1 only;
   *  on Surface 2 the user just closes the modal to "leave it unmapped". */
  allowNoMatch?: boolean;
  /** User picked. recipeId === null only when allowNoMatch is true AND
   *  the user picked the "No match" entry. Caller is responsible for
   *  closing the modal — the modal does NOT auto-close on pick (so the
   *  caller can run side-effects first if it wants to). The spec uses
   *  the close-immediately-then-fire-async pattern, so callers typically
   *  call onClose() right after onPick. */
  onPick: (recipeId: string | null) => void;
}

export const RecipePickerModal: React.FC<RecipePickerModalProps> = ({
  visible,
  onClose,
  posName,
  currentRecipeId,
  allowNoMatch,
  onPick,
}) => {
  const C = useCmdColors();
  const recipes = useStore((s) => s.recipes);
  const [search, setSearch] = React.useState('');

  // Reset search when the modal closes so the next open starts clean.
  React.useEffect(() => {
    if (!visible) setSearch('');
  }, [visible]);

  // Escape-to-close (web only). Mirrors FetchBreadbotModal:112-122.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipes
      .filter((r) => !q || r.menuItem.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.menuItem.toLowerCase().localeCompare(b.menuItem.toLowerCase()));
  }, [recipes, search]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.40)',
          alignItems: 'center',
          paddingTop: '7%',
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            width: 560,
            maxWidth: '92%',
            maxHeight: '80%',
            backgroundColor: C.bg,
            borderWidth: 1,
            borderColor: C.borderStrong,
            borderRadius: 8,
            overflow: 'hidden',
            ...(Platform.OS === 'web'
              ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any)
              : {}),
          }}
        >
          {/* Header */}
          <View
            style={{
              height: 44,
              paddingHorizontal: 18,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: C.panel,
            }}
          >
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.fg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.bg }}>POS</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg, flex: 1 }} numberOfLines={1}>
              {posName}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          {/* Sub-header lead text */}
          <View
            style={{
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              backgroundColor: C.panel,
            }}
          >
            <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2 }}>
              Pick a recipe to map this POS string to. Future imports auto-match.
            </Text>
          </View>

          {/* Search */}
          <View
            style={{
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              backgroundColor: C.panel,
            }}
          >
            <TextInput
              testID="posimport-cmd-picker-search"
              value={search}
              onChangeText={setSearch}
              placeholder="search recipes…"
              placeholderTextColor={C.fg3}
              autoFocus={Platform.OS === 'web'}
              style={{
                fontFamily: mono(400),
                fontSize: 12.5,
                color: C.fg,
                // Cmd palette equivalents of spec's bgSecondary/borderMedium —
                // panel2 + borderStrong land in the same visual register on
                // both light and dark Cmd palettes.
                backgroundColor: C.panel2,
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: CmdRadius.sm,
                paddingHorizontal: 10,
                paddingVertical: 8,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
          </View>

          {/* List */}
          <ScrollView style={{ maxHeight: 400 }}>
            {allowNoMatch ? (
              <TouchableOpacity
                testID="posimport-cmd-picker-none"
                onPress={() => onPick(null)}
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: 18,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderStyle: 'dashed',
                  backgroundColor: currentRecipeId === null ? C.dangerBg : 'transparent',
                }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.danger }}>
                  — No match (skip this item) —
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }}>
                  records the row but skips depletion
                </Text>
              </TouchableOpacity>
            ) : null}
            {filtered.length === 0 ? (
              <View style={{ paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                  no recipes match "{search.trim()}"
                </Text>
              </View>
            ) : (
              filtered.map((r, idx) => {
                const active = currentRecipeId === r.id;
                return (
                  <TouchableOpacity
                    key={r.id}
                    testID={`posimport-cmd-picker-recipe-${r.id}`}
                    onPress={() => onPick(r.id)}
                    style={{
                      paddingVertical: 9,
                      paddingHorizontal: 18,
                      borderBottomWidth: idx === filtered.length - 1 ? 0 : 1,
                      borderBottomColor: C.border,
                      borderStyle: 'dashed',
                      backgroundColor: active ? C.accentBg : 'transparent',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                        {r.menuItem}
                      </Text>
                      {r.sellPrice > 0 ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>
                          ${r.sellPrice.toFixed(2)}
                        </Text>
                      ) : null}
                    </View>
                    {active ? (
                      <View
                        style={{
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: 3,
                          borderWidth: 1,
                          borderColor: C.accent,
                          backgroundColor: 'transparent',
                        }}
                      >
                        <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.accent, letterSpacing: 0.4 }}>
                          CURRENT
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>

          {/* Footer */}
          <View
            style={{
              height: 54,
              paddingHorizontal: 18,
              borderTopWidth: 1,
              borderTopColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: C.panel,
            }}
          >
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, flex: 1 }} numberOfLines={1}>
              {filtered.length} recipe{filtered.length === 1 ? '' : 's'}
            </Text>
            <TouchableOpacity
              testID="posimport-cmd-picker-cancel"
              onPress={onClose}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL  esc</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
