import React from 'react';
import { View, Text, Platform } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { supabase } from '../../lib/supabase';

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
export const TitleBar: React.FC<Props> = ({ storeName, section, itemSlug }) => {
  const C = useCmdColors();
  if (Platform.OS !== 'web') return null;

  const breadcrumb = [
    `inv://${slugify(storeName)}`,
    section.toLowerCase(),
    itemSlug ? slugify(itemSlug) : null,
  ]
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
      {/* Breadcrumb (centered) */}
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text
          style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}
          numberOfLines={1}
        >
          {breadcrumb}
        </Text>
      </View>
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
