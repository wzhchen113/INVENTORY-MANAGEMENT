import React from 'react';
import { View, Text, Platform } from 'react-native';
import Svg, { Polyline, Polygon, Line, Circle, Text as SvgText } from 'react-native-svg';
import { useCmdColors } from '../../theme/colors';
import { mono } from '../../theme/typography';

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
  /** Optional Y-axis tick labels, rendered top → bottom on the left edge. */
  yAxisLabels?: string[];
  /** Optional X-axis tick labels, anchored to specific data indices. */
  xAxisLabels?: { atIndex: number; label: string }[];
  /** Web-only: enables hover tooltip over each data point. */
  interactive?: boolean;
  /** Optional formatter for the tooltip value (default: `${v}`). */
  formatTooltip?: (value: number, index: number) => string;
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
  padding,
  yAxisLabels,
  xAxisLabels,
  interactive = false,
  formatTooltip,
}) => {
  const C = useCmdColors();

  // Auto-bump padding when axis labels are requested so the chart still has
  // breathing room from the edges.
  const pad = padding ?? {
    top: 8,
    right: 8,
    bottom: xAxisLabels && xAxisLabels.length > 0 ? 22 : 14,
    left: yAxisLabels && yAxisLabels.length > 0 ? 30 : 8,
  };

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);

  // Pull contiguous (non-null) suffix; nulls only appear before the first
  // EOD observation. Skip them rather than rendering as zero.
  const firstIdx = data.findIndex((v) => v !== null);
  const points = firstIdx === -1 ? [] : (data.slice(firstIdx) as number[]);
  const offsetX = firstIdx === -1 ? 0 : firstIdx;

  const yMaxRaw = Math.max(par * 1.1, ...(points.length ? points : [par]));
  const yMax = yMaxRaw > 0 ? yMaxRaw : 1;

  const xAt = (i: number) => pad.left + ((i + offsetX) / Math.max(1, data.length - 1)) * innerW;
  const yAt = (v: number) => pad.top + (1 - v / yMax) * innerH;

  // Polyline points
  const polylinePoints = points.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ');
  // Filled area: line + bottom corners
  const areaPoints = points.length >= 2
    ? `${xAt(0)},${yAt(0)} ${polylinePoints} ${xAt(points.length - 1)},${yAt(0)}`
    : '';

  // Horizontal grid lines (dashed)
  const gridYs = Array.from({ length: gridLines }, (_, i) =>
    pad.top + ((i + 1) / (gridLines + 1)) * innerH
  );

  const parY = yAt(par);
  const showHover = interactive && Platform.OS === 'web' && hoveredIdx != null && hoveredIdx >= 0 && hoveredIdx < points.length;
  const hoverValue = showHover ? points[hoveredIdx!] : 0;
  const hoverLabel = showHover && xAxisLabels?.find((x) => x.atIndex === hoveredIdx! + offsetX)?.label;
  const tooltipText = showHover
    ? (formatTooltip ? formatTooltip(hoverValue, hoveredIdx! + offsetX) : `${hoverValue}`)
    : '';

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        {/* Y-axis labels — evenly spaced top → bottom */}
        {yAxisLabels && yAxisLabels.length > 0 ? yAxisLabels.map((label, i) => {
          const y = pad.top + (i / Math.max(1, yAxisLabels.length - 1)) * innerH;
          return (
            <SvgText
              key={`yl-${i}`}
              x={pad.left - 6}
              y={y + 3}
              fontSize={9}
              fontFamily={mono(400)}
              fill={C.fg3}
              textAnchor="end"
            >
              {label}
            </SvgText>
          );
        }) : null}
        {/* X-axis labels — anchored to specific data indices */}
        {xAxisLabels && xAxisLabels.length > 0 ? xAxisLabels.map((tick, i) => {
          // Use the global index space: account for offsetX so callers can
          // pass indices into the original (pre-trim) data array.
          const xRel = tick.atIndex - offsetX;
          if (xRel < 0 || xRel >= points.length) return null;
          const x = xAt(xRel);
          return (
            <SvgText
              key={`xl-${i}`}
              x={x}
              y={height - 4}
              fontSize={9}
              fontFamily={mono(400)}
              fill={C.fg3}
              textAnchor={i === 0 ? 'start' : i === xAxisLabels.length - 1 ? 'end' : 'middle'}
            >
              {tick.label}
            </SvgText>
          );
        }) : null}
        {/* Grid */}
        {gridYs.map((y, i) => (
          <Line
            key={`grid-${i}`}
            x1={pad.left}
            x2={width - pad.right}
            y1={y}
            y2={y}
            stroke={C.border}
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}
        {/* Par line (dashed, warn color) */}
        <Line
          x1={pad.left}
          x2={width - pad.right}
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
        {/* Dots — wider invisible hit area on web for hover; visible dot on top */}
        {points.map((v, i) => {
          const isLast = i === points.length - 1;
          const isHovered = i === hoveredIdx;
          return (
            <React.Fragment key={`dot-${i}`}>
              {interactive && Platform.OS === 'web' ? (
                <Circle
                  cx={xAt(i)}
                  cy={yAt(v)}
                  r={9}
                  fill="transparent"
                  // @ts-expect-error react-native-svg-web forwards DOM events
                  onMouseEnter={() => setHoveredIdx(i)}
                  // @ts-expect-error
                  onMouseLeave={() => setHoveredIdx((h) => (h === i ? null : h))}
                />
              ) : null}
              <Circle
                cx={xAt(i)}
                cy={yAt(v)}
                r={isHovered ? 4.5 : isLast ? 3.5 : 1.8}
                fill={C.accent}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      {/* Hover tooltip — web only, absolutely positioned over the SVG */}
      {showHover ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: Math.min(Math.max(xAt(hoveredIdx!) - 50, 0), width - 100),
            top: Math.max(yAt(hoverValue) - 36, 0),
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.borderStrong,
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: 3,
            minWidth: 100,
            alignItems: 'center',
          }}
        >
          {hoverLabel ? (
            <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>{hoverLabel}</Text>
          ) : null}
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg }}>{tooltipText}</Text>
        </View>
      ) : null}
    </View>
  );
};
