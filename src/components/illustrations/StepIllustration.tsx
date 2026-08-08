// src/components/illustrations/StepIllustration.tsx — Spec 154.
//
// A stylized, drawn picture of the phone (or the desktop browser window) at one
// step of the Add-to-Home-Screen tutorial. Replaces nothing: it sits under the
// spec-153 step row and shows WHERE the control the prose names actually is.
//
// Deliberate shape (spec 154 §2 — all five points are binding):
//
//   1. Colors arrive as a `palette` PROP, never from a theme hook. The same
//      component renders on the admin Cmd surface (useCmdColors → reads
//      useStore) and inside the staff subtree (which may never import useStore,
//      spec 063). Each surface maps its own tokens into the ten semantic slots.
//      There is no color literal in this file.
//   2. Labels arrive as a `labels` PROP, never from a catalog — same reason
//      (two independent catalog trees). Each surface resolves
//      `chrome.installGuide.art.*` through its own `t`.
//   3. Hybrid SVG + RN <Text>: shapes are react-native-svg primitives, the five
//      translatable labels are absolutely-positioned RN Text over the <Svg>.
//      They deliberately use the SYSTEM font on both surfaces (no mono, even on
//      the Cmd surface): they depict OS chrome, which is proportional, and the
//      admin's mono face is wide enough that "Add to Home Screen" would
//      ellipsize inside the drawn row.
//      react-native-svg's own <Text> neither wraps nor ellipsizes and resolves
//      fonts differently on web vs native, while the es / zh-CN label
//      expansions have to clip gracefully. Both layers derive from ONE `scale`,
//      so the overlay cannot drift from the drawing.
//   4. Scales to the caller's `width`: every coordinate below is authored in the
//      art's base viewBox and multiplied by that single scale. No onLayout, so
//      the first render is already correct (and jest sees the labels).
//   5. Complete by construction: ART is Record<InstallArt, ArtSpec>, so a new
//      InstallArt member fails `npx tsc --noEmit` until it is drawn.
//
// NOT a UI clone: no vendor logo, wordmark or brand color — these are shapes in
// this app's palette that SUGGEST the OS chrome, plus the OS's real (localized)
// label text. Bitmap screenshots stay rejected (spec 153 §"Screenshots", Q7).

import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { InstallArt } from '../../lib/installGuide';

// ── Public surface ───────────────────────────────────────────────────

/** The ten semantic color slots an illustration draws with. Each surface maps
 *  its own token set onto these — see the two call sites. */
export interface StepIllustrationPalette {
  /** Phone body / bezel. */
  frame: string;
  /** The screen (page background). */
  screen: string;
  /** Browser chrome, sheets and dialogs — one step off `screen`. */
  chrome: string;
  /** Placeholder page content (de-emphasized). */
  line: string;
  /** Hairlines. */
  border: string;
  /** Primary marks + label text. */
  ink: string;
  /** Secondary marks (un-highlighted controls). */
  ink2: string;
  /** The highlight stroke — the control the step is about. */
  highlight: string;
  /** Soft fill behind a highlighted row / control. */
  highlightBg: string;
  /** Text/marks drawn ON a `highlight` fill. */
  highlightInk: string;
}

/** The OS's real labels. Translatable; sourced from `chrome.installGuide.art.*`
 *  in the calling surface's own catalog. `appName` is the manifest
 *  `short_name` and is kept verbatim in every locale. */
export interface StepIllustrationLabels {
  appName: string;
  addToHomeScreen: string;
  add: string;
  installApp: string;
  install: string;
}

export interface StepIllustrationProps {
  art: InstallArt;
  /** Rendered width in px. Height follows the art's aspect ratio. */
  width: number;
  palette: StepIllustrationPalette;
  labels: StepIllustrationLabels;
  testID?: string;
}

// ── Internal spec types ──────────────────────────────────────────────

type LabelId = keyof StepIllustrationLabels;
type InkSlot = 'ink' | 'ink2' | 'highlight' | 'highlightInk';

interface LabelSpec {
  id: LabelId;
  /** Left edge, base units. */
  x: number;
  /** Vertical CENTER, base units. */
  cy: number;
  /** Box width, base units — the label ellipsizes inside it. */
  w: number;
  /** Font size, base units. */
  size: number;
  align: 'left' | 'center';
  color: InkSlot;
}

interface ArtSpec {
  /** Base viewBox. */
  w: number;
  h: number;
  draw: (P: StepIllustrationPalette) => React.ReactNode;
  labels: LabelSpec[];
}

// ── Drawing helpers ──────────────────────────────────────────────────

