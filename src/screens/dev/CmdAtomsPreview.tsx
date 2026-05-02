import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { Type, sans, mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { StatusDot } from '../../components/cmd/StatusDot';
import { StatusPill } from '../../components/cmd/StatusPill';
import { KbdHint } from '../../components/cmd/KbdHint';
import { RoleBadge } from '../../components/cmd/RoleBadge';
import { ParBar } from '../../components/cmd/ParBar';
import { AccentTile } from '../../components/cmd/AccentTile';
import { Avatar } from '../../components/cmd/Avatar';
import { SectionCaption } from '../../components/cmd/SectionCaption';

// Phase 2 dev sandbox. Mounted from App.tsx when EXPO_PUBLIC_NEW_UI=true && __DEV__.
// Phase 5 will move this into CmdNavigator as a hidden dev route.
export default function CmdAtomsPreview() {
  const C = useCmdColors();
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Top bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          height: 36,
          backgroundColor: C.panel,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <SectionCaption size={10.5}>CMD atoms — phase 2 preview</SectionCaption>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={toggleDarkMode}
          testID="cmd-preview-toggle-theme"
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.borderStrong,
            backgroundColor: C.panel2,
          }}
        >
          <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.fg2 }}>
            {darkMode ? '☼ light' : '☾ dark'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, gap: 22 }}>
        <Group title="StatusDot">
          <Row>
            <Labeled label="ok"><StatusDot status="ok" /></Labeled>
            <Labeled label="low"><StatusDot status="low" /></Labeled>
            <Labeled label="out"><StatusDot status="out" /></Labeled>
            <Labeled label="info"><StatusDot status="info" /></Labeled>
            <Labeled label="size 7"><StatusDot status="ok" size={7} /></Labeled>
          </Row>
        </Group>

        <Group title="StatusPill">
          <Row>
            <StatusPill status="ok" />
            <StatusPill status="low" />
            <StatusPill status="out" />
            <StatusPill status="info" />
            <StatusPill status="low" label="LOW · 4.2/12" />
          </Row>
        </Group>

        <Group title="KbdHint">
          <Row>
            <KbdHint>⌘K</KbdHint>
            <KbdHint>⌘P</KbdHint>
            <KbdHint>esc</KbdHint>
            <KbdHint>⌘I</KbdHint>
            <KbdHint size="sm">⏎</KbdHint>
          </Row>
        </Group>

        <Group title="RoleBadge">
          <Row>
            <RoleBadge role="admin" />
            <RoleBadge role="staff" />
          </Row>
        </Group>

        <Group title="ParBar">
          <View style={{ gap: 8, width: 220 }}>
            <Labeled label="20 / 18 (ok)"><ParBar stock={20} par={18} /></Labeled>
            <Labeled label="12.4 / 18 (low)"><ParBar stock={12.4} par={18} /></Labeled>
            <Labeled label="4.2 / 12 (low)"><ParBar stock={4.2} par={12} /></Labeled>
            <Labeled label="0 / 8 (out)"><ParBar stock={0} par={8} /></Labeled>
            <Labeled label="par=0 (no par)"><ParBar stock={5} par={0} /></Labeled>
          </View>
        </Group>

        <Group title="AccentTile">
          <Row>
            <Labeled label="22"><AccentTile glyph="i" size={22} /></Labeled>
            <Labeled label="26"><AccentTile glyph="i" size={26} /></Labeled>
            <Labeled label="32"><AccentTile glyph="i" size={32} /></Labeled>
          </Row>
        </Group>

        <Group title="Avatar">
          <Row>
            <Labeled label="MG"><Avatar initials="MG" /></Labeled>
            <Labeled label="JT"><Avatar initials="JT" /></Labeled>
            <Labeled label="AR"><Avatar initials="AR" /></Labeled>
            <Labeled label="size 24"><Avatar initials="AD" size={24} /></Labeled>
          </Row>
        </Group>

        <Group title="SectionCaption">
          <View style={{ gap: 6 }}>
            <SectionCaption tone="fg3">stock_history.dat — 14d</SectionCaption>
            <SectionCaption tone="fg3" size={9.5}>operations</SectionCaption>
            <SectionCaption tone="fg2" size={10.5}>used in 4 recipes</SectionCaption>
          </View>
        </Group>

        <Group title="Type ramp (sanity)">
          <View style={{ gap: 6 }}>
            <Text style={[Type.display, { color: C.fg }]}>Atlantic salmon</Text>
            <Text style={[Type.h1, { color: C.fg }]}>Inventory</Text>
            <Text style={[Type.h2, { color: C.fg }]}>Inventory · 12 items</Text>
            <Text style={[Type.body, { color: C.fg }]}>Body 13/400 — Inter Tight regular.</Text>
            <Text style={[Type.bodySm, { color: C.fg2 }]}>Body small 12/400 — Inter Tight.</Text>
            <Text style={[Type.kpiValueDesktop, { color: C.fg }]}>4.2 lb</Text>
            <Text style={[Type.kpiLabelDesktop, { color: C.fg3 }]}>on hand</Text>
            <Text style={[Type.tableNum, { color: C.fg }]}>14.0 / 10  lb</Text>
            <Text style={[Type.breadcrumb, { color: C.fg3 }]}>inv://towson — inventory — atlantic-salmon</Text>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>● synced  row 3 / 142  cat:seafood</Text>
          </View>
        </Group>
      </ScrollView>
    </View>
  );
}

// ── Internal layout helpers ────────────────────────────────
const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        padding: 14,
        gap: 12,
      }}
    >
      <Text style={[Type.caption, { color: C.fg3 }]}>{title}</Text>
      {children}
    </View>
  );
};

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
    {children}
  </View>
);

const Labeled: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const C = useCmdColors();
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      {children}
      <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>{label}</Text>
    </View>
  );
};
