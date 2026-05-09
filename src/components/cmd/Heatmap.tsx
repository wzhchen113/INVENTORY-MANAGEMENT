import React from 'react';
import { View, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';

export interface HeatmapRow {
  /** Free-form row label, mono fg2. */
  label: string;
  /** Length must equal dayLabels.length. */
  values: number[];
}

interface HeatmapThresholds {
  /** >= this -> danger */
  danger: number;
  /** >= this -> deep warn (rendered as warn @ 0.85 opacity per Decision D1) */
  deepWarn: number;
  /** >= this -> warn */
  warn: number;
  /** |value| < this -> neutral */
  neutral: number;
  /** <= this -> ok */
  ok: number;
}

interface HeatmapProps {
  rows: HeatmapRow[];
  /** Column headers; e.g. ['Sa','Su','Mo','Tu','We','Th','Fr']. */
  dayLabels: string[];
  /** Defaults match handoff README's heatColor() thresholds. */
  thresholds?: HeatmapThresholds;
  /** Cell height in px. Default 30. */
  cellHeight?: number;
  /** Width of the leftmost label column in px. Default 72. */
  labelWidth?: number;
}

const DEFAULT_THRESHOLDS: HeatmapThresholds = {
  danger: 2.5,
  deepWarn: 1.5,
  warn: 0.5,
  neutral: 0.5,
  ok: -0.5,
};

// Architect §4 / Decision D1: collapse handoff's deep-amber tone to C.warn at
// two opacity levels (0.85 vs 0.65) so we don't add a new palette token.
//
// Bins (per architect's table, vv = cell value in pp):
//   vv >= 2.5            -> C.danger   @ 1.00, white text
//   1.5 <= vv < 2.5      -> C.warn     @ 0.85, white text
//   0.5 <= vv < 1.5      -> C.warn     @ 0.65, white text
//   -0.5 < vv < 0.5      -> C.fg3      @ 0.35, fg text
//   vv <= -0.5           -> C.ok       @ 0.55, fg text
function cellPaint(
  vv: number,
  th: HeatmapThresholds,
  C: ReturnType<typeof useCmdColors>,
): { bg: string; opacity: number; fg: string } {
  if (vv >= th.danger) return { bg: C.danger, opacity: 1.0, fg: '#fff' };
  if (vv >= th.deepWarn) return { bg: C.warn, opacity: 0.85, fg: '#fff' };
  if (vv >= th.warn) return { bg: C.warn, opacity: 0.65, fg: '#fff' };
  if (vv > -th.neutral) return { bg: C.fg3, opacity: 0.35, fg: C.fg };
  return { bg: C.ok, opacity: 0.55, fg: C.fg };
}

// Pure presentational. Architect §4: View-grid (no SVG) — matches the pattern
// used by ReconTimelineTab's 90-day calendar grid. RN doesn't support CSS
// `display: grid`, so layout is row-of-rows: a header row of day labels +
// one row per HeatmapRow (label cell + N flex:1 value cells).
export const Heatmap: React.FC<HeatmapProps> = ({
  rows,
  dayLabels,
  thresholds = DEFAULT_THRESHOLDS,
  cellHeight = 30,
  labelWidth = 72,
}) => {
  const C = useCmdColors();
  const gap = 3;

  return (
    <View>
      {/* Header row: empty label cell + day labels */}
      <View style={{ flexDirection: 'row', gap, marginBottom: gap, alignItems: 'center' }}>
        <View style={{ width: labelWidth }} />
        {dayLabels.map((d) => (
          <View key={d} style={{ flex: 1, alignItems: 'center' }}>
            <Text
              style={{
                fontFamily: mono(600),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              {d}
            </Text>
          </View>
        ))}
      </View>
      {/* Data rows */}
      {rows.map((row, rIdx) => (
        <View
          key={`${row.label}-${rIdx}`}
          style={{ flexDirection: 'row', gap, marginBottom: gap, alignItems: 'center' }}
        >
          <Text
            style={{
              fontFamily: mono(500),
              fontSize: 11,
              color: C.fg2,
              width: labelWidth,
              paddingRight: 6,
            }}
            numberOfLines={1}
          >
            {row.label}
          </Text>
          {row.values.map((vv, i) => {
            const paint = cellPaint(vv, thresholds, C);
            return (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: cellHeight,
                  borderRadius: CmdRadius.xs,
                  backgroundColor: paint.bg,
                  opacity: paint.opacity,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(600),
                    fontSize: 10.5,
                    color: paint.fg,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {vv > 0 ? '+' : ''}{vv.toFixed(1)}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
};
