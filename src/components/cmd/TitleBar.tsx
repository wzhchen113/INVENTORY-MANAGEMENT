import React from 'react';
import { View, Text, Platform, TouchableOpacity, Pressable } from 'react-native';
import { createPortal } from 'react-dom';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { ThemeToggle } from './ThemeToggle';
import { LoadingBar } from './LoadingBar';

interface Props {
  storeName: string;
  section: string;
  itemSlug?: string;
  /** Spec 012b — optional super-admin brand picker rendered between the
   *  breadcrumb and the connection indicator. The shell passes the
   *  BrandPicker only when useIsSuperAdmin() === true; non-super-admin
   *  users see the same chrome as before (slot is null). */
  brandPicker?: React.ReactNode;
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');

// Per design: web-only desktop top bar 32px. Three macOS traffic lights
// (cosmetic only — do NOT wire to window controls), centered breadcrumb,
// connection indicator on the right reading from `useConnectionStatus`
// (spec 057 — formerly inlined here, extracted to honor the
// no-`lib/supabase`-imports-in-components convention).
//
// The `inv://<slug>` segment of the breadcrumb is a store switcher: click
// to drop a menu of stores the user has access to (admin/master see all,
// regular users see their user_stores grants). Picking one calls
// setCurrentStore.
export const TitleBar: React.FC<Props> = ({ storeName, section, itemSlug, brandPicker }) => {
  const C = useCmdColors();
  const T = useT();
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const currentBrandId = useStore((s) => s.currentBrandId);
  const brand = useStore((s) => s.brand);
  const brandsList = useStore((s) => s.brandsList);
  const setCurrentStore = useStore((s) => s.setCurrentStore);
  const [storeMenuOpen, setStoreMenuOpen] = React.useState(false);

  // brand-id → display name lookup. brandsList is populated for super-admins
  // (covers every brand); for regular admins/masters only `brand` is set
  // (their single brand). Merge both so the store-picker prefix renders the
  // right initials regardless of role.
  const brandNameByBrandId = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of brandsList) m[b.id] = b.name;
    if (brand?.id && brand?.name) m[brand.id] = brand.name;
    return m;
  }, [brand, brandsList]);

  // "2AM PROJECT" → "2P", "BALTIMORE SEAFOOD" → "BS". Single-word brand
  // names collapse to a single initial. Empty / missing → fall back to
  // the legacy `inv` prefix so nothing breaks during first-paint before
  // the brand slice loads.
  const brandPrefix = React.useCallback((brandId: string | null | undefined): string => {
    if (!brandId) return 'inv';
    const name = brandNameByBrandId[brandId];
    if (!name) return 'inv';
    const initials = name.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('');
    return initials || 'inv';
  }, [brandNameByBrandId]);

  // Spec 057 — connection-indicator hook. MUST be called BEFORE the
  // `Platform.OS !== 'web'` early return below, otherwise React's
  // Rules-of-Hooks invariant (same call order every render) breaks if a
  // future code path renders this component on native. The hook
  // self-gates its `setInterval` side-effect on platform, so the poller
  // never starts on native and the optimistic `useState(true)` default
  // is the only value seen there.
  const connected = useConnectionStatus();

  if (Platform.OS !== 'web') return null;

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master' || currentUser?.role === 'super_admin';
  // First filter by per-user access, then narrow to the active brand if
  // one is selected. Super-admins set currentBrandId via the brand
  // picker; clearing it (null) means "All brands" so the brand filter
  // is skipped.
  const accessibleStores = (isAdmin
    ? stores
    : stores.filter((s) => currentUser?.stores?.includes(s.id))
  ).filter((s) => currentBrandId === null || s.brandId === currentBrandId);

  const tail = [section.toLowerCase(), itemSlug ? slugify(itemSlug) : null]
    .filter(Boolean)
    .join(' — ');

  return (
    <View
      style={{
        height: 32,
        backgroundColor: C.panel,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        gap: 12,
        // `position: 'relative'` is the anchor for the LoadingBar overlay
        // below — absolute positioning needs a positioned ancestor or it
        // climbs to the document body.
        position: 'relative',
      }}
    >
      {/* Spec 055 — global in-flight indicator. Renders only when a
          db.ts call is active; web-only (bails on native). Mounted as
          the first child so its absolute positioning is unambiguous. */}
      <LoadingBar />
      {/* Traffic lights — cosmetic */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <View style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: '#FF5F57' }} />
        <View style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: '#FEBC2E' }} />
        <View style={{ width: 11, height: 11, borderRadius: 99, backgroundColor: '#28C840' }} />
      </View>
      {/* Breadcrumb (centered) — store slug is a clickable switcher */}
      <View style={{ flex: 1, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => setStoreMenuOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={T('chrome.switchStoreAria')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.borderStrong,
              backgroundColor: storeMenuOpen ? C.panel2 : 'transparent',
            }}
          >
            <Text
              style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }}
              numberOfLines={1}
            >
              {brandPrefix(currentStore?.brandId)}://{slugify(storeName)}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>▾</Text>
          </TouchableOpacity>
          {tail ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }} numberOfLines={1}>
              {' — '}{tail}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Dropdown menu — portaled to document.body so the TitleBar's
          clipping ancestors (overflow: hidden on the layout wrapper)
          don't trap it. Web-only: react-dom is safe to import here
          because the component bails early on non-web platforms. */}
      {storeMenuOpen
        ? createPortal(
            <>
              {/* Backdrop — click outside to close */}
              <div
                onClick={() => setStoreMenuOpen(false)}
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 999,
                  background: 'transparent',
                }}
              />
              <div
                style={{
                  position: 'fixed',
                  top: 36,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  minWidth: 220,
                  backgroundColor: C.panel,
                  border: `1px solid ${C.border}`,
                  borderRadius: CmdRadius.sm,
                  paddingTop: 4,
                  paddingBottom: 4,
                  zIndex: 1000,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                }}
              >
                {accessibleStores.length === 0 ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingHorizontal: 12, paddingVertical: 6 }}>
                    {T('common.noResults')}
                  </Text>
                ) : (
                  accessibleStores.map((s) => {
                    const isCurrent = s.id === currentStore?.id;
                    return (
                      <TouchableOpacity
                        key={s.id}
                        onPress={() => {
                          if (!isCurrent) setCurrentStore(s);
                          setStoreMenuOpen(false);
                        }}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          backgroundColor: isCurrent ? C.accentBg : 'transparent',
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: mono(isCurrent ? 500 : 400),
                            fontSize: 11,
                            color: isCurrent ? C.accent : C.fg2,
                          }}
                        >
                          {brandPrefix(s.brandId)}://{slugify(s.name)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </div>
            </>,
            document.body,
          )
        : null}
      {/* Spec 012b — brand picker slot (super-admin only, gated upstream) */}
      {brandPicker ? <View>{brandPicker}</View> : null}
      {/* Theme toggle — always visible, sits next to the brand picker. */}
      <ThemeToggle />
      {/* Connection indicator */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: connected ? C.ok : C.warn,
          }}
        />
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
          {connected ? T('chrome.connected') : T('chrome.reconnecting')}
        </Text>
      </View>
    </View>
  );
};
