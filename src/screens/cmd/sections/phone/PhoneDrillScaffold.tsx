// src/screens/cmd/sections/phone/PhoneDrillScaffold.tsx
//
// Spec 142 §2 (AC-D1…D4) — the ONE shared phone drill-in scaffold. Generalizes
// the Brands full-screen-on-demand idiom (BrandsSection.tsx:225) but improves it
// on one axis: Brands UNMOUNTS its list when showing a detail, losing scroll.
// AC-D4 requires back-restores-scroll, so this scaffold keeps the list MOUNTED
// (flex:1) and overlays the detail as an absolutely-positioned, slide-in
// `Animated.View`. Because the list is never unmounted, its scroll survives.
//
// Animation: RN `Animated` translateX 100%→0 over 220ms ease-out — the same
// idiom as the spec-140 ResponsiveSheet (NOT Reanimated-on-web, NOT @gorhom).
// Exit is immediate (the parent clears `selected`, unmounting the overlay), the
// same single-purpose approach ResponsiveSheet takes for its own dismissal.

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  Easing,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useCmdColors } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';

interface PhoneDetailHeaderProps {
  /** Mono, upper, parent-screen caption — e.g. "INVENTORY" | "VENDORS" | "MENU". */
  parentCaption: string;
  /** Back handler — calls usePhoneDrill().close(). */
  onBack: () => void;
  /** Back-button accessibility label. Defaults to "Back". */
  backLabel?: string;
}

// 52px header with a 44px ← back control and the mono parent-name caption
// (AC-D3). Exported for reuse/testing.
export const PhoneDetailHeader: React.FC<PhoneDetailHeaderProps> = ({
  parentCaption,
  onBack,
  backLabel = 'Back',
}) => {
  const C = useCmdColors();
  return (
    <View
      testID="phone-detail-header"
      style={{
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        gap: 6,
        backgroundColor: C.panel,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
      }}
    >
      <TouchableOpacity
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 20, color: C.fg2 }}>←</Text>
      </TouchableOpacity>
      <Text
        numberOfLines={1}
        style={[PhoneType.caption, { color: C.fg3, flex: 1 }]}
      >
        {parentCaption}
      </Text>
    </View>
  );
};

interface PhoneDrillScaffoldProps {
  /** The full-width FlatList/SectionList. ALWAYS mounted (scroll survives). */
  list: React.ReactNode;
  /** Full-screen detail body when a row is open; null renders the list only. */
  detail: React.ReactNode | null;
  /** Mono upper caption naming the parent screen — e.g. "INVENTORY". */
  parentCaption: string;
  /** Back handler — calls usePhoneDrill().close(). */
  onBack: () => void;
  /** Back-button accessibility label. */
  backLabel?: string;
  testID?: string;
}

export const PhoneDrillScaffold: React.FC<PhoneDrillScaffoldProps> = ({
  list,
  detail,
  parentCaption,
  onBack,
  backLabel,
  testID,
}) => {
  const C = useCmdColors();
  const { width: vw } = useWindowDimensions();
  const hasDetail = detail !== null;

  // Slide-in-right: off-screen (vw) → 0 over 220ms whenever a detail appears.
  const anim = React.useRef(new Animated.Value(vw)).current;
  React.useEffect(() => {
    if (hasDetail) {
      anim.setValue(vw);
      Animated.timing(anim, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        // RN-Web has no native animated module; keep true for native only.
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [hasDetail, vw, anim]);

  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: C.bg }}>
      {/* List stays mounted underneath so back restores its scroll position. */}
      <View style={{ flex: 1 }}>{list}</View>

      {hasDetail ? (
        <Animated.View
          testID="phone-drill-detail"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: C.bg,
            transform: [{ translateX: anim }],
          }}
        >
          <PhoneDetailHeader parentCaption={parentCaption} onBack={onBack} backLabel={backLabel} />
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            {detail}
          </ScrollView>
        </Animated.View>
      ) : null}
    </View>
  );
};
