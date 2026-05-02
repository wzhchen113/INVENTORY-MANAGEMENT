import React from 'react';
import { View, ViewStyle } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { Status, statusFg } from '../../theme/statusColors';

interface Props {
  status: Status;
  size?: 6 | 7;
  style?: ViewStyle;
}

export const StatusDot: React.FC<Props> = ({ status, size = 6, style }) => {
  const C = useCmdColors();
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: statusFg(C, status),
          flexShrink: 0,
        },
        style,
      ]}
    />
  );
};
