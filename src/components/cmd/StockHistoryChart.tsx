import React from 'react';
import { View } from 'react-native';
import Svg, { Polyline, Polygon, Line, Circle } from 'react-native-svg';
import { useCmdColors } from '../../theme/colors';

interface Props {
  /** Series ordered oldest → newest. `null` entries render as gaps. */
  data: Array<number | null>;
  par: number;
  width: number;
  height: number;
  /** Number of horizontal grid lines (4 on desktop, 3 on mobile). */
  gridLines?: number;
  /** Padding inside the SVG so the polyline doesn't touch the edges. */
  padding?: { top: number; right: number; bottom: number; left: number };
}

// Polyline + filled area + dashed par + dashed grid. Hex/rgba accent overlay
// is at 15% opacity (per spec). Final point gets a larger circle (r=3.5) so
// the "today's count" reads as the focal frame.
export const StockHistoryChart: React.FC<Props> = ({
  data,
  par,
  width,
  height,
  gridLines = 4,
  padding = { top: 8, right: 8, bottom: 14, left: 8 },
}) => {
  const C = useCmdColors();

  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  // Pull contiguous (non-null) suffix; nulls only appear before the first
  // EOD observation. Skip them rather than rendering as zero.
  const firstIdx = data.findIndex((v) => v !== null);
  const points = firstIdx === -1 ? [] : (data.slice(firstIdx) as number[]);
  const offsetX = firstIdx === -1 ? 0 : firstIdx;

  const yMaxRaw = Math.max(par * 1.1, ...(points.length ? points : [par]));
  const yMax = yMaxRaw > 0 ? yMaxRaw : 1;

  const xAt = (i: number) => padding.left + ((i + offsetX) / Math.max(1, data.length - 1)) * innerW;
  const yAt = (v: number) => padding.top + (1 - v / yMax) * innerH;

  // Polyline points
  const polylinePoints = points.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  // Filled area: line + bottom corners
  const areaPoints = points.length >= 2
    ? `${xAt(0)},${yAt(0)} ${polylinePoints} ${xAt(points.length - 1)},${yAt(0)}`
    : '';

  // Horizontal grid lines (dashed)
  const gridYs = Array.from({ length: gridLines }, (_, i) =>
    padding.top + ((i + 1) / (gridLines + 1)) * innerH
  );

  const parY = yAt(par);

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        {/* Grid */}
        {gridYs.map((y, i) => (
          <Line
            key={`grid-${i}`}
            x1={padding.left}
            x2={width - padding.right}
            y1={y}
            y2={y}
            stroke={C.border}
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}
        {/* Par line (dashed, warn color) */}
        <Line
          x1={padding.left}
          x2={width - padding.right}
          y1={parY}
          y2={parY}
          stroke={C.warn}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* Filled area under polyline */}
        {areaPoints ? (
          <Polygon points={areaPoints} fill={C.accent} fillOpacity={0.15} stroke="none" />
        ) : null}
        {/* Polyline */}
        {polylinePoints ? (
          <Polyline
            points={polylinePoints}
            fill="none"
            stroke={C.accent}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {/* Dots */}
        {points.map((v, i) => (
          <Circle
            key={`dot-${i}`}
            cx={xAt(i)}
            cy={yAt(v)}
            r={i === points.length - 1 ? 3.5 : 1.8}
            fill={C.accent}
          />
        ))}
      </Svg>
    </View>
  );
};
