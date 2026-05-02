import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { Status, statusFg } from '../../theme/statusColors';

interface Props {
  stock: number;
  par: number;
  width?: number | `${number}%`;
  style?: ViewStyle;
}

const statusFor = (stock: number, par: number): Status =>
  stock <= 0 ? 'out' : stock < par ? 'low' : 'ok';

// 3px track radius 99 on panel2; fill = min(stock/par, 1) in status color.
// par=0 reads as "no par configured" → empty track, no fill.
export const ParBar: React.FC<Props> = ({ stock, par, width = '100%', style }) => {
  const C = useCmdColors();
  const ratio = par > 0 ? Math.min(Math.max(stock / par, 0), 1) : 0;
  const status = statusFor(stock, par);
  return (
    <View
      style={[
        { width, height: 3, borderRadius: 99, backgroundColor: C.panel2, overflow: 'hidden' },
        style,
      ]}
    >
      <View
        style={{
          width: `${ratio * 100}%`,
          height: '100%',
          backgroundColor: statusFg(C, status),
        }}
      />
    </View>
  );
};
