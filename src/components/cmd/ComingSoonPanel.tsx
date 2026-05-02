import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';

interface Props {
  /** e.g. "usage", "audit", "recipes", "count" — the tab name in lowercase. */
  tabName: string;
}

// Placeholder rendered inside the Item Detail tab strip for tabs other than
// `detail.tsx`. Same caption/border treatment as a real card so the absence
// reads as a deliberate aesthetic, not a bug. Per Phase 5 plan G10.
export const ComingSoonPanel: React.FC<Props> = ({ tabName }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        padding: 16,
        gap: 8,
      }}
    >
      <SectionCaption tone="fg3">status</SectionCaption>
      <Text style={{ fontFamily: mono(600), fontSize: 18, color: C.fg2, letterSpacing: -0.3 }}>
        awaiting design handoff
      </Text>
      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
        tab: {tabName}.tsx
      </Text>
    </View>
  );
};
