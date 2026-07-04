// src/components/cmd/CountLayoutNameModal.tsx — Spec 110.
//
// A small cross-platform name-entry modal for the admin Weekly-count layout
// authoring surface (create + rename). Deliberately NOT window.prompt (which
// doesn't exist on native and is blocked in the RNW test env) — this is the
// lean RN Modal shape used elsewhere in the Cmd UI (AddCountModal). One text
// input + Save/Cancel; the caller owns the create-vs-rename semantics and
// passes the title/initial value. Save is disabled while the trimmed value is
// empty (the RPC re-validates + trims server-side, AC name validation).
//
// Web niceties: Escape cancels, Enter saves (when non-empty). Native gets the
// same buttons; the keyboard "submit" also saves.

import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';

interface Props {
  visible: boolean;
  /** Modal title (create vs rename copy is the caller's — pass the resolved
   *  string, e.g. T('section.countLayout.nameNewTitle')). */
  title: string;
  /** Prefill for the input (the current name on rename; '' on create). */
  initialValue?: string;
  /** Placeholder shown when the input is empty. */
  placeholder?: string;
  /** Fired with the TRIMMED name on Save. The caller performs the write. */
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export const CountLayoutNameModal: React.FC<Props> = ({
  visible,
  title,
  initialValue = '',
  placeholder,
  onSubmit,
  onClose,
}) => {
  const C = useCmdColors();
  const T = useT();
  const [value, setValue] = React.useState(initialValue);
  const inputRef = React.useRef<TextInput>(null);

  // Reset the field to the caller's initial value on each open so a prior
  // create/rename doesn't leak its text into the next invocation.
  React.useEffect(() => {
    if (visible) {
      setValue(initialValue);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, initialValue]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0;

  const submit = React.useCallback(() => {
    if (!trimmed) return;
    onSubmit(trimmed);
  }, [trimmed, onSubmit]);

  // Esc closes, Enter saves (web only — native uses the button + keyboard
  // submit). Held in a ref so the handler always sees the latest value.
  const submitRef = React.useRef(submit);
  submitRef.current = submit;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        submitRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        accessibilityLabel={T('common.close')}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.4)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            width: 420,
            maxWidth: '100%',
            backgroundColor: C.panel,
            borderWidth: 1,
            borderColor: C.borderStrong,
            borderRadius: 8,
            ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}),
            overflow: 'hidden',
          }}
        >
          {/* Title bar */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 13,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
            }}
          >
            <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }}>{title}</Text>
          </View>

          {/* Input */}
          <View style={{ padding: 16 }}>
            <TextInput
              testID="layout-name-input"
              ref={inputRef}
              value={value}
              onChangeText={setValue}
              onSubmitEditing={submit}
              placeholder={placeholder}
              placeholderTextColor={C.fg3}
              maxLength={60}
              style={{
                height: 36,
                paddingHorizontal: 12,
                fontFamily: mono(400),
                fontSize: 14,
                color: C.fg,
                backgroundColor: C.panel2,
                borderWidth: 1,
                borderColor: C.border,
                borderRadius: CmdRadius.sm,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
          </View>

          {/* Footer — Cancel + Save */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderTopWidth: 1,
              borderTopColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: C.panel,
            }}
          >
            {Platform.OS === 'web' ? (
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              testID="layout-name-cancel"
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={T('section.countLayout.cancel')}
              style={{
                paddingVertical: 7,
                paddingHorizontal: 14,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>
                {T('section.countLayout.cancel')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="layout-name-save"
              onPress={submit}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel={T('section.countLayout.save')}
              accessibilityState={{ disabled: !canSave }}
              style={{
                paddingVertical: 7,
                paddingHorizontal: 14,
                borderRadius: CmdRadius.sm,
                backgroundColor: canSave ? C.accent : C.panel2,
                opacity: canSave ? 1 : 0.6,
                ...(Platform.OS === 'web' && !canSave ? ({ pointerEvents: 'none' } as any) : {}),
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: canSave ? C.accentFg : C.fg3 }}>
                {T('section.countLayout.save')}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

export default CountLayoutNameModal;
