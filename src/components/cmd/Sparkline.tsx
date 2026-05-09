import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface SparklineProps {
  /** Oldest -> newest. Length 2-30. Empty / single-point input renders an
   *  empty <Svg> at the requested size — never throws. */
  values: number[];
  /** Hex or rgb(); usually a token from useCmdColors() (ok/warn/danger/fg3). */
  color: string;
  width?: number;
  height?: number;
  /** When true, render an area fill at 12% opacity below the polyline. */
  fill?: boolean;
}

// Pure presentational SVG sparkline. No state, no theming hook, no platform
// branch — the project already uses react-native-svg directly elsewhere
// (StockHistoryChart) and it ships clean on react-native-web. Architect §3.
export const Sparkline: React.FC<SparklineProps> = ({
  values,
  color,
  width = 88,
  height = 22,
  fill = false,
}) => {
  if (!values || values.length < 2) {
    return <Svg width={width} height={height} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (height - ((v - min) / range) * height).toFixed(1);
    return `${x},${y}`;
  });
  const path = `M ${pts.join(' L ')}`;
  const fillPath = fill ? `${path} L ${width},${height} L 0,${height} Z` : null;
  return (
    <Svg width={width} height={height}>
      {fillPath ? <Path d={fillPath} fill={color} fillOpacity={0.12} /> : null}
      <Path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
};
