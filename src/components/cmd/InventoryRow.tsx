import React from 'react';
import { TouchableOpacity, View, Text } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { Status } from '../../theme/statusColors';
import { StatusDot } from './StatusDot';
import { ParBar } from './ParBar';

export interface InventoryRowItem {
  id: string;          // e.g. "i03"
  name: string;        // e.g. "Atlantic salmon"
  stock: number;
  par: number;
  unit: string;        // e.g. "lb"
  category: string;    // e.g. "Seafood"
}

interface Props {
  item: InventoryRowItem;
  selected?: boolean;
  /** Desktop list pane uses 2px left accent border; mobile list uses 3px. */
  selectedBorderWidth?: 2 | 3;
  onPress?: () => void;
}

const statusFor = (stock: number, par: number): Status =>
  stock <= 0 ? 'out' : stock < par ? 'low' : 'ok';

// Real items use UUIDs; the design mock uses short tokens (i03). Show a
// 6-char prefix on long ids so the row stays compact.
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Two-line row used in both desktop list pane and mobile list.
// Top: status dot · name (sans 13/600) · ID (mono 10 fg3)
// Bottom: qty/par (mono tabular) · 3px par-bar · category right-aligned
// Selected = accentBg fill + N px solid accent left border.
export const InventoryRow: React.FC<Props> = ({
  item,
  selected,
  selectedBorderWidth = 2,
  onPress,
}) => {
  const C = useCmdColors();
  const status = statusFor(item.stock, item.par);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        paddingVertical: 10,
        paddingLeft: 16 - (selected ? selectedBorderWidth : 0),
        paddingRight: 16,
        borderLeftWidth: selected ? selectedBorderWidth : 0,
        borderLeftColor: C.accent,
        backgroundColor: selected ? C.accentBg : 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusDot status={status} />
        <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[Type.kbd, { color: C.fg3 }]}>{shortId(item.id)}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={[Type.tableNum, { color: C.fg2, minWidth: 90 }]}>
          {item.stock}/{item.par} {item.unit}
        </Text>
        <View style={{ flex: 1 }}>
          <ParBar stock={item.stock} par={item.par} />
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, textAlign: 'right' }}>
          {item.category}
        </Text>
      </View>
    </TouchableOpacity>
  );
};
