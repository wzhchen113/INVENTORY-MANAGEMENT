// src/screens/cmd/sections/phone/PhoneWasteLogSheet.tsx — Spec 142 (chunk c).
//
// The two-step "log waste" bottom sheet (AC-WASTE2) on the spec-140
// ResponsiveSheet (presentation.phone: 'bottom-sheet'):
//   step 1 — item picker (48px scrollable rows, searchable)
//   step 2 — qty stepper (52px, ±≥44 buttons) + reason chips + cost preview + SAVE
// SAVE calls the EXISTING `logWaste` store action (optimistic-then-revert +
// notifyBackendError inherited, not re-implemented) and closes; the feed
// re-derives from the wasteLog slice (no manual prepend). Reason chips use the
// existing WasteReason enum (WasteLogSection.tsx:17), not new strings.

import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { ResponsiveSheet } from '../../../../components/cmd/ResponsiveSheet';
import { wasteReasonLabel } from '../../../../utils/enumLabels';
import type { InventoryItem, WasteReason } from '../../../../types';

const REASONS: WasteReason[] = ['Expired', 'Dropped/spilled', 'Over-prepped', 'Quality issue', 'Theft', 'Other'];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const PhoneWasteLogSheet: React.FC<Props> = ({ visible, onClose }) => {
  const C = useCmdColors();
  const T = useT();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const logWaste = useStore((s) => s.logWaste);

  const [step, setStep] = React.useState<'pick' | 'qty'>('pick');
  const [item, setItem] = React.useState<InventoryItem | null>(null);
  const [query, setQuery] = React.useState('');
  const [qty, setQty] = React.useState(1);
  const [reason, setReason] = React.useState<WasteReason>('Expired');

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore?.id),
    [inventory, currentStore?.id],
  );
  const picks = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? storeInventory.filter((i) => i.name.toLowerCase().includes(q)) : storeInventory;
  }, [storeInventory, query]);

  // Reset all local state whenever the sheet is (re)opened.
  React.useEffect(() => {
    if (visible) {
      setStep('pick');
      setItem(null);
      setQuery('');
      setQty(1);
      setReason('Expired');
    }
  }, [visible]);

  // Spec 104 (OQ-5) — `item.costPerUnit` is a LIVE per-EACH cost and `qty` is in
  // counted units, so the preview bridges `× subUnitSize` to stay per-counted-
  // unit (matches the frozen dollar the write-side snapshot stores). Mirrors the
  // desktop preview at WasteLogSection.tsx.
  const previewCost = item ? qty * item.costPerUnit * (item.subUnitSize || 1) : 0;

  const save = () => {
    if (!item || qty <= 0) return;
    logWaste({
      itemId: item.id,
      itemName: item.name,
      quantity: qty,
      unit: item.unit,
      costPerUnit: item.costPerUnit,
      reason,
      loggedBy: currentUser?.name || 'unknown',
      loggedByUserId: currentUser?.id || '',
      timestamp: new Date().toISOString(),
      notes: '',
      storeId: currentStore?.id || '',
    });
    Toast.show({ type: 'success', text1: 'Waste logged', text2: `${qty} ${item.unit} ${item.name}` });
    onClose();
  };

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 52, borderBottomWidth: 1, borderBottomColor: C.border }}>
      <Text style={[PhoneType.caption, { color: C.fg3, flex: 1 }]}>
        LOG WASTE · {step === 'pick' ? 'STEP 1 · ITEM' : 'STEP 2 · DETAILS'}
      </Text>
      <TouchableOpacity
        testID="phone-waste-sheet-close"
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={T('common.closeAria')}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
      </TouchableOpacity>
    </View>
  );

  const footer =
    step === 'qty' ? (
      <View style={{ flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: 1, borderTopColor: C.border }}>
        <TouchableOpacity
          onPress={() => setStep('pick')}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ width: 96, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(600), fontSize: 12, color: C.fg2 }}>← BACK</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="phone-waste-save"
          onPress={save}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>SAVE −${previewCost.toFixed(2)}</Text>
        </TouchableOpacity>
      </View>
    ) : null;

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      presentation={{ phone: 'bottom-sheet' }}
      header={header}
      footer={footer}
      accessibilityLabel="Log waste"
    >
      {step === 'pick' ? (
        // Explicit opaque bg so step 1 never renders see-through on web (the
        // sheet container's fade can lag first paint until an interaction).
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              testID="phone-waste-search"
              value={query}
              onChangeText={setQuery}
              placeholder={T('section.inventory.filterPlaceholder')}
              placeholderTextColor={C.fg3}
              style={{
                height: 44,
                paddingHorizontal: 12,
                fontFamily: mono(400),
                fontSize: 13,
                color: C.fg,
                backgroundColor: C.panel2,
                borderWidth: 1,
                borderColor: C.border,
                borderRadius: CmdRadius.sm,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
          </View>
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            {picks.map((it) => (
              <TouchableOpacity
                key={it.id}
                testID={`phone-waste-pick-${it.id}`}
                onPress={() => {
                  setItem(it);
                  setQty(1);
                  setStep('qty');
                }}
                activeOpacity={0.7}
                style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border }}
              >
                <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{it.name}</Text>
                <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{it.currentStock} {it.unit}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : (
        <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
          <Text style={[PhoneType.itemName, { color: C.fg }]}>{item?.name}</Text>

          {/* Qty stepper */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52 }}>
            <StepperButton label="−" onPress={() => setQty((q) => Math.max(1, q - 1))} />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={[PhoneType.heroValue, { color: C.fg }]}>{qty}</Text>
              <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>{item?.unit}</Text>
            </View>
            <StepperButton label="+" onPress={() => setQty((q) => q + 1)} />
          </View>

          {/* Reason chips */}
          <View style={{ gap: 6 }}>
            <Text style={[PhoneType.microCaption, { color: C.fg3 }]}>REASON</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {REASONS.map((r) => {
                const on = r === reason;
                return (
                  <TouchableOpacity
                    key={r}
                    testID={`phone-waste-reason-${r}`}
                    onPress={() => setReason(r)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={{
                      minHeight: 44,
                      justifyContent: 'center',
                      paddingHorizontal: 14,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: on ? C.accent : C.border,
                      backgroundColor: on ? C.accentBg : C.panel2,
                    }}
                  >
                    <Text style={{ fontFamily: mono(600), fontSize: 12, color: on ? C.accent : C.fg2 }}>{wasteReasonLabel(r, T)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Cost preview */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, paddingHorizontal: 14, paddingVertical: 12 }}>
            <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]}>COST</Text>
            <Text style={[PhoneType.tableNum, { color: C.danger }]}>−${previewCost.toFixed(2)}</Text>
          </View>
        </ScrollView>
      )}
    </ResponsiveSheet>
  );
};

function StepperButton({ label, onPress }: { label: string; onPress: () => void }) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'Increase quantity' : 'Decrease quantity'}
      style={{ width: 56, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontFamily: mono(500), fontSize: 22, color: C.fg }}>{label}</Text>
    </TouchableOpacity>
  );
}