const stroke = (color: string, w = 1.3) =>
  ({
    stroke: color,
    strokeWidth: w,
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }) as const;

/** Phone base viewBox. */
const PW = 124;
const PH = 176;
/** Desktop-window base viewBox. */
const DW = 176;
const DH = 112;

/** Body + screen + earpiece. Drawn first in every phone art. */
function phoneShell(P: StepIllustrationPalette) {
  return (
    <>
      <Rect x={12} y={2} width={100} height={172} rx={13} fill={P.frame} stroke={P.border} strokeWidth={1} />
      <Rect x={17} y={9} width={90} height={158} rx={8} fill={P.screen} />
      <Rect x={54} y={12} width={16} height={2.5} rx={1.25} fill={P.frame} />
    </>
  );
}

/** The home indicator. Drawn LAST so it floats over sheets and dialogs, the
 *  way it does on a real device. */
function homeIndicator(P: StepIllustrationPalette) {
  return <Rect x={47} y={162.5} width={30} height={2.5} rx={1.25} fill={P.line} opacity={0.6} />;
}

/** Generic page content, so the screen never reads as blank. */
function pageContent(P: StepIllustrationPalette, y0: number) {
  return (
    <>
      <Rect x={23} y={y0} width={52} height={6} rx={2} fill={P.line} opacity={0.8} />
      <Rect x={23} y={y0 + 12} width={78} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={23} y={y0 + 20} width={70} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={23} y={y0 + 28} width={76} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={23} y={y0 + 40} width={78} height={24} rx={4} fill={P.chrome} />
      <Rect x={23} y={y0 + 72} width={64} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
    </>
  );
}

/** Dim the screen behind a sheet / dialog. */
function scrim(P: StepIllustrationPalette, x: number, y: number, w: number, h: number, rx: number) {
  return <Rect x={x} y={y} width={w} height={h} rx={rx} fill={P.ink} opacity={0.16} />;
}

/** The app icon — a rounded accent tile with an abstract three-bar mark. No
 *  bitmap, no logo file (AC-7). */
function appIcon(P: StepIllustrationPalette, x: number, y: number, s: number) {
  const bw = s * 0.11;
  return (
    <>
      <Rect x={x} y={y} width={s} height={s} rx={s * 0.26} fill={P.highlight} />
      <Rect x={x + s * 0.24} y={y + s * 0.26} width={bw} height={s * 0.48} rx={bw / 2} fill={P.highlightInk} />
      <Rect x={x + s * 0.44} y={y + s * 0.26} width={bw} height={s * 0.48} rx={bw / 2} fill={P.highlightInk} />
      <Rect x={x + s * 0.64} y={y + s * 0.42} width={bw} height={s * 0.32} rx={bw / 2} fill={P.highlightInk} />
    </>
  );
}

/** iOS Safari's bottom bar: address pill + the five toolbar controls.
 *  `highlightPill` marks the address bar (step 1); `highlightShare` rings the
 *  Share control (step 2). */
function safariBar(
  P: StepIllustrationPalette,
  opts: { highlightPill?: boolean; highlightShare?: boolean } = {},
) {
  const shareInk = opts.highlightShare ? P.highlight : P.ink2;
  return (
    <>
      <Rect x={17} y={124} width={90} height={43} fill={P.chrome} />
      <Rect x={17} y={124} width={90} height={0.8} fill={P.border} />
      <Rect
        x={25}
        y={128}
        width={74}
        height={13}
        rx={6.5}
        fill={opts.highlightPill ? P.highlightBg : P.screen}
        stroke={opts.highlightPill ? P.highlight : P.border}
        strokeWidth={opts.highlightPill ? 1.5 : 1}
      />
      {/* back / forward */}
      <Path d="M 31 148.5 L 27 152.5 L 31 156.5" {...stroke(P.ink2)} />
      <Path d="M 43 148.5 L 47 152.5 L 43 156.5" {...stroke(P.ink2)} />
      {/* share: an open-top box with an up arrow */}
      {opts.highlightShare ? (
        <Circle cx={62} cy={152.5} r={11} fill={P.highlightBg} stroke={P.highlight} strokeWidth={1.4} />
      ) : null}
      <Path d="M 57.5 152 L 57.5 158.5 L 66.5 158.5 L 66.5 152" {...stroke(shareInk)} />
      <Path d="M 62 157 L 62 146.6" {...stroke(shareInk)} />
      <Path d="M 58.9 149.6 L 62 146.4 L 65.1 149.6" {...stroke(shareInk)} />
      {/* bookmarks / tabs */}
      <Rect x={75} y={148.5} width={8} height={8} rx={1.2} {...stroke(P.ink2, 1.1)} />
      <Path d="M 77.6 148.5 L 77.6 156.5" {...stroke(P.ink2, 1.1)} />
      <Rect x={90.5} y={148.5} width={7} height={7} rx={1.2} {...stroke(P.ink2, 1.1)} />
      {/* the front tab is opaque, so it must override the helper's fill:none */}
      <Rect x={93.5} y={151.5} width={7} height={7} rx={1.2} {...stroke(P.ink2, 1.1)} fill={P.chrome} />
    </>
  );
}

