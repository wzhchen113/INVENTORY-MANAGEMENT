// src/theme/colors.ts
import { useStore } from '../store/useStore';

// ── Light palette ────────────────────────────────────────────
export const LightColors = {
  // Backgrounds
  bgPrimary: '#FFFFFF',
  bgSecondary: '#F5F5F3',
  bgTertiary: '#EEEDE8',

  // Text
  textPrimary: '#1A1A18',
  textSecondary: '#6B6A65',
  textTertiary: '#9B9A95',

  // Brand
  brand: '#1A1A18',

  // Semantic
  success: '#3B6D11',
  successBg: '#EAF3DE',
  warning: '#854F0B',
  warningBg: '#FAEEDA',
  danger: '#791F1F',
  dangerBg: '#FCEBEB',
  info: '#185FA5',
  infoBg: '#E6F1FB',

  // Status pills (EOD overview, etc.) — same hue family as semantic above but
  // tuned for the small inline badges so contrast stays readable on cards.
  statusGreen: '#3B6D11',  statusGreenBg: '#E5F0D6',
  statusBlue: '#185FA5',   statusBlueBg: '#DCEAF8',
  statusOrange: '#854F0B', statusOrangeBg: '#F8E6CC',
  statusRed: '#791F1F',    statusRedBg: '#F8DCDC',

  // Borders
  borderLight: 'rgba(0,0,0,0.08)',
  borderMedium: 'rgba(0,0,0,0.15)',

  // User colors
  userAdmin: '#378ADD',
  userMaria: '#1D9E75',
  userJames: '#D85A30',
  userAna: '#D4537E',
  userKevin: '#7F77DD',

  // Chart colors
  chart: ['#378ADD', '#1D9E75', '#D85A30', '#D4537E', '#7F77DD', '#BA7517'],

  white: '#FFFFFF',
  black: '#000000',
};

// ── Dark palette ─────────────────────────────────────────────
export const DarkColors: typeof LightColors = {
  // Backgrounds
  bgPrimary: '#1A1A1E',
  bgSecondary: '#242428',
  bgTertiary: '#111114',

  // Text
  textPrimary: '#E8E8E6',
  textSecondary: '#A0A09B',
  textTertiary: '#6B6A65',

  // Brand
  brand: '#E8E8E6',

  // Semantic
  success: '#5CB832',
  successBg: '#1A2E12',
  warning: '#D4940F',
  warningBg: '#2E2410',
  danger: '#D84B4B',
  dangerBg: '#2E1414',
  info: '#4A9FE8',
  infoBg: '#12223A',

  // Status pills (EOD overview, etc.)
  statusGreen: '#7BD24F',  statusGreenBg: '#1F3815',
  statusBlue: '#5AAAF0',   statusBlueBg: '#152A45',
  statusOrange: '#E8A53A', statusOrangeBg: '#3A2A12',
  statusRed: '#E86060',    statusRedBg: '#3A1818',

  // Borders
  borderLight: 'rgba(255,255,255,0.08)',
  borderMedium: 'rgba(255,255,255,0.15)',

  // User colors
  userAdmin: '#5AAAF0',
  userMaria: '#3BBF8E',
  userJames: '#E87A50',
  userAna: '#E87098',
  userKevin: '#9A93EE',

  // Chart colors
  chart: ['#5AAAF0', '#3BBF8E', '#E87A50', '#E87098', '#9A93EE', '#D49030'],

  white: '#FFFFFF',
  black: '#000000',
};

// ── Static reference (for non-hook contexts: StyleSheet, top-level) ──
// This is the light palette by default. Components should use useColors() for reactivity.
export const Colors = LightColors;

// ── Reactive hook ────────────────────────────────────────────
// Use this inside components so they re-render when dark mode toggles.
export function useColors() {
  const darkMode = useStore((s) => s.darkMode);
  return darkMode ? DarkColors : LightColors;
}

// ── Design tokens (unchanged) ────────────────────────────────
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const Radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  round: 999,
};

export const FontSize = {
  xs: 10,
  sm: 11,
  md: 12,
  base: 13,
  lg: 15,
  xl: 18,
  xxl: 22,
  xxxl: 28,
};

export const Shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
};
