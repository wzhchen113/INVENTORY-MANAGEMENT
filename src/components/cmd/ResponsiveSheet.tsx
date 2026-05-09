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
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { useBreakpoint, useIsPhone } from '../../theme/breakpoints';

// Spec 011 §3 — canonical sheet wrapper. Per-tier presentation:
//   - desktop: right-anchored drawer, fixed width (default 760)
//   - tablet : bottom sheet covering ~85% of viewport height
//   - phone  : full-screen modal with safe-area padding
//
// Architect ruled OUT @gorhom/bottom-sheet (no RNW support) — this
// wrapper uses RN's built-in `Modal` + `Animated` slide, which is the
// project's existing idiom (see IngredientFormDrawer / MobileNavDrawer
// pre-Spec-011). Drag-to-dismiss is out of scope for Phase 1.

type DesktopPresentation = 'right-drawer' | 'center-modal';
type TabletPresentation = 'bottom-sheet' | 'right-drawer';
type PhonePresentation = 'fullscreen' | 'bottom-sheet';

interface ResponsiveSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Per-tier presentation override. */
  presentation?: {
    desktop?: DesktopPresentation;
    tablet?: TabletPresentation;
    phone?: PhonePresentation;
  };
  /** Width when right-drawer (desktop / tablet). Defaults to 760. */
  desktopWidth?: number;
  /** Bottom-sheet height as fraction of viewport (tablet / phone). Defaults to 0.85. */
  tabletSheetHeight?: number;
  children: React.ReactNode;
  /** Optional sticky header. */
  header?: React.ReactNode;
  /** Optional sticky footer. */
  footer?: React.ReactNode;
  /** ARIA label for screen readers. */
  accessibilityLabel?: string;
}

type Resolved = {
  shape: 'right-drawer' | 'bottom-sheet' | 'fullscreen' | 'center-modal';
  /** Anchor side for the slide animation. */
  slideFrom: 'right' | 'bottom' | 'none';
};

function resolvePresentation(
  bp: 'phone' | 'tablet' | 'desktop',
  presentation: ResponsiveSheetProps['presentation'],
): Resolved {
  if (bp === 'desktop') {
    const p = presentation?.desktop ?? 'right-drawer';
    return p === 'center-modal'
      ? { shape: 'center-modal', slideFrom: 'none' }
      : { shape: 'right-drawer', slideFrom: 'right' };
  }
  if (bp === 'tablet') {
    const p = presentation?.tablet ?? 'bottom-sheet';
    return p === 'right-drawer'
      ? { shape: 'right-drawer', slideFrom: 'right' }
      : { shape: 'bottom-sheet', slideFrom: 'bottom' };
  }
  // phone
  const p = presentation?.phone ?? 'fullscreen';
  return p === 'bottom-sheet'
    ? { shape: 'bottom-sheet', slideFrom: 'bottom' }
    : { shape: 'fullscreen', slideFrom: 'bottom' };
}

