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
  /** Spec 158 (OQ-2) — makes the whole title area a pressable that opens the
   *  guide for the active section, and renders a small trailing `?` marker
   *  inside the title area so the affordance is discoverable.
   *
   *  Why the title and not a fifth trailing glyph: the phone bar is a FIXED
   *  52px (handoff Hard Rule 5) and its trailing cluster already carries brand
   *  picker (super-admin) + bell + theme + refresh at 375px. The title row is
   *  ≫44px wide and 52px tall, so it is a legal target for free and costs ~16px
   *  of title width instead of a whole control.
   *
   *  OPTIONAL: callers that pass nothing render a plain `Text`, byte-identical
   *  to before (AC-REG3). */
  onTitlePress?: () => void;
  /** Accessibility label for the pressable title. Only used with
   *  `onTitlePress`. */
  titlePressLabel?: string;
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
  onTitlePress,
  titlePressLabel,
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
        {onTitlePress ? (
          // Spec 158 — the whole title area is the guide affordance. The title
          // Text keeps numberOfLines={1} and flex:1 so a long section name
          // still ellipsizes rather than pushing the `?` marker out of the bar;
          // the marker itself is flexShrink:0 and ALWAYS visible (never
          // hover-only) — a pressable title is otherwise undiscoverable.
          <TouchableOpacity
            testID="cmd-guide-entry"
            onPress={onTitlePress}
            accessibilityRole="button"
            accessibilityLabel={titlePressLabel}
            activeOpacity={0.7}
            style={{
              flex: 1,
              minWidth: 0,
              height,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Text
              numberOfLines={1}
              style={[
                { flexShrink: 1, minWidth: 0, color: C.fg },
                titleType ?? { fontFamily: sans(600), fontSize: 14 },
              ]}
            >
              {title || 'im.cmd'}
            </Text>
            <Text
              testID="cmd-guide-entry-marker"
              style={{ fontFamily: mono(500), fontSize: 12, color: C.fg3, flexShrink: 0 }}
            >
              ?
            </Text>
          </TouchableOpacity>
        ) : (
          <Text
            numberOfLines={1}
            style={[
              { flex: 1, color: C.fg },
              titleType ?? { fontFamily: sans(600), fontSize: 14 },
            ]}
          >
            {title || 'im.cmd'}
          </Text>
        )}
        {trailing ? <View>{trailing}</View> : null}
      </View>
    </View>
  );
};