/** Android Chrome's top bar: address pill + the ⋮ overflow control. */
function chromeBar(P: StepIllustrationPalette, opts: { highlightMenu?: boolean } = {}) {
  const dotInk = opts.highlightMenu ? P.highlight : P.ink2;
  return (
    <>
      <Rect x={17} y={9} width={90} height={28} rx={8} fill={P.chrome} />
      <Rect x={17} y={25} width={90} height={12} fill={P.chrome} />
      <Rect x={17} y={37} width={90} height={0.8} fill={P.border} />
      <Rect x={23} y={15} width={62} height={14} rx={7} fill={P.screen} stroke={P.border} strokeWidth={1} />
      {opts.highlightMenu ? (
        <Circle cx={95} cy={22} r={10} fill={P.highlightBg} stroke={P.highlight} strokeWidth={1.4} />
      ) : null}
      <Circle cx={95} cy={17.5} r={1.5} fill={dotInk} />
      <Circle cx={95} cy={22} r={1.5} fill={dotInk} />
      <Circle cx={95} cy={26.5} r={1.5} fill={dotInk} />
    </>
  );
}

/** The desktop browser window: tab strip, omnibox with the install icon, page. */
function desktopWindow(P: StepIllustrationPalette, opts: { highlightInstall?: boolean } = {}) {
  const iconInk = opts.highlightInstall ? P.highlight : P.ink2;
  return (
    <>
      <Rect x={2} y={2} width={172} height={108} rx={8} fill={P.chrome} stroke={P.border} strokeWidth={1} />
      <Circle cx={12} cy={11} r={2.5} fill={P.line} opacity={0.7} />
      <Circle cx={20} cy={11} r={2.5} fill={P.line} opacity={0.7} />
      <Circle cx={28} cy={11} r={2.5} fill={P.line} opacity={0.7} />
      <Rect x={38} y={5} width={58} height={13} rx={3} fill={P.screen} stroke={P.border} strokeWidth={1} />
      {/* omnibox */}
      <Rect x={10} y={22} width={130} height={14} rx={7} fill={P.screen} stroke={P.border} strokeWidth={1} />
      <Rect x={18} y={27.5} width={62} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
      {opts.highlightInstall ? (
        <Circle cx={130} cy={29} r={9.5} fill={P.highlightBg} stroke={P.highlight} strokeWidth={1.4} />
      ) : null}
      <Circle cx={130} cy={29} r={5} {...stroke(iconInk, 1.2)} />
      <Path d="M 127 29 L 133 29" {...stroke(iconInk, 1.2)} />
      <Path d="M 130 26 L 130 32" {...stroke(iconInk, 1.2)} />
      <Circle cx={156} cy={25.5} r={1.5} fill={P.ink2} />
      <Circle cx={156} cy={29} r={1.5} fill={P.ink2} />
      <Circle cx={156} cy={32.5} r={1.5} fill={P.ink2} />
      {/* page */}
      <Rect x={8} y={40} width={160} height={66} rx={4} fill={P.screen} />
      <Rect x={16} y={48} width={60} height={5} rx={2} fill={P.line} opacity={0.8} />
      <Rect x={16} y={60} width={140} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={16} y={68} width={126} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={16} y={76} width={134} height={3.5} rx={1.75} fill={P.line} opacity={0.4} />
      <Rect x={16} y={86} width={144} height={14} rx={3} fill={P.chrome} />
    </>
  );
}

// ── The nine arts ────────────────────────────────────────────────────

