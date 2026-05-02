import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { MobileNavDrawer } from '../../components/cmd/MobileNavDrawer';
import { useCmdColors } from '../../theme/colors';
import { useStore } from '../../store/useStore';
import { useRole } from '../../hooks/useRole';
import { useCommandPaletteIndex } from '../../lib/cmdSelectors';
import { TreeItem } from '../../components/cmd/TreeGroup';
import { Text, View, TouchableOpacity } from 'react-native';
import { Type, mono, sans } from '../../theme/typography';

// Modal route presented from any screen when the hamburger is tapped.
// Wraps the MobileNavDrawer organism with navigation handlers — clicking a
// tree item navigates to the matching cmd-stack screen and closes itself.
export default function NavDrawerScreen() {
  const nav = useNavigation<any>();
  const C = useCmdColors();
  const role = useRole();
  const currentUser = useStore((s) => s.currentUser);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  const [paletteQuery, setPaletteQuery] = React.useState('');

  const close = React.useCallback(() => nav.goBack(), [nav]);

  const goAndClose = React.useCallback(
    (route: string, params?: Record<string, any>) => {
      close();
      // Defer the navigate by one tick so the modal pop animation reads cleanly
      setTimeout(() => nav.navigate(route, params), 0);
    },
    [close, nav],
  );

  // Tree IA — admin sees Operations + Planning + Insights. Staff sees Tasks +
  // Reference + a locked Admin-only group (handoff README §"Tree IA — admin").
  // For Phase 5 we use placeholder stubs for restricted items per G3.
  const groups: { label: string; items: TreeItem[] }[] = role === 'admin' ? [
    {
      label: 'Operations',
      items: [
        { id: 'Inventory',       label: 'Inventory',        kbd: '⌘I', onPress: () => goAndClose('Inventory') },
        { id: 'Dashboard',       label: 'Dashboard',        onPress: () => goAndClose('ComingSoon', { sectionName: 'Dashboard' }) },
        { id: 'EODCount',        label: 'EOD count',        onPress: () => goAndClose('ComingSoon', { sectionName: 'EOD count' }) },
        { id: 'WasteLog',        label: 'Waste log',        onPress: () => goAndClose('ComingSoon', { sectionName: 'Waste log' }) },
        { id: 'Receiving',       label: 'Receiving',        onPress: () => goAndClose('ComingSoon', { sectionName: 'Receiving' }) },
      ],
    },
    {
      label: 'Planning',
      items: [
        { id: 'PurchaseOrders',  label: 'Purchase orders',  onPress: () => goAndClose('ComingSoon', { sectionName: 'Purchase orders' }) },
        { id: 'Vendors',         label: 'Vendors',          onPress: () => goAndClose('ComingSoon', { sectionName: 'Vendors' }) },
        { id: 'Recipes',         label: 'Recipes',          onPress: () => goAndClose('ComingSoon', { sectionName: 'Recipes' }) },
        { id: 'Restock',         label: 'Restock',          onPress: () => goAndClose('ComingSoon', { sectionName: 'Restock' }) },
      ],
    },
    {
      label: 'Insights',
      items: [
        { id: 'Reconciliation',  label: 'Reconciliation',   onPress: () => goAndClose('ComingSoon', { sectionName: 'Reconciliation' }) },
        { id: 'POSImports',      label: 'POS imports',      onPress: () => goAndClose('ComingSoon', { sectionName: 'POS imports' }) },
        { id: 'AuditLog',        label: 'Audit log',        onPress: () => goAndClose('ComingSoon', { sectionName: 'Audit log' }) },
        { id: 'Reports',         label: 'Reports',          onPress: () => goAndClose('ComingSoon', { sectionName: 'Reports' }) },
      ],
    },
  ] : [
    {
      label: 'Tasks',
      items: [
        { id: 'Inventory',       label: 'Count queue',      kbd: '⌘I', onPress: () => goAndClose('Inventory') },
        { id: 'EODCount',        label: 'EOD count',        onPress: () => goAndClose('ComingSoon', { sectionName: 'EOD count' }) },
        { id: 'WasteLog',        label: 'Waste log',        onPress: () => goAndClose('ComingSoon', { sectionName: 'Waste log' }) },
      ],
    },
    {
      label: 'Reference',
      items: [
        { id: 'Recipes',         label: 'Recipes',          onPress: () => goAndClose('ComingSoon', { sectionName: 'Recipes' }) },
      ],
    },
    {
      label: 'Admin-only',
      items: [
        { id: 'Vendors',         label: 'Vendors',          restricted: true },
        { id: 'Reports',         label: 'Reports',          restricted: true },
        { id: 'AuditLog',        label: 'Audit log',        restricted: true },
        { id: 'Reconciliation',  label: 'Reconciliation',   restricted: true },
      ],
    },
  ];

  // EOD progress for footer: count distinct stores that submitted today.
  const todayStr = new Date().toISOString().slice(0, 10);
  const submittedToday = new Set(
    eodSubmissions.filter((s) => s.date === todayStr).map((s) => s.storeId),
  ).size;
  const totalStores = stores.length;

  // Palette index — for Phase 5 we just feed the matches list back as DOM.
  // Phase 7 will wire ⌘K globally; for now the drawer's own field is the
  // palette entry on mobile.
  const index = useCommandPaletteIndex(role);
  const matches = React.useMemo(() => {
    if (!paletteQuery.trim()) return [];
    const q = paletteQuery.toLowerCase();
    return index
      .filter((e) => e.label.toLowerCase().includes(q))
      .slice(0, 5);
  }, [paletteQuery, index]);

  const paletteResults = matches.length > 0 ? (
    <View style={{ gap: 4 }}>
      {matches.map((m) => (
        <TouchableOpacity
          key={`${m.type}:${m.id}`}
          activeOpacity={0.85}
          onPress={() => {
            close();
            setTimeout(() => {
              if (m.route.name === 'ItemDetail') {
                nav.navigate('ItemDetail', m.route.params);
              } else if (m.route.name === 'Inventory') {
                nav.navigate('Inventory');
              } else {
                nav.navigate('ComingSoon', { sectionName: m.label });
              }
            }, 0);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, width: 56, textTransform: 'uppercase' }}>
            {m.type}
          </Text>
          <Text style={{ fontFamily: sans(500), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
            {m.label}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {m.id.slice(0, 8)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  ) : null;

  // Selected item — derived from current route name. Falls back to "Inventory"
  // since that's the default landing screen.
  const [selectedId, setSelectedId] = React.useState('Inventory');

  return (
    <MobileNavDrawer
      visible
      onClose={close}
      groups={groups}
      selectedId={selectedId}
      onSelect={setSelectedId}
      paletteQuery={paletteQuery}
      onPaletteChange={setPaletteQuery}
      paletteResults={paletteResults}
      role={role}
      subtitle={`${currentUser?.email || 'guest'} · v2.4`}
      footerLeft={<Text style={[Type.statusBar, { color: C.fg3 }]}>● {currentUser?.email || 'guest'}</Text>}
      footerRight={
        <Text style={[Type.statusBar, { color: C.fg3 }]}>
          EOD {submittedToday}/{totalStores}
        </Text>
      }
    />
  );
}
