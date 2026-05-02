import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { Avatar } from './Avatar';

interface Props {
  /** Relative time string already formatted ("12m" / "1h"). */
  ago: string;
  userName: string;
  /** Optional explicit initials; falls back to first letters of userName. */
  initials?: string;
  action: string;
  /** Optional target (e.g. "24 items", "1.2 lb salmon") rendered after action. */
  target?: string;
}

const inferInitials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

// Timestamp (mono 10 fg3, 32px) + 18×18 avatar + sans 12 "<who> <action>".
export const ActivityRow: React.FC<Props> = ({ ago, userName, initials, action, target }) => {
  const C = useCmdColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, width: 32 }}>{ago}</Text>
      <Avatar initials={initials ?? inferInitials(userName)} />
      <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>
        <Text style={{ fontFamily: sans(600) }}>{userName}</Text>
        {' '}
        {action}
        {target ? <Text style={{ color: C.fg2 }}> {target}</Text> : null}
      </Text>
    </View>
  );
};