export const ResponsiveSheet: React.FC<ResponsiveSheetProps> = ({
  visible,
  onClose,
  presentation,
  desktopWidth = 760,
  tabletSheetHeight = 0.85,
  children,
  header,
  footer,
  accessibilityLabel,
}) => {
  const C = useCmdColors();
  const bp = useBreakpoint();
  const isPhone = useIsPhone();
  const insets = useSafeAreaInsets();
  const { width: vw, height: vh } = useWindowDimensions();
  const resolved = resolvePresentation(bp, presentation);

  // Slide animation. Native driver works for `transform` on RN-Web 0.21
  // (verified — RNW translates to CSS transform). Initial value is the
  // off-screen position; visible=true animates to 0.
  const startOffset = React.useMemo(() => {
    if (resolved.slideFrom === 'right') return desktopWidth;
    if (resolved.slideFrom === 'bottom') return vh;
    return 0;
  }, [resolved.slideFrom, desktopWidth, vh]);
  const anim = React.useRef(new Animated.Value(startOffset)).current;

  React.useEffect(() => {
    if (visible) {
      // Reset to off-screen, then slide in.
      anim.setValue(startOffset);
      Animated.timing(anim, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        // RN-Web has no native animated module — passing true triggers a
        // noisy console warning and falls back to JS anyway. Keep true
        // for native (Phase 3) where it matters.
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
    // We don't run an exit animation here — Modal's own dismissal handles
    // the overall removal. Keeping the effect single-purpose avoids janky
    // double-animation when the parent unmounts the Modal abruptly.
  }, [visible, startOffset, anim]);

  if (!visible) return null;

  // Sheet container styles by shape.
  const sheetStyle: any = (() => {
    if (resolved.shape === 'right-drawer') {
      return {
        width: desktopWidth,
        height: '100%',
        backgroundColor: C.bg,
        borderLeftWidth: 1,
        borderLeftColor: C.borderStrong,
        ...(Platform.OS === 'web'
          ? ({ boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' } as any)
          : {}),
      };
    }
    if (resolved.shape === 'bottom-sheet') {
      const h = Math.round(vh * tabletSheetHeight);
      return {
        width: '100%',
        height: h,
        backgroundColor: C.bg,
        borderTopLeftRadius: CmdRadius.lg,
        borderTopRightRadius: CmdRadius.lg,
        borderTopWidth: 1,
        borderTopColor: C.borderStrong,
        // Bottom safe-area inset only on phone (tablets have no home indicator).
        paddingBottom: isPhone ? insets.bottom : 0,
        overflow: 'hidden',
        ...(Platform.OS === 'web'
          ? ({ boxShadow: '0 -12px 40px rgba(0,0,0,0.22)' } as any)
          : {}),
      };
    }
    if (resolved.shape === 'fullscreen') {
      return {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: C.bg,
        // Phone: respect both safe-area insets.
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      };
    }
    // center-modal
    return {
      width: Math.min(720, vw - 32),
      maxHeight: vh - 64,
      backgroundColor: C.bg,
      borderRadius: CmdRadius.lg,
      borderWidth: 1,
      borderColor: C.borderStrong,
      ...(Platform.OS === 'web'
        ? ({ boxShadow: '0 12px 40px rgba(0,0,0,0.22)' } as any)
        : {}),
    };
  })();

  const transformStyle = (() => {
    if (resolved.slideFrom === 'right') return { transform: [{ translateX: anim }] };
    if (resolved.slideFrom === 'bottom') return { transform: [{ translateY: anim }] };
    return {};
  })();

  // Backdrop layout per shape.
  const backdropLayout: any = (() => {
    if (resolved.shape === 'right-drawer') {
      return { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'stretch' };
    }
    if (resolved.shape === 'bottom-sheet') {
      return { flexDirection: 'column', justifyContent: 'flex-end' };
    }
    if (resolved.shape === 'fullscreen') {
      return { flexDirection: 'column' };
    }
    // center-modal
    return { flexDirection: 'column', justifyContent: 'center', alignItems: 'center' };
  })();

  // Phone fullscreen has no scrim — the sheet IS the screen.
  const backdropColor =
    resolved.shape === 'fullscreen' ? 'transparent' : 'rgba(0,0,0,0.32)';

  const Header = header
    ? <View style={{ flexShrink: 0 }}>{header}</View>
    : null;
  const Footer = footer
    ? <View style={{ flexShrink: 0 }}>{footer}</View>
    : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityLabel={accessibilityLabel}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        accessible={false}
        style={[{ flex: 1, backgroundColor: backdropColor }, backdropLayout]}
      >
        {/* Inner Animated.View — clicks here are NOT supposed to propagate
            to the backdrop's onPress. We wrap with a TouchableOpacity that
            captures touches and does nothing — same pattern as the legacy
            IngredientFormDrawer. */}
        <Animated.View style={[sheetStyle, transformStyle]}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            accessible={false}
            style={{ flex: 1, flexDirection: 'column' }}
          >
            {Header}
            <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
            {Footer}
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
};