const ART: Record<InstallArt, ArtSpec> = {
  // 1 — "Open this page in Safari": the address bar is the cue.
  'ios-safari': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {pageContent(P, 24)}
        {safariBar(P, { highlightPill: true })}
        {homeIndicator(P)}
      </>
    ),
    labels: [{ id: 'appName', x: 27, cy: 134.5, w: 70, size: 7, align: 'center', color: 'ink' }],
  },

  // 2 — "Tap the Share button": the toolbar control is ringed.
  'ios-share': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {pageContent(P, 24)}
        {safariBar(P, { highlightShare: true })}
        {homeIndicator(P)}
      </>
    ),
    labels: [{ id: 'appName', x: 27, cy: 134.5, w: 70, size: 7, align: 'center', color: 'ink2' }],
  },

  // 3 — the share sheet, "Add to Home Screen" row highlighted.
  'ios-share-sheet': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {pageContent(P, 24)}
        {safariBar(P)}
        {scrim(P, 17, 9, 90, 158, 8)}
        <Rect x={17} y={54} width={90} height={113} rx={10} fill={P.chrome} />
        <Rect x={57} y={58} width={10} height={2} rx={1} fill={P.line} opacity={0.7} />
        <Rect x={23} y={66} width={38} height={4} rx={2} fill={P.line} opacity={0.55} />
        {/* the share sheet's app row */}
        <Rect x={24} y={76} width={16} height={16} rx={4} fill={P.screen} stroke={P.border} strokeWidth={1} />
        <Rect x={44} y={76} width={16} height={16} rx={4} fill={P.screen} stroke={P.border} strokeWidth={1} />
        <Rect x={64} y={76} width={16} height={16} rx={4} fill={P.screen} stroke={P.border} strokeWidth={1} />
        <Rect x={84} y={76} width={16} height={16} rx={4} fill={P.screen} stroke={P.border} strokeWidth={1} />
        <Rect x={17} y={100} width={90} height={0.8} fill={P.border} />
        {/* an ordinary row above… */}
        <Rect x={24} y={106} width={11} height={11} rx={3} fill={P.line} opacity={0.35} />
        <Rect x={41} y={110} width={40} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        {/* …the row this step is about… */}
        <Rect
          x={21}
          y={122}
          width={82}
          height={20}
          rx={5}
          fill={P.highlightBg}
          stroke={P.highlight}
          strokeWidth={1.4}
        />
        <Rect x={25} y={127.5} width={9} height={9} rx={2.3} {...stroke(P.highlight, 1.2)} />
        <Path d="M 27.2 132 L 31.8 132" {...stroke(P.highlight, 1.2)} />
        <Path d="M 29.5 129.7 L 29.5 134.3" {...stroke(P.highlight, 1.2)} />
        {/* …and one below. */}
        <Rect x={24} y={148} width={11} height={11} rx={3} fill={P.line} opacity={0.35} />
        <Rect x={41} y={152} width={34} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        {homeIndicator(P)}
      </>
    ),
    labels: [{ id: 'addToHomeScreen', x: 37, cy: 132, w: 64, size: 6.5, align: 'left', color: 'ink' }],
  },

  // 4 — the Add dialog: icon + name + the Add button.
  'ios-add-confirm': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {pageContent(P, 24)}
        {safariBar(P)}
        {scrim(P, 17, 9, 90, 158, 8)}
        <Rect x={21} y={44} width={82} height={78} rx={10} fill={P.chrome} stroke={P.border} strokeWidth={1} />
        <Rect x={21} y={62} width={82} height={0.8} fill={P.border} />
        {appIcon(P, 29, 70, 20)}
        <Rect x={55} y={83} width={34} height={3} rx={1.5} fill={P.line} opacity={0.45} />
        <Rect x={29} y={105.5} width={18} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={63} y={100} width={34} height={14} rx={7} fill={P.highlight} />
        {homeIndicator(P)}
      </>
    ),
    labels: [
      { id: 'addToHomeScreen', x: 23, cy: 53, w: 78, size: 6.5, align: 'center', color: 'ink' },
      { id: 'appName', x: 55, cy: 75, w: 44, size: 7, align: 'left', color: 'ink' },
      { id: 'add', x: 63, cy: 107, w: 34, size: 6.5, align: 'center', color: 'highlightInk' },
    ],
  },

  // 5 — "Tap the ⋮ menu": the overflow control is ringed.
  'android-toolbar': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {chromeBar(P, { highlightMenu: true })}
        {pageContent(P, 48)}
        {homeIndicator(P)}
      </>
    ),
    labels: [{ id: 'appName', x: 28, cy: 22, w: 52, size: 6.5, align: 'left', color: 'ink2' }],
  },

  // 6 — the overflow menu, "Install app" highlighted.
  'android-menu': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {chromeBar(P)}
        {pageContent(P, 48)}
        {scrim(P, 17, 9, 90, 158, 8)}
        <Rect x={41} y={26} width={64} height={92} rx={6} fill={P.chrome} stroke={P.border} strokeWidth={1} />
        <Rect x={47} y={34} width={44} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={47} y={46} width={50} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={47} y={58} width={38} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect
          x={44}
          y={68}
          width={58}
          height={18}
          rx={4}
          fill={P.highlightBg}
          stroke={P.highlight}
          strokeWidth={1.3}
        />
        <Rect x={47} y={94} width={46} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={47} y={106} width={40} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        {homeIndicator(P)}
      </>
    ),
    labels: [{ id: 'installApp', x: 48, cy: 77, w: 50, size: 6.5, align: 'left', color: 'ink' }],
  },

  // 7 — the install dialog: icon + name + Install.
  'android-confirm': {
    w: PW,
    h: PH,
    draw: (P) => (
      <>
        {phoneShell(P)}
        {chromeBar(P)}
        {pageContent(P, 48)}
        {scrim(P, 17, 9, 90, 158, 8)}
        <Rect x={21} y={56} width={82} height={64} rx={8} fill={P.chrome} stroke={P.border} strokeWidth={1} />
        {appIcon(P, 29, 64, 20)}
        <Rect x={55} y={78} width={32} height={3} rx={1.5} fill={P.line} opacity={0.45} />
        <Rect x={31} y={100.5} width={16} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={61} y={95} width={36} height={14} rx={7} fill={P.highlight} />
        {homeIndicator(P)}
      </>
    ),
    labels: [
      { id: 'appName', x: 55, cy: 70, w: 44, size: 7, align: 'left', color: 'ink' },
      { id: 'install', x: 61, cy: 102, w: 36, size: 6.5, align: 'center', color: 'highlightInk' },
    ],
  },

  // 8 — the desktop omnibox install icon, ringed.
  'desktop-omnibox': {
    w: DW,
    h: DH,
    draw: (P) => <>{desktopWindow(P, { highlightInstall: true })}</>,
    labels: [{ id: 'appName', x: 44, cy: 11.5, w: 46, size: 6, align: 'left', color: 'ink2' }],
  },

  // 9 — the desktop install dialog, anchored under the icon.
  'desktop-confirm': {
    w: DW,
    h: DH,
    draw: (P) => (
      <>
        {desktopWindow(P)}
        {scrim(P, 2, 2, 172, 108, 8)}
        <Path d="M 125 41 L 130 34 L 135 41 Z" fill={P.chrome} />
        <Rect x={80} y={40} width={88} height={56} rx={6} fill={P.chrome} stroke={P.border} strokeWidth={1} />
        {appIcon(P, 88, 58, 16)}
        <Rect x={110} y={70} width={30} height={3} rx={1.5} fill={P.line} opacity={0.45} />
        <Rect x={90} y={82.5} width={18} height={3.5} rx={1.75} fill={P.line} opacity={0.45} />
        <Rect x={120} y={78} width={38} height={13} rx={6.5} fill={P.highlight} />
      </>
    ),
    labels: [
      { id: 'installApp', x: 86, cy: 50, w: 76, size: 7, align: 'left', color: 'ink' },
      { id: 'appName', x: 110, cy: 63, w: 50, size: 6.5, align: 'left', color: 'ink' },
      { id: 'install', x: 120, cy: 84.5, w: 38, size: 6, align: 'center', color: 'highlightInk' },
    ],
  },
};

