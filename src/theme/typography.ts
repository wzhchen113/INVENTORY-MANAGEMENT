import { TextStyle } from 'react-native';

// Command direction typography. Inter Tight (sans) + JetBrains Mono (mono).
// In RN every weight is a separate font-family name (the @expo-google-fonts/*
// packages register them that way), so callers pick a weight via sans()/mono().

type Weight = 400 | 500 | 600 | 700;

const SANS: Record<Weight, string> = {
  400: 'InterTight_400Regular',
  500: 'InterTight_500Medium',
  600: 'InterTight_600SemiBold',
  700: 'InterTight_700Bold',
};

const MONO: Record<Weight, string> = {
  400: 'JetBrainsMono_400Regular',
  500: 'JetBrainsMono_500Medium',
  600: 'JetBrainsMono_600SemiBold',
  700: 'JetBrainsMono_700Bold',
};

export const sans = (w: Weight = 400) => SANS[w];
export const mono = (w: Weight = 400) => MONO[w];

const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];

export const Type: Record<string, TextStyle> = {
  display:          { fontFamily: sans(700), fontSize: 26, letterSpacing: -0.4 },
  h1:               { fontFamily: sans(700), fontSize: 24, letterSpacing: -0.4 },
  h2:               { fontFamily: sans(700), fontSize: 14, letterSpacing: -0.1 },
  body:             { fontFamily: sans(400), fontSize: 13 },
  bodySm:           { fontFamily: sans(400), fontSize: 12 },
  kpiValueDesktop:  { fontFamily: mono(600), fontSize: 20, letterSpacing: -0.3, fontVariant: TABULAR },
  kpiValueMobile:   { fontFamily: mono(600), fontSize: 18, letterSpacing: -0.3, fontVariant: TABULAR },
  kpiLabelDesktop:  { fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase' },
  kpiLabelMobile:   { fontFamily: mono(600), fontSize: 9,   letterSpacing: 0.5, textTransform: 'uppercase' },
  tableNum:         { fontFamily: mono(400), fontSize: 11,  fontVariant: TABULAR },
  tableNumMedium:   { fontFamily: mono(500), fontSize: 11,  fontVariant: TABULAR },
  caption:          { fontFamily: mono(600), fontSize: 10,  letterSpacing: 0.6, textTransform: 'uppercase' },
  captionLg:        { fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase' },
  kbd:              { fontFamily: mono(500), fontSize: 10 },
  kbdSm:            { fontFamily: mono(500), fontSize: 9.5 },
  tab:              { fontFamily: mono(500), fontSize: 12 },
  breadcrumb:       { fontFamily: mono(400), fontSize: 11 },
  statusBar:        { fontFamily: mono(400), fontSize: 10 },
};
