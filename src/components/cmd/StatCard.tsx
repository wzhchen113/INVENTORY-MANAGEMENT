import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { Type } from '../../theme/typography';

interface Props {
  label: string;
  value: string;
  sub?: string;
  /** Mobile uses a tighter type ramp (kpi*Mobile). Default desktop. */
  compact?: boolean;
}

// 4-up on desktop, 2x2 on mobile detail. panel bg, 1px border, radius 6,
// padding 12/14. label = mono caps fg3, value = mono tabular weight 600,
// sub = mono fg3. Spec lives in handoff README §"Stat grid".
export const StatCard: React.FC<Props> = ({ label, value, sub, compact = false }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        paddingVertical: 12,
        paddingHorizontal: 14,
        flex: 1,
        minWidth: 110,
      }}
    >
      <Text style={[compact ? Type.kpiLabelMobile : Type.kpiLabelDesktop, { color: C.fg3 }]}>
        {label}
      </Text>
      <Text
        style={[
          compact ? Type.kpiValueMobile : Type.kpiValueDesktop,
          { color: C.fg, marginTop: 4 },
        ]}
      >
        {value}
      </Text>
      {sub ? (
        <Text style={{ fontFamily: Type.tableNum.fontFamily, fontSize: 10, color: C.fg3, marginTop: 2 }}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
};
