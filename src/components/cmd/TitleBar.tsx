import React from 'react';
import { View, Text, Platform, TouchableOpacity, Pressable } from 'react-native';
import { createPortal } from 'react-dom';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { supabase } from '../../lib/supabase';
import { useStore } from '../../store/useStore';

interface Props {
  storeName: string;
  section: string;
  itemSlug?: string;
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');

// Per design: web-only desktop top bar 32px. Three macOS traffic lights
// (cosmetic only — do NOT wire to window controls), centered breadcrumb,
// connection indicator on the right reading directly from supabase.realtime
// channel state (per G4 — no separate hook).
//
// The `inv://<slug>` segment of the breadcrumb is a store switcher: click
// to drop a menu of stores the user has access to (admin/master see all,
// regular users see their user_stores grants). Picking one calls
// setCurrentStore.
export const TitleBar: React.FC<Props> = ({ storeName, section, itemSlug }) => {
  const C = useCmdColors();
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const setCurrentStore = useStore((s) => s.setCurrentStore);
  const [storeMenuOpen, setStoreMenuOpen] = React.useState(false);

  if (Platform.OS !== 'web') return null;

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const accessibleStores = isAdmin
    ? stores
    : stores.filter((s) => currentUser?.stores?.includes(s.id));

  const tail = [section.toLowerCase(), itemSlug ? slugify(itemSlug) : null]
    .filter(Boolean)
    .join(' — ');

  const [connected, setConnected] = React.useState<boolean>(true);
  React.useEffect(() => {
    const tick = () => {
      const channels: any[] = (supabase as any).realtime?.channels || [];
      // 'joined' or 'subscribed' are healthy states; default optimistic if no
      // channels yet (e.g. before any subscription is created).
      if (channels.length === 0) {
        setConnected(true);
        return;
      }
      setConnected(channels.some((c) => c.state === 'joined' || c.state === 'subscribed'));
    };
    const id = setInterval(tick, 2000);
    tick();
    return () => clearInterval(id);
  }, []);

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
      }}
    >
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
            accessibilityLabel="Switch store"
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
              inv://{slugify(storeName)}
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
                    no accessible stores
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
                          inv://{slugify(s.name)}
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
          {connected ? 'connected' : 'reconnecting'}
        </Text>
      </View>
    </View>
  );
};
