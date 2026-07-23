import React from 'react';
import { View } from 'react-native';
import { useCmdColors } from '../../../theme/colors';
import { useT } from '../../../hooks/useT';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { useOrderingHandoff } from '../../../lib/orderingHandoff';
import ReorderSection from './ReorderSection';
import POsSection from './POsSection';

// Spec 137 — the unified "Ordering" destination. A thin tab shell that hosts
// the two EXISTING sections (ReorderSection, POsSection) as tabs, defaulting to
// the Reorder landing tab. Both sections mount UNCHANGED; this shell owns only
// the local `activeTab` state and the cross-tab deep-link orchestration.
//
// Conditional render (only the active tab is mounted) is deliberate: today each
// section mounts fresh when navigated to, so remount-on-tab-switch reproduces
// today's behavior exactly, and keeps the two ~1700/~810-line sections from
// both being mounted at once.
//
// Deep-link: "+ CREATE PO" on a Reorder vendor card resolves with the new poId.
// `handlePoCreated` flips to the Purchase-orders tab (plain shell state) and
// writes the poId to the orderingHandoff signal; POsSection subscribes and
// one-shot preselects it. `createPoDraft` already awaited refreshPurchaseOrders
// before resolving, so the draft is present in orderSubmissions by the time the
// PO tab mounts.
export default function OrderingSection() {
  const C = useCmdColors();
  const T = useT();
  const [activeTab, setActiveTab] = React.useState<'reorder' | 'pos'>('reorder');

  const handlePoCreated = React.useCallback((poId: string) => {
    setActiveTab('pos');
    useOrderingHandoff.getState().requestPoSelect(poId);
  }, []);

  // Code-review Should-fix (spec 137): if the admin navigates AWAY from
  // Ordering in the instant between the tab flip above and POsSection
  // consuming the signal, the pending poId would linger and mis-select that
  // stale draft on a LATER visit. The shell owns the signal's lifecycle, so
  // unmount clears any unconsumed signal. (Consuming twice is a no-op — the
  // consume() below and POsSection's own consume() both just null the field.)
  React.useEffect(() => {
    return () => {
      useOrderingHandoff.getState().consume();
    };
  }, []);

  return (
    <View testID="ordering-root" style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'reorder', label: T('sidebar.items.reorder'), testID: 'ordering-tab-reorder' },
          { id: 'pos', label: T('sidebar.items.purchaseOrders'), testID: 'ordering-tab-pos' },
        ]}
        activeId={activeTab}
        onChange={(id) => setActiveTab(id as 'reorder' | 'pos')}
      />
      <View style={{ flex: 1, minHeight: 0 }}>
        {activeTab === 'reorder' ? (
          <ReorderSection onPoCreated={handlePoCreated} />
        ) : (
          <POsSection />
        )}
      </View>
    </View>
  );
}
