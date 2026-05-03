import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { MobileNavDrawer } from '../../components/cmd/MobileNavDrawer';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { useStore } from '../../store/useStore';
import { useCommandPaletteIndex } from '../../lib/cmdSelectors';
import { TreeItem } from '../../components/cmd/TreeGroup';
import { Text, View, TouchableOpacity } from 'react-native';
import { Type, mono, sans } from '../../theme/typography';
import { ThemeToggle } from '../../components/cmd/ThemeToggle';

// Modal route presented from any screen when the hamburger is tapped.
// Wraps the MobileNavDrawer organism with navigation handlers — clicking a
// tree item navigates to the matching cmd-stack screen and closes itself.
export default function NavDrawerScreen() {
  const nav = useNavigation<any>();
  const C = useCmdColors();
  const currentUser = useStore((s) => s.currentUser);
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const stores = useStore((s) => s.stores);
  const logout = useStore((s) => s.logout);
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

  // Admin-only app — store users have a separate app + API. Tree IA is the
  // full Operations / Planning / Insights set.
  const groups: { label: string; items: TreeItem[] }[] = [
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
        { id: 'Recipes',         label: 'Menu items / BOM', onPress: () => goAndClose('ComingSoon', { sectionName: 'Menu items / BOM' }) },
        { id: 'PrepRecipes',     label: 'Prep recipes',     onPress: () => goAndClose('ComingSoon', { sectionName: 'Prep recipes' }) },
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
  const index = useCommandPaletteIndex();
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
      subtitle={`${currentUser?.email || 'guest'} · v2.4`}
      footerLeft={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[Type.statusBar, { color: C.fg3 }]}>● {currentUser?.email || 'guest'}</Text>
          <TouchableOpacity
            onPress={() => {
              const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                ? window.confirm('Sign out?')
                : true;
              if (ok) { close(); logout(); }
            }}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: CmdRadius.xs,
              borderWidth: 1,
              borderColor: C.border,
            }}
          >
            <Text style={[Type.statusBar, { color: C.fg3 }]}>sign out</Text>
          </TouchableOpacity>
        </View>
      }
      footerRight={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ThemeToggle />
          <Text style={[Type.statusBar, { color: C.fg3 }]}>
            EOD {submittedToday}/{totalStores}
          </Text>
        </View>
      }
    />
  );
}
