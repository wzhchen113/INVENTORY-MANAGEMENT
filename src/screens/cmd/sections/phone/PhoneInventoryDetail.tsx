// src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx — Spec 142 (chunk b).
//
// The full-screen phone item detail (AC-INV4). Rendered as the `detail` body of
// PhoneDrillScaffold, it REPLACES the desktop DetailPane + detail.tsx/usage.tsx
// tab strip + EDIT/DELETE/+COUNT toolbar wholesale (Hard Rule 4 — none of that
// chrome renders on phone). Reads the same already-mapped `inventory` slice the
// desktop pane reads (no new db.ts surface); money strings come from the ONE
// definition in ../../lib/itemMoney (spec 112 ★ costing rule).

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, sans, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { relativeTime } from '../../../../utils/relativeTime';
import { formatAuditAction } from '../../../../utils/formatAuditAction';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { statusFg } from '../../../../theme/statusColors';
import { StatPanel, GroupCaption, PropertyCard } from './PhoneWidgets';
import { formatCostPerEach, costPerEachLabel, formatStockValue } from '../../lib/itemMoney';
import type { InventoryItem } from '../../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

interface Props {
  item: InventoryItem;
}

export const PhoneInventoryDetail: React.FC<Props> = ({ item }) => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const vendors = useStore((s) => s.vendors);
  const auditLog = useStore((s) => s.auditLog);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const status = getItemStatus(item);
  const statusColor = statusFg(C, status);
  const vendor = vendors.find((v) => v.id === item.vendorId);
  const displayName = getLocalizedName({ name: item.name, i18nNames: item.i18nNames }, locale);

  const parFill = item.parLevel > 0 ? item.currentStock / item.parLevel : 0;
  const suggest = Math.max(0, Math.ceil((item.parLevel - item.currentStock) / (item.caseQty || 1)));
  const daysOfCover = item.averageDailyUsage > 0 ? item.currentStock / item.averageDailyUsage : null;
  const daysTone = daysOfCover === null ? C.fg : daysOfCover < 3 ? C.danger : daysOfCover < 7 ? C.warn : C.ok;

  // Recent counts — the item's audit history, most-recent first (mirrors the
  // desktop activity_log filter, but surfaced as the phone RECENT COUNTS rows).
  const recentCounts = React.useMemo(() => {
    const needle = item.name.toLowerCase();
    return auditLog
      .filter((e: any) => {
        const ref = (e.itemRef || '').toLowerCase();
        return ref === needle || ref === item.id;
      })
      .slice()
      .reverse()
      .slice(0, 6);
  }, [auditLog, item]);

  const goCount = () => {
    usePaletteAction.getState().request({ section: 'EODCount', selectedName: null, eodFocusItemId: item.id });
  };
  const goOrdering = () => {
    usePaletteAction.getState().request({ section: 'Ordering', selectedName: null });
  };

  const propRows: Array<{ label: string; value: string; tone?: string }> = [
    { label: 'CATEGORY', value: item.category },
    { label: 'VENDOR', value: vendor?.name || 'unset' },
    { label: 'CASE PACK', value: `${item.caseQty || '—'} ${item.unit}${item.casePrice ? ` · $${item.casePrice.toFixed(2)}/case` : ''}` },
    { label: 'STOCK VALUE', value: formatStockValue(item) },
    { label: 'AVG DAILY USE', value: `${item.averageDailyUsage} ${item.unit}` },
    { label: 'DAYS OF STOCK', value: daysOfCover === null ? '—' : `${daysOfCover.toFixed(1)}d`, tone: daysTone },
    { label: 'LAST COUNTED', value: relativeTime(item.lastUpdatedAt) || 'never' },
  ];

  return (
    <View style={{ padding: 16, gap: 16 }}>
      {/* Hero: caption + pill + name */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusPill status={status} />
          <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]} numberOfLines={1}>
            {item.category.toUpperCase()} · {shortId(item.id)} · {(vendor?.name || 'NO VENDOR').toUpperCase()}
          </Text>
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{displayName}</Text>
      </View>

      {/* Stat panel — on-hand hero / par, 4px bar, COST · CASE PACK · SUGGEST */}
      <StatPanel
        testID="phone-inv-statpanel"
        hero={
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={[PhoneType.heroValue, { color: statusColor }]}>{item.currentStock}</Text>
            <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>
              / par {item.parLevel} {item.unit}
            </Text>
          </View>
        }
        bar={{ fill: parFill, color: statusColor }}
        cells={[
          { label: 'COST', value: formatCostPerEach(item), tone: 'fg' },
          { label: 'CASE PACK', value: `${item.caseQty || '—'}`, tone: 'fg' },
          { label: 'SUGGEST', value: `${suggest}`, tone: suggest > 0 ? 'accent' : 'fg2' },
        ]}
      />

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          testID="phone-inv-count-now"
          onPress={goCount}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>COUNT NOW</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="phone-inv-view-ordering"
          onPress={goOrdering}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>VIEW IN ORDERING</Text>
        </TouchableOpacity>
      </View>

      {/* Properties */}
      <PropertyCard testID="phone-inv-properties" title="PROPERTIES" rows={propRows} />

      {/* Recent counts */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>RECENT COUNTS</GroupCaption>
        {recentCounts.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>
            no activity recorded
          </Text>
        ) : (
          recentCounts.map((e: any) => (
            <View
              key={e.id}
              style={{ gap: 2, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                  {formatAuditAction(e, T)}
                </Text>
                <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{relativeTime(e.timestamp)}</Text>
              </View>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {e.userName}
                {e.value ? ` · ${e.value}` : ''}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
};
