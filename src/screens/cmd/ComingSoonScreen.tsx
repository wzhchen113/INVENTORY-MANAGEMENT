import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useRole } from '../../hooks/useRole';
import { TitleBar } from '../../components/cmd/TitleBar';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { RoleBadge } from '../../components/cmd/RoleBadge';
import { SectionCaption } from '../../components/cmd/SectionCaption';
import { StatusDot } from '../../components/cmd/StatusDot';

interface RouteParams {
  /** Display name of the section, e.g. "Dashboard", "EOD count". */
  sectionName?: string;
  /** Slug used in the breadcrumb. Auto-generated from sectionName if omitted. */
  sectionSlug?: string;
  /** Optional override copy beneath the headline. */
  estimatedHandoff?: string;
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');

// Placeholder for the 12 non-Inventory tree items per G3 (Plan A direction).
// Renders the new chrome (TitleBar on web, mobile header on native) so the
// aesthetic stays consistent end-to-end. Users who need legacy functionality
// flip NEW_UI=false in .env.local.
export default function ComingSoonScreen() {
  const C = useCmdColors();
  const role = useRole();
  const currentStore = useStore((s) => s.currentStore);
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const params = (route.params || {}) as RouteParams;
  const sectionName = params.sectionName || 'Section';
  const estimatedHandoff = params.estimatedHandoff;
  const slug = params.sectionSlug ?? slugify(sectionName);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {Platform.OS === 'web' ? (
        <TitleBar storeName={currentStore?.name || 'store'} section={sectionName} />
      ) : (
        <View
          style={{
            paddingTop: 54,
            paddingHorizontal: 16,
            paddingBottom: 10,
            backgroundColor: C.panel,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TouchableOpacity
              onPress={() => nav.navigate('Drawer')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>☰</Text>
            </TouchableOpacity>
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontFamily: mono(400), fontSize: 11, color: C.fg3 }}
            >
              inv://{slugify(currentStore?.name || 'store')} — {slug}
            </Text>
            <RoleBadge role={role} />
          </View>
          <Text style={{ fontFamily: sans(700), fontSize: 24, color: C.fg, letterSpacing: -0.4 }}>
            {sectionName}
          </Text>
        </View>
      )}

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            padding: 22,
            gap: 10,
            maxWidth: 380,
            alignItems: 'flex-start',
          }}
        >
          <SectionCaption tone="fg3">status</SectionCaption>
          <Text style={{ fontFamily: mono(600), fontSize: 20, color: C.fg2, letterSpacing: -0.3 }}>
            awaiting design handoff
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            section: {slug}
          </Text>
          {estimatedHandoff ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, marginTop: 4 }}>
              eta: {estimatedHandoff}
            </Text>
          ) : null}
        </View>
      </View>

      <CmdStatusBar
        height={32}
        bottomInset={Platform.OS === 'web' ? 0 : 28}
        left={
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusDot status="info" />
              <Text style={[Type.statusBar, { color: C.fg3 }]}>placeholder</Text>
            </View>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>section: {slug}</Text>
          </>
        }
        right={<Text style={[Type.statusBar, { color: C.fg3 }]}>NEW_UI=true</Text>}
      />
    </View>
  );
}
