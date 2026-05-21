import React from 'react';
import { View, Text, ViewStyle } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { APP_VERSION } from '../../utils/version';

interface Props {
  left?: React.ReactNode;
  right?: React.ReactNode;
  /** Override default 24px height — mobile bottom bar uses 8/12/28 padding. */
  height?: number;
  /** Bottom inset for mobile (clears the iOS home indicator). */
  bottomInset?: number;
  style?: ViewStyle;
}

// Sticky bottom bar. Mono 10 / fg3 by default — children supply their own
// formatting since the design uses both fg3 (default) and accent (for
// "⌘K palette" hint or staff "your shift · 18:42") in different spots.
export const CmdStatusBar: React.FC<Props> = ({
  left,
  right,
  height = 24,
  bottomInset = 0,
  style,
}) => {
  const C = useCmdColors();
  return (
    <View
      style={[
        {
          minHeight: height,
          paddingTop: bottomInset > 0 ? 8 : 0,
          paddingBottom: bottomInset > 0 ? bottomInset : 0,
          paddingHorizontal: 14,
          backgroundColor: C.panel,
          borderTopWidth: 1,
          borderTopColor: C.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>{left}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {right}
        {/* Version pill — always last on the right edge. Source of truth
            is src/utils/version.ts (semver from package.json + git SHA
            injected by Vercel at build time). */}
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 1,
            borderRadius: CmdRadius.xs,
            borderWidth: 1,
            borderColor: C.border,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {APP_VERSION}
          </Text>
        </View>
      </View>
    </View>
  );
};
