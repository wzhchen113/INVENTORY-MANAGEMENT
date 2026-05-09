import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCmdColors } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';

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
}

// Spec 011 §2 — narrow-tier app bar: hamburger + section title + slot.
// 44 px tall, plus the device top safe-area inset on phone (notches /
// dynamic island). Tablet renders without inset since the chrome lives
// inside the browser viewport on web only.
export const MobileTopAppBar: React.FC<Props> = ({
  onHamburgerPress,
  title,
  trailing,
  hamburgerGlyph = '☰',
  hamburgerLabel = 'Open menu',
}) => {
  const C = useCmdColors();
  const insets = useSafeAreaInsets();
  // Top inset only when running outside web (native phones with notches).
  // On web the browser chrome owns the top inset.
  const topPad = Platform.OS === 'web' ? 0 : insets.top;

  return (
    <View
      style={{
        paddingTop: topPad,
        backgroundColor: C.panel,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
      }}
    >
      <View
        style={{
          height: 44,
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
            width: 32,
            height: 32,
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
          style={{
            flex: 1,
            fontFamily: sans(600),
            fontSize: 14,
            color: C.fg,
          }}
        >
          {title || 'im.cmd'}
        </Text>
        {trailing ? <View>{trailing}</View> : null}
      </View>
    </View>
  );
};
