import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';

// Spec 012c §8.5 — generic type-to-confirm modal. Reused by FOUR places:
//   - soft-delete brand   (BrandsSection detail header)
//   - hard-delete brand   (CascadePreviewModal step 2)
//   - delete profile      (BrandsSection members tab, Q-ARCH-1)
//   - restore-after-grace edge case (future)
//
// The `requiredText` string is matched case-sensitive + trimmed against
// what the user types. Confirm button is enabled ONLY when match. On
// web, the input autofocuses; Tab cycles input → Cancel → Confirm; Esc
// closes; Enter submits when valid (matches BrandFormDrawer idiom).

export type TypeToConfirmTone = 'warning' | 'danger';

interface TypeToConfirmModalProps {
  visible: boolean;
  title: string;
  description?: string;
  /** User must type this exactly. Case-sensitive, trimmed. */
  requiredText: string;
  /** Button label, e.g. "DELETE BRAND". */
  destructiveLabel: string;
  destructiveTone?: TypeToConfirmTone;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const TypeToConfirmModal: React.FC<TypeToConfirmModalProps> = ({
  visible,
  title,
  description,
  requiredText,
  destructiveLabel,
  destructiveTone = 'danger',
  onConfirm,
  onClose,
}) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  // Reset on each open so the previous typed value doesn't leak.
  React.useEffect(() => {
    if (visible) {
      setTyped('');
      setSubmitting(false);
    }
  }, [visible]);

  const matches = typed.trim() === requiredText;

  const handleConfirm = React.useCallback(async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }, [matches, submitting, onConfirm]);

  // Web keyboard idioms — Esc closes, Enter submits when valid. Held in
  // a ref to avoid stale closures (mirrors BrandFormDrawer).
  const handleConfirmRef = React.useRef(handleConfirm);
  handleConfirmRef.current = handleConfirm;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        handleConfirmRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  // Tone palette — danger = red text on red-tinted bg; warning = amber.
  const toneFg = destructiveTone === 'warning' ? C.warn : C.danger;
  const toneBg = destructiveTone === 'warning' ? C.warnBg : C.dangerBg;

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View
        style={{
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: 3,
          backgroundColor: toneBg,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: toneFg }}>
          {destructiveTone === 'warning' ? 'CONFIRM' : 'DESTRUCTIVE'}
        </Text>
      </View>
      <Text
        style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }}
        numberOfLines={1}
      >
        {title}
      </Text>
      <View style={{ flex: 1 }} />
      {isPhone ? (
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.panel,
        flexWrap: 'wrap',
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {matches
          ? 'name matches — confirm enabled'
          : `type "${requiredText}" to enable`}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.border,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleConfirm}
        disabled={!matches || submitting}
        accessibilityRole="button"
        accessibilityLabel={destructiveLabel}
        accessibilityState={{ disabled: !matches || submitting }}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: matches && !submitting ? toneFg : C.panel2,
          opacity: matches && !submitting ? 1 : 0.6,
        }}
      >
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 11,
            color: matches && !submitting ? C.accentFg : C.fg3,
          }}
        >
          {submitting ? 'WORKING…' : destructiveLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={520}
      tabletSheetHeight={0.55}
      presentation={{ desktop: 'center-modal' }}
      header={header}
      footer={footer}
      accessibilityLabel={title}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 22, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        {description ? (
          <View
            style={{
              backgroundColor: toneBg,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.border,
              padding: 12,
              gap: 6,
            }}
          >
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: toneFg,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              {destructiveTone === 'warning' ? 'Heads up' : 'This is destructive'}
            </Text>
            <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
              {description}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: 4 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Type the name to confirm
          </Text>
          <View
            style={{
              backgroundColor: C.panel2,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.border,
              paddingHorizontal: 10,
              paddingVertical: 8,
              gap: 4,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 12, color: C.fg }}>
              {requiredText}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              case-sensitive · trimmed
            </Text>
          </View>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder={requiredText}
            placeholderTextColor={C.fg3}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="Type the name to enable the destructive button"
            style={{
              fontFamily: mono(500),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel,
              borderWidth: 1,
              borderColor: matches ? toneFg : C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              marginTop: 6,
              // Cleanup SF #7 — outlineStyle is a web-only RNW extension
              // not present in TextStyle; use Record<string, unknown> as
              // a narrower assertion than `as any`.
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as Record<string, unknown>) : {}),
            }}
          />
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};
