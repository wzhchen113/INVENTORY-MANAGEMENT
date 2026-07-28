import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCmdColors } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { LoadingBar } from './LoadingBar';

interface Props {
  /** Hamburger button press handler. Always shown. */
  onHamburgerPress: () => void;
  /** Display title in the bar (e.g. current section name). */
  title?: string;
  /** Optional trailing slot (e.g. a settings affordance for tablet). */
  trailing?: React.ReactNode;
  /** Glyph rendered in the hamburger button. Defaults to ☰. */
  hamburgerGlyph?: string;
  /** Accessibility label for the hamburger button. Defaults to "Open menu". */
  hamburgerLabel?: string;
  /** Inner-row height. Defaults to 44 (Spec 011). Spec 142 passes 52 from the
   *  phone branch so the fixed bar matches the handoff Hard Rule 5 (52px, never
   *  overlapped). A height ≥ 52 also grows the hamburger hit target to 44×44. */
  height?: number;
  /** Optional title text style override (e.g. PhoneType.screenTitle on phone).
   *  Defaults to the Spec 011 sans-600 / 14 style so existing callers are
   *  byte-unchanged. */
  titleType?: TextStyle;
}

// Spec 011 §2 — narrow-tier app bar: hamburger + section title + slot.
// 44 px tall by default (Spec 142 phone branch passes 52), plus the device top
// safe-area inset on phone (notches / dynamic island). Tablet renders without
// inset since the chrome lives inside the browser viewport on web only.
export const MobileTopAppBar: React.FC<Props> = ({
  onHamburgerPress,
  title,
  trailing,
  hamburgerGlyph = '☰',
  hamburgerLabel = 'Open menu',
  height = 44,
  titleType,
}) => {
  const C = useCmdColors();
  const insets = useSafeAreaInsets();
  // Top inset only when running outside web (native phones with notches).
  // On web the browser chrome owns the top inset.
  const topPad = Platform.OS === 'web' ? 0 : insets.top;
  // Spec 142 — grow the hamburger hit target to the 44×44 floor once the bar is
  // at the phone 52px height; the default 44px bar keeps the historical 32×32.
  const hitSize = height >= 52 ? 44 : 32;

  return (
    <View
      style={{
        paddingTop: topPad,
        backgroundColor: C.panel,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        // `position: 'relative'` is the anchor for the LoadingBar overlay
        // below — absolute positioning needs a positioned ancestor or it
        // climbs to the document body. Mirrors TitleBar.tsx:116.
        position: 'relative',
      }}
    >
      {/* Spec 056 — global in-flight indicator on the phone-tier shell.
          Renders only when a db.ts call is active; web-only (LoadingBar
          bails on native). Mounted as the first child so its absolute
          positioning is unambiguous (mirrors TitleBar.tsx:119-122). */}
      <LoadingBar />
      <View
        testID="mobile-top-app-bar-row"
        style={{
          height,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <TouchableOpacity
          onPress={onHamburgerPress}
          accessibilityRole="button"
          accessibilityLabel={hamburgerLabel}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={{
            width: hitSize,
            height: hitSize,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>
            {hamburgerGlyph}
          </Text>
        </TouchableOpacity>
        <Text
          numberOfLines={1}
          style={[
            { flex: 1, color: C.fg },
            titleType ?? { fontFamily: sans(600), fontSize: 14 },
          ]}
        >
          {title || 'im.cmd'}
        </Text>
        {trailing ? <View>{trailing}</View> : null}
      </View>
    </View>
  );
};
