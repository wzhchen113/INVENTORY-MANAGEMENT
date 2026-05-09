import React from 'react';
import { View, Text, Modal, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { StatusPill } from './StatusPill';
import { SectionCaption } from './SectionCaption';
import type { AttentionItem } from '../../lib/cmdSelectors';

interface Props {
  visible: boolean;
  storeName: string;
  /**
   * Architect §4 — the snapshot the selector emitted on the queue row.
   * The modal renders directly from this; it does not re-derive from the
   * store. `undefined` → render nothing (defensive — host should not
   * mount the modal without a payload, but covers the "modal closing,
   * detail just nulled" frame).
   */
  detail: AttentionItem['expiryDetail'];
  onClose: () => void;
}

// Spec 010 §4 — drill-down modal opened from the per-store attention
// queue when a user clicks an `expiry` rule row. Click-to-drill is
// scoped to the expiry rule only in v1 (other rule types stay click-
// inert); broaden later if the pattern reads well.
//
// Pattern reference: AddCountModal.tsx for the centered backdrop +
// click-out shape; AuditHistory.tsx for the per-row table layout. We
// don't add a navigate-to-item link in v1 — read-only list per architect
// §4 ("Add deep-link in a follow-up if the user requests it").
export const ExpiringItemsModal: React.FC<Props> = ({ visible, storeName, detail, onClose }) => {
  const C = useCmdColors();

  // Esc-to-close on web, mirroring the IngredientFormDrawer convention.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible || !detail) return null;

  // sev → StatusPill status mapping. high=danger (out), med=warn (low),
  // low=info — matches the queue-row sev pill bg colors in DashboardSection.
  const pillStatus: 'out' | 'low' | 'info' =
    detail.sev === 'high' ? 'out' : detail.sev === 'med' ? 'low' : 'info';
  const pillLabel = detail.sev === 'high' ? 'HIGH' : detail.sev === 'med' ? 'MED' : 'LOW';
  const sevTone = detail.sev === 'high' ? C.danger : detail.sev === 'med' ? C.warn : C.fg3;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.4)',
          alignItems: 'center',
          paddingTop: '10%',
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            width: 720,
            maxWidth: '94%',
            backgroundColor: C.panel,
            borderWidth: 1,
            borderColor: C.borderStrong,
            borderRadius: CmdRadius.lg,
            ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}),
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: C.panel2,
            }}
          >
            <Text style={{ fontFamily: sans(600), fontSize: 14, color: C.fg }}>
              Expiring soon
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg2 }} numberOfLines={1}>
              {storeName}
            </Text>
            <StatusPill status={pillStatus} label={pillLabel} />
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={onClose}
              style={{
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: CmdRadius.xs,
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>×</Text>
            </TouchableOpacity>
          </View>

          {/* Subhead — aggregate counts */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 9,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>
              {detail.items.length} {detail.items.length === 1 ? 'item' : 'items'}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>·</Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 12,
                color: sevTone,
                fontVariant: ['tabular-nums'],
              }}
            >
              ${detail.totalDollarAtRisk.toFixed(2)}
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>at risk</Text>
          </View>

          {/* Column headers */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 7,
              gap: 10,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              backgroundColor: C.panel2,
            }}
          >
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                flex: 1,
                textTransform: 'uppercase',
              }}
            >
              item
            </Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                width: 130,
                textAlign: 'right',
                textTransform: 'uppercase',
              }}
            >
              expires in
            </Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                width: 80,
                textAlign: 'right',
                textTransform: 'uppercase',
              }}
            >
              unit
            </Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                width: 100,
                textAlign: 'right',
                textTransform: 'uppercase',
              }}
            >
              $ at risk
            </Text>
          </View>

          {/* Item rows */}
          <ScrollView style={{ maxHeight: 420 }}>
            {detail.items.length === 0 ? (
              <View style={{ padding: 28, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                  no items in this bucket
                </Text>
              </View>
            ) : (
              detail.items.map((it, i) => (
                <View
                  key={it.itemId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 9,
                    gap: 10,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                    borderStyle: 'dashed',
                  }}
                >
                  <Text
                    style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg, flex: 1 }}
                    numberOfLines={1}
                  >
                    {it.itemName}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(500),
                      fontSize: 11.5,
                      color: it.hoursToExpiry <= 0 ? C.danger : it.hoursToExpiry <= 24 ? C.danger : it.hoursToExpiry <= 72 ? C.warn : C.fg2,
                      width: 130,
                      textAlign: 'right',
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {formatHours(it.hoursToExpiry)}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(400),
                      fontSize: 11,
                      color: C.fg3,
                      width: 80,
                      textAlign: 'right',
                    }}
                    numberOfLines={1}
                  >
                    {it.unit || '—'}
                  </Text>
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 11.5,
                      color: C.fg,
                      width: 100,
                      textAlign: 'right',
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    ${it.dollarAtRisk.toFixed(2)}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>

          {/* Footer */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: C.panel2,
            }}
          >
            <SectionCaption tone="fg3" size={9.5}>
              read-only · close to navigate manually
            </SectionCaption>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc to close</Text>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// Human-readable "time to expiry" label. Negative hours → "expired N
// days ago" (rounded down for past, rounded toward zero for sub-day so
// a 12-hours-ago expiry reads as "expired today"). Positive hours →
// "<24h" / "N days" / etc. matching the queue's hour-bucket labels.
function formatHours(hours: number): string {
  if (hours <= 0) {
    const past = Math.abs(hours);
    if (past < 24) return 'expired today';
    const days = Math.floor(past / 24);
    return days === 1 ? 'expired 1 day ago' : `expired ${days} days ago`;
  }
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return h === 1 ? '<1h' : `${h}h`;
  }
  const days = hours / 24;
  if (days < 2) return '~1 day';
  return `${Math.round(days)} days`;
}
