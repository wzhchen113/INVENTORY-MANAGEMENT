import React from 'react';
import { View, Text, TouchableOpacity, Platform, Modal, FlatList } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useIsSuperAdmin } from '../../hooks/useRole';
import { usePaletteAction } from '../../lib/paletteAction';
import { useIsPhone } from '../../theme/breakpoints';

interface Props {
  /** Phone-friendly compact mode: 2-letter brand prefix + chevron, opens
   *  a full-screen modal. Desktop / tablet: full brand name + chevron,
   *  opens a portaled dropdown. */
  compact?: boolean;
}

const initials2 = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return '··';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
};

// Spec 012b §2 — header brand picker. Visible only for super-admin
// (callers should still gate render via useIsSuperAdmin to avoid the
// hook firing unnecessarily). The current label is resolved by looking
// up `currentBrandId` in the brands list, falling back to "All brands"
// when null.
//
// Compact mode (phone) renders a 2-letter prefix + chevron (~40px wide)
// and opens a full-screen Modal listing brands. Desktop/tablet uses an
// inline portaled dropdown via document.body — same idiom as TitleBar's
// store-switcher.
export const BrandPicker: React.FC<Props> = ({ compact }) => {
  const C = useCmdColors();
  const isSuperAdmin = useIsSuperAdmin();
  const isPhone = useIsPhone();
  const brandsList = useStore((s) => s.brandsList);
  const currentBrandId = useStore((s) => s.currentBrandId);
  const setCurrentBrandId = useStore((s) => s.setCurrentBrandId);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  const [open, setOpen] = React.useState(false);

  // Defensive — also re-fetch when opened in case login race left an
  // empty list. Cheap (single SELECT, RLS-gated to super-admin).
  React.useEffect(() => {
    if (open && brandsList.length === 0) {
      loadBrandsList().catch(() => { /* logged inside */ });
    }
  }, [open, brandsList.length, loadBrandsList]);

  if (!isSuperAdmin) return null;

  const current = currentBrandId
    ? brandsList.find((b) => b.id === currentBrandId)
    : null;
  const label = current ? current.name : 'All brands';
  const compactLabel = current ? initials2(current.name) : 'AB';

  const handlePick = (brandId: string | null) => {
    setCurrentBrandId(brandId);
    setOpen(false);
    if (brandId === null) {
      // Force section to "Brands" on "All brands" — paletteAction is the
      // shell-decoupled bridge for cross-tree section swaps.
      usePaletteAction.getState().request({ section: 'Brands', selectedName: null });
    }
  };

  // Phone compact trigger
  if (compact) {
    return (
      <>
        <TouchableOpacity
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Switch brand (current: ${label})`}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.borderStrong,
            backgroundColor: open ? C.panel2 : 'transparent',
            minHeight: 24,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg }}>{compactLabel}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>▾</Text>
        </TouchableOpacity>

        {/* Phone full-screen brand list. Reuses RN Modal — keeps native
            parity with the spec 011 ResponsiveSheet idiom for mobile. */}
        <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)} transparent={false}>
          <View style={{ flex: 1, backgroundColor: C.bg }}>
            <View
              style={{
                paddingTop: 54,
                paddingHorizontal: 16,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Text style={[Type.h2, { color: C.fg, flex: 1 }]}>Switch brand</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
                <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={[{ id: '__all_brands__' as const, name: 'All brands' }, ...brandsList.map((b) => ({ id: b.id, name: b.name }))]}
              keyExtractor={(b) => b.id}
              renderItem={({ item }) => {
                // Cleanup #10 — local FlatList sentinel renamed from
                // '__all__' to avoid visual collision with useStore's
                // setCurrentStore '__all__' (different scope, but easier
                // for future readers to scan).
                const isAll = item.id === '__all_brands__';
                const isCurrent = isAll ? currentBrandId === null : item.id === currentBrandId;
                return (
                  <TouchableOpacity
                    onPress={() => handlePick(isAll ? null : item.id)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                      borderBottomWidth: 1,
                      borderBottomColor: C.border,
                      backgroundColor: isCurrent ? C.accentBg : 'transparent',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 11,
                        color: isCurrent ? C.accent : C.fg3,
                        width: 28,
                      }}
                    >
                      {isAll ? 'AB' : initials2(item.name)}
                    </Text>
                    <Text
                      style={{
                        fontFamily: sans(isCurrent ? 600 : 400),
                        fontSize: 14,
                        color: isCurrent ? C.accent : C.fg,
                        flex: 1,
                      }}
                    >
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <View style={{ padding: 22 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
                    no brands yet
                  </Text>
                </View>
              }
            />
          </View>
        </Modal>
      </>
    );
  }

  // Desktop / tablet trigger — full label + chevron, dropdown via portal.
  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="Switch brand"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.borderStrong,
          backgroundColor: open ? C.panel2 : 'transparent',
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent, letterSpacing: 0.5 }}>BRAND</Text>
        <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }} numberOfLines={1}>
          {label}
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>▾</Text>
      </TouchableOpacity>

      {open ? (
        Platform.OS === 'web' ? (
          <BrandPickerDropdownWeb
            brands={brandsList}
            currentBrandId={currentBrandId}
            onPick={handlePick}
            onClose={() => setOpen(false)}
          />
        ) : null
      ) : null}
    </>
  );
};

// ─── Web-only portaled dropdown ─────────────────────────────────────
// Mirrors the pattern in TitleBar.tsx — render via createPortal so the
// chrome's overflow:hidden ancestors don't trap the menu. Web-only:
// guarded at the call site by Platform.OS check.
function BrandPickerDropdownWeb({
  brands, currentBrandId, onPick, onClose,
}: {
  brands: { id: string; name: string }[];
  currentBrandId: string | null;
  onPick: (brandId: string | null) => void;
  onClose: () => void;
}) {
  const C = useCmdColors();
  // Lazy-require react-dom on web. We can't import it statically here
  // because the import would resolve on native builds too (RN bundlers
  // don't always tree-shake top-level imports the way the web bundler does).
  const createPortal = React.useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('react-dom').createPortal as typeof import('react-dom').createPortal;
    } catch {
      return null;
    }
  }, []);
  if (!createPortal || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 999,
          background: 'transparent',
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 36,
          right: 16,
          minWidth: 240,
          maxHeight: 360,
          overflowY: 'auto',
          backgroundColor: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: CmdRadius.sm,
          paddingTop: 4,
          paddingBottom: 4,
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        }}
      >
        {/* "All brands" sentinel at top */}
        <DropdownRow
          label="All brands"
          glyph="AB"
          isCurrent={currentBrandId === null}
          onPress={() => onPick(null)}
        />
        <div style={{ height: 1, background: C.border, margin: '4px 0' }} />
        {brands.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingHorizontal: 12, paddingVertical: 6 }}>
            no brands yet
          </Text>
        ) : (
          brands.map((b) => (
            <DropdownRow
              key={b.id}
              label={b.name}
              glyph={initials2(b.name)}
              isCurrent={b.id === currentBrandId}
              onPress={() => onPick(b.id)}
            />
          ))
        )}
      </div>
    </>,
    document.body,
  );
}

function DropdownRow({
  label, glyph, isCurrent, onPress,
}: {
  label: string;
  glyph: string;
  isCurrent: boolean;
  onPress: () => void;
}) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: isCurrent ? C.accentBg : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          color: isCurrent ? C.accent : C.fg3,
          letterSpacing: 0.5,
          width: 22,
        }}
      >
        {glyph}
      </Text>
      <Text
        style={{
          fontFamily: mono(isCurrent ? 500 : 400),
          fontSize: 11,
          color: isCurrent ? C.accent : C.fg2,
          flex: 1,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
