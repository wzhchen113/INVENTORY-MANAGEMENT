import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { IngredientFormValues } from './IngredientForm';

interface Props {
  values: IngredientFormValues;
  /** True when all required fields pass validation. */
  valid: boolean;
}

// Live JSON view of the ingredient form. Renders a colored token tree —
// strings green, numbers blue, falsy/dashes muted. Used as the right-pane
// of IngredientFormDrawer in NEW mode.
export const JsonPreview: React.FC<Props> = ({ values, valid }) => {
  const C = useCmdColors();

  // Token helpers
  const Str = ({ children }: { children: React.ReactNode }) => (
    <Text style={{ color: C.accent }}>"{children}"</Text>
  );
  const Num = ({ children }: { children: React.ReactNode }) => (
    <Text style={{ color: C.info }}>{children}</Text>
  );
  const Dim = ({ children }: { children: React.ReactNode }) => (
    <Text style={{ color: C.fg3 }}>{children}</Text>
  );

  return (
    <View style={{ width: 280, backgroundColor: C.panel2, borderLeftWidth: 1, borderLeftColor: C.border, flexDirection: 'column' }}>
      <View style={{ padding: '10px 14px' as any, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6 }}>preview.json</Text>
        <View style={{ flex: 1 }} />
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: valid ? C.ok : C.warn }}>● {valid ? 'valid' : 'incomplete'}</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 0 }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, lineHeight: 17, color: C.fg2 }}>
          {'{'}
          {'\n  "name": '}<Str>{values.name || '—'}</Str>,
          {'\n  "sku": '}<Dim>"auto"</Dim>,
          {'\n  "category": '}<Str>{values.category || '—'}</Str>,
          {'\n  "unit": '}<Str>{values.unit || '—'}</Str>,
          {'\n  "pack": {'}
          {' "size": '}<Num>{values.caseQty || 0}</Num>,
          {' "unit": '}<Str>{values.packUnit || '—'}</Str>
          {' },'}
          {'\n  "par": '}<Num>{values.parLevel || 0}</Num>,
          {'\n  "vendor": {'}
          {'\n    "primary": '}<Str>{values.vendorName || '—'}</Str>,
          {'\n    "sku": '}<Str>{values.vendorSku || '—'}</Str>,
          {'\n    "last_cost": '}<Num>{values.costPerUnit || 0}</Num>
          {'\n  },'}
          {'\n  "flags": {'}
          {'\n    "count_nightly": '}<Num>{String(values.countNightly)}</Num>,
          {'\n    "track_waste": '}<Num>{String(values.trackWaste)}</Num>,
          {'\n    "allow_substitute": '}<Num>{String(values.allowSubstitute)}</Num>
          {'\n  }'}
          {'\n}'}
        </Text>
      </ScrollView>
    </View>
  );
};
