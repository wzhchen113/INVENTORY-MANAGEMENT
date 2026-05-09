import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';

// ─── SelectField — minimal dropdown for Cmd UI form lookup fields ──────
// Renders a styled trigger that toggles a panel of options. Matches the
// InputLine visual rhythm (same height, border, focus ring) so the form
// reads as a coherent grid.
//
// Web: native <select> for accessibility + correctness inside the modal
// drawer (avoids z-index headaches with the existing two-modal stack).
// Native: a TouchableOpacity that opens an inline list panel beneath the
// trigger. The native variant is intentionally simple — it's good enough
// for the small option counts here (a few dozen at most).
//
// Lifted from IngredientForm.tsx so other Cmd UI surfaces (recipe / prep
// drawers) can reuse it without an import cycle. IngredientForm.tsx
// re-exports the same name for compatibility with external imports.
export const SelectField: React.FC<{
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean; group?: string }>;
  onChange: (next: string) => void;
  placeholder?: string;
  width?: any;
  help?: string;
  error?: string;
  monoFont?: boolean;
  /** When true, treats the empty value as "not yet picked" and renders the placeholder. */
  allowEmpty?: boolean;
}> = ({ label, value, options, onChange, placeholder, width = '100%', help, error, monoFont, allowEmpty }) => {
  const C = useCmdColors();
  const [open, setOpen] = React.useState(false);
  const borderColor = open ? C.accent : error ? C.danger : C.border;
  const display = options.find((o) => o.value === value)?.label || (allowEmpty ? placeholder || '— select —' : value || placeholder || '— select —');

  if (Platform.OS === 'web') {
    return (
      <View style={{ width, gap: 4 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </Text>
        <View style={{
          height: 32, paddingHorizontal: 8, justifyContent: 'center',
          backgroundColor: C.panel,
          borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
        }}>
          {React.createElement('select', {
            value: value || '',
            onChange: (e: any) => onChange(e.target.value),
            style: {
              fontFamily: monoFont ? mono(400) : sans(500),
              fontSize: 12.5,
              color: !value && allowEmpty ? C.fg3 : C.fg,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              width: '100%',
              cursor: 'pointer',
              appearance: 'none' as any,
              WebkitAppearance: 'none' as any,
              MozAppearance: 'none' as any,
              backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23${(C.fg3 || '#888').replace('#','')}' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 6px center',
              paddingRight: 18,
            },
          },
            allowEmpty ? React.createElement('option', { key: '__empty', value: '' }, placeholder || '— select —') : null,
            ...options.map((o) =>
              React.createElement('option', {
                key: o.value,
                value: o.value,
                disabled: o.disabled,
              }, o.label),
            ),
          )}
        </View>
        {(help || error) ? (
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
            {error || help}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ width, gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Text>
      <TouchableOpacity
        onPress={() => setOpen((p) => !p)}
        activeOpacity={0.85}
        style={{
          height: 32, paddingHorizontal: 11, justifyContent: 'center',
          backgroundColor: C.panel,
          borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
          flexDirection: 'row', alignItems: 'center',
        }}
      >
        <Text style={{
          flex: 1,
          fontFamily: monoFont ? mono(400) : sans(500),
          fontSize: 12.5,
          color: !value && allowEmpty ? C.fg3 : C.fg,
        }} numberOfLines={1}>
          {display}
        </Text>
        <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.fg3 }}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, backgroundColor: C.panel }}>
          {options.map((o) => (
            <TouchableOpacity
              key={o.value}
              disabled={o.disabled}
              onPress={() => { onChange(o.value); setOpen(false); }}
              style={{
                paddingVertical: 7, paddingHorizontal: 10,
                borderBottomWidth: 1, borderBottomColor: C.border,
                opacity: o.disabled ? 0.5 : 1,
                backgroundColor: o.value === value ? C.accentBg : 'transparent',
              }}
            >
              <Text style={{ fontFamily: monoFont ? mono(400) : sans(500), fontSize: 12, color: C.fg }}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {(help || error) ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
          {error || help}
        </Text>
      ) : null}
    </View>
  );
};
