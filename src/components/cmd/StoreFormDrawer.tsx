import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Required — the new store is created under this brand. */
  brandId: string;
  /** Optional display label for the brand (shown in the drawer chrome). */
  brandName?: string;
}

// New-store drawer used from the Brands section's StoresTab. Mirrors
// BrandFormDrawer shape (right-anchored 480w on desktop, bottom sheet
// on tablet, full-screen on phone). Two fields — name + address; the
// brand_id is captive (passed by the parent — required by RLS).
export const StoreFormDrawer: React.FC<Props> = ({ visible, onClose, brandId, brandName }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const addStore = useStore((s) => s.addStore);
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      setName('');
      setAddress('');
      setSubmitting(false);
    }
  }, [visible]);

  const requiredValid = name.trim().length > 0;

  const handleSave = async () => {
    if (!requiredValid || submitting) return;
    setSubmitting(true);
    try {
      addStore({
        name: name.trim(),
        address: address.trim(),
        brandId,
        status: 'active',
      });
      Toast.show({ type: 'success', text1: 'Created store', text2: name.trim() });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveRef = React.useRef(handleSave);
  handleSaveRef.current = handleSave;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSaveRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

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
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>NEW</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        new-store
      </Text>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.warnBg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.warn }}>● unsaved</Text>
      </View>
      {isPhone ? (
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
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
        {requiredValid ? '1/1 required valid' : '0/1 required valid'}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleSave}
        disabled={!requiredValid || submitting}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: requiredValid && !submitting ? C.accent : C.panel2,
          opacity: requiredValid && !submitting ? 1 : 0.6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid && !submitting ? C.accentFg : C.fg3 }}>
          {submitting ? 'SAVING…' : 'CREATE  ⌘⏎'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={480}
      tabletSheetHeight={0.5}
      header={header}
      footer={footer}
      accessibilityLabel="New store"
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View
          style={{
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            padding: 12,
            gap: 2,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Brand
          </Text>
          <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>
            {brandName || brandId}
          </Text>
        </View>

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
            Store name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Towson"
            placeholderTextColor={C.fg3}
            autoFocus
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
        </View>

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
            Address (optional)
          </Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="e.g. 1234 York Rd, Towson MD 21204"
            placeholderTextColor={C.fg3}
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};
