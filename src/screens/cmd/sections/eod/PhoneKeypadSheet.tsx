// src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx — Spec 140 §2.
//
// The phone-tier EOD count keypad, built on the sanctioned `ResponsiveSheet`
// with `presentation.phone: 'bottom-sheet'` (RN `Modal` + `Animated` slide —
// NOT @gorhom, NOT Reanimated-on-web). The field wells are `Pressable`/`Text`,
// never `TextInput`, so the OS keyboard never opens for the custom digit pad;
// the note field IS a real `TextInput` (a text keyboard is correct there).
//
// This component is presentational: every write goes back through the parent
// (`PhoneEodCount`) so the existing count maps stay the single source of truth.

import React from 'react';
import { View, Text, Pressable, TextInput, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import { KEYPAD_BACKSPACE } from '../../../../lib/eodKeypad';
import { ResponsiveSheet } from '../../../../components/cmd/ResponsiveSheet';
import type { InventoryItem } from '../../../../types';

export interface PhoneKeypadSheetProps {
  visible: boolean;
  item: InventoryItem | null;
  /** Which well the pad currently writes to. */
  activeField: 'cases' | 'units';
  setActiveField: (f: 'cases' | 'units') => void;
  caseValue: string;
  unitValue: string;
  noteValue: string;
  runningTotal: number;
  /** True when nothing uncounted remains → NEXT ITEM relabels to DONE ✓. */
  isDone: boolean;
  onKey: (key: string) => void;
  onNote: (text: string) => void;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}

const DIGIT_KEYS: string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', KEYPAD_BACKSPACE];

export const PhoneKeypadSheet: React.FC<PhoneKeypadSheetProps> = ({
  visible,
  item,
  activeField,
  setActiveField,
  caseValue,
  unitValue,
  noteValue,
  runningTotal,
  isDone,
  onKey,
  onNote,
  onSkip,
  onNext,
  onClose,
}) => {
  const C = useCmdColors();
  const T = useT();

  if (!item) return null;

  const hasCase = (item.caseQty || 0) > 1;

  const Well = ({
    field,
    label,
    value,
  }: {
    field: 'cases' | 'units';
    label: string;
    value: string;
  }) => {
    const active = activeField === field;
    return (
      <Pressable
        testID={`eod-sheet-well-${field}`}
        onPress={() => setActiveField(field)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flex: 1,
          minHeight: 56,
          borderWidth: active ? 2 : 1,
          borderColor: active ? C.accent : C.borderStrong,
          backgroundColor: active ? C.accentBg : C.panel2,
          borderRadius: CmdRadius.md,
          paddingHorizontal: 12,
          justifyContent: 'center',
        }}
      >
        <Text style={{ ...PhoneType.microCaption, color: C.fg3 }}>{label}</Text>
        <Text style={{ ...PhoneType.wellValueSheet, color: value.trim() !== '' ? C.fg : C.fg3, marginTop: 2 }}>
          {value.trim() !== '' ? value : '—'}
        </Text>
      </Pressable>
    );
  };

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        gap: 12,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text testID="eod-sheet-title" style={{ ...PhoneType.itemName, color: C.fg }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{ ...PhoneType.metaMono, color: C.fg3, marginTop: 3 }} numberOfLines={1}>
          {item.unit}
          {hasCase ? ` · case ${item.caseQty}` : ''}
          {item.parLevel > 0 ? ` · par ${item.parLevel}` : ''}
        </Text>
      </View>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -6, marginRight: -8 }}
      >
        <Text style={{ fontFamily: mono(500), fontSize: 20, color: C.fg2 }}>✕</Text>
      </Pressable>
    </View>
  );

  const footer = (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 12,
        borderTopWidth: 1,
        borderTopColor: C.border,
      }}
    >
      <Pressable
        testID="eod-sheet-skip"
        onPress={onSkip}
        accessibilityRole="button"
        accessibilityLabel={T('section.eod.phone.skip')}
        style={{
          flex: 1,
          height: 48,
          borderWidth: 1,
          borderColor: C.borderStrong,
          borderRadius: CmdRadius.sm,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: mono(600), fontSize: 12.5, color: C.fg2 }}>{T('section.eod.phone.skip')}</Text>
      </Pressable>
      <Pressable
        testID="eod-sheet-next"
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel={isDone ? T('section.eod.phone.done') : T('section.eod.phone.nextItem')}
        style={{
          flex: 2,
          height: 48,
          backgroundColor: C.accent,
          borderRadius: CmdRadius.sm,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 12.5, color: C.accentFg }}>
          {isDone ? T('section.eod.phone.done') : T('section.eod.phone.nextItem')}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      presentation={{ phone: 'bottom-sheet' }}
      tabletSheetHeight={0.72}
      header={header}
      footer={footer}
      accessibilityLabel={`Count ${item.name}`}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 12 }}>
        {/* Field wells — the tapped well is the active field. */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {hasCase ? <Well field="cases" label={T('section.eod.phone.casesWell', { qty: item.caseQty })} value={caseValue} /> : null}
          <Well field="units" label={item.unit} value={unitValue} />
        </View>

        {/* Note input — a real TextInput (text keyboard is correct here). */}
        <TextInput
          value={noteValue}
          onChangeText={onNote}
          placeholder={T('section.eod.notePlaceholder')}
          placeholderTextColor={C.fg3}
          style={{
            height: 40,
            paddingHorizontal: 12,
            fontFamily: mono(400),
            fontSize: 12.5,
            color: C.fg2,
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />

        {/* Running total. */}
        <Text style={{ ...PhoneType.metaMono, color: C.fg2 }}>
          {T('section.eod.phone.runningTotal', { total: runningTotal, unit: item.unit })}
        </Text>

        {/* 3-column digit pad (flex-wrap rows, no CSS grid). */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {DIGIT_KEYS.map((k) => (
            <View key={k} style={{ width: '33.3333%', padding: 4 }}>
              <Pressable
                testID={`eod-key-${k === KEYPAD_BACKSPACE ? 'back' : k === '.' ? 'dot' : k}`}
                onPress={() => onKey(k)}
                accessibilityRole="button"
                accessibilityLabel={k === KEYPAD_BACKSPACE ? 'Backspace' : k}
                style={{
                  height: 52,
                  borderWidth: 1,
                  borderColor: C.border,
                  backgroundColor: C.panel2,
                  borderRadius: CmdRadius.sm,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ ...PhoneType.keypadKey, color: C.fg }}>{k}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    </ResponsiveSheet>
  );
};

export default PhoneKeypadSheet;