// ── Component ────────────────────────────────────────────────────────

export function StepIllustration({ art, width, palette, labels, testID }: StepIllustrationProps) {
  const spec = ART[art];
  const scale = width / spec.w;
  const height = spec.h * scale;

  return (
    <View
      testID={testID}
      style={{ width, height }}
      pointerEvents="none"
      // Decorative: the step prose is the accessible content, so the picture
      // must not double-read it (AC-8).
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={width} height={height} viewBox={`0 0 ${spec.w} ${spec.h}`}>
        {spec.draw(palette)}
      </Svg>
      {spec.labels.map((l, i) => {
        const fontSize = l.size * scale;
        const lineHeight = fontSize * 1.36;
        return (
          <Text
            key={`${l.id}-${i}`}
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              position: 'absolute',
              left: l.x * scale,
              // `cy` is the vertical CENTER, so the box top backs off by half
              // the line box — this is what keeps the overlay locked to the
              // drawing at every scale.
              top: l.cy * scale - lineHeight / 2,
              width: l.w * scale,
              fontSize,
              lineHeight,
              textAlign: l.align,
              color: palette[l.color],
            }}
          >
            {labels[l.id]}
          </Text>
        );
      })}
    </View>
  );
}

/** Test-only handle: the arts this file knows how to draw. Lets the suite pin
 *  registry ↔ model coverage without exporting the geometry itself. */
export const INSTALL_ART_IDS = Object.keys(ART) as InstallArt[];
