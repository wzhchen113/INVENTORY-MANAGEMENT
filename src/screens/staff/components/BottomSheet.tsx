// src/screens/staff/components/BottomSheet.tsx — Spec 141 §6.
//
// Staff-local bottom-sheet primitive. There is NO `ResponsiveSheet` in the
// staff subtree and importing the admin one is forbidden (spec 141
// Out-of-scope), so this is a staff-simplified re-implementation of the SAME
// sanctioned idiom `ResponsiveSheet` uses: RN `Modal` + `Animated` slide —
// NOT @gorhom/bottom-sheet, NOT Reanimated. No breakpoint fork (the staff app
// is always the bottom-sheet form) and no drag-to-dismiss (AC-3): dismissal is
// scrim tap + the caller's ✕ only.
//
// Every color/dimension reads from the staff hooks
// (`useStaffColors`/`useStaffTokens`/`useStaffElevation`) — never a hardcoded
// palette (OQ-B), so the sheet tracks whichever palette the app is pinned to
// (currently dark).

import React from 'react';
import {
  View,
  Modal,
  TouchableOpacity,
  Animated,
  Easing,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStaffColors, useStaffElevation, useStaffTokens } from '../theme';

export interface BottomSheetProps {
  visible: boolean;
  /** scrim tap + the caller's ✕ both call this. */
  onClose: () => void;
  /** Sheet height as a fraction of viewport height. Defaults to ~0.68. */
  heightFraction?: number;
  /** Sticky header (flexShrink: 0). */
  header?: React.ReactNode;
  /** Sticky footer (flexShrink: 0). */
  footer?: React.ReactNode;
  /** Scrollable middle. */
  children: React.ReactNode;
  accessibilityLabel?: string;
}

export const BottomSheet: React.FC<BottomSheetProps> = ({
  visible,
  onClose,
  heightFraction = 0.68,
  header,
  footer,
  children,
  accessibilityLabel,
}) => {
  const c = useStaffColors();
  const T = useStaffTokens();
  const e = useStaffElevation();
  const insets = useSafeAreaInsets();
  const { height: vh } = useWindowDimensions();

  // Slide-in: seed off-screen (bottom), animate to 0. Native driver only on
  // native — RN-Web 0.21 has no native animated module (passing true there
  // warns and falls back to JS). Copied from ResponsiveSheet's verified branch.
  const anim = React.useRef(new Animated.Value(vh)).current;

  React.useEffect(() => {
    if (visible) {
      anim.setValue(vh);
      Animated.timing(anim, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [visible, vh, anim]);

  if (!visible) return null;

  const sheetHeight = Math.round(vh * heightFraction);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityLabel={accessibilityLabel}
    >
      {/* Scrim — full-bleed tap-to-dismiss; the sheet seats at the bottom. */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        accessible={false}
        testID="staff-sheet-scrim"
        style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}
      >
        <Animated.View
          style={[
            {
              width: '100%',
              height: sheetHeight,
              backgroundColor: c.surface,
              borderTopLeftRadius: T.radius.lg,
              borderTopRightRadius: T.radius.lg,
              borderTopWidth: 1,
              borderTopColor: c.borderStrong,
              paddingBottom: insets.bottom,
              overflow: 'hidden',
              transform: [{ translateY: anim }],
            },
            e.modal,
          ]}
        >
          {/* Inner swallow: taps inside the sheet must NOT fall through to the
              scrim — same guard ResponsiveSheet uses. */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            accessible={false}
            style={{ flex: 1, flexDirection: 'column' }}
          >
            {header ? <View style={{ flexShrink: 0 }}>{header}</View> : null}
            <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
            {footer ? <View style={{ flexShrink: 0 }}>{footer}</View> : null}
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
};

export default BottomSheet;
