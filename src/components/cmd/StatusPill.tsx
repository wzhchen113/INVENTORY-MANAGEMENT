import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { Status, statusFg, statusBg, statusLabel } from '../../theme/statusColors';

interface Props {
  status: Status;
  label?: string;
}

export const StatusPill: React.FC<Props> = ({ status, label }) => {
  const C = useCmdColors();
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.xs,
        backgroundColor: statusBg(C, status),
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 10,
          letterSpacing: 0.5,
          color: statusFg(C, status),
        }}
      >
        {label ?? statusLabel(status)}
      </Text>
    </View>
  );
};
