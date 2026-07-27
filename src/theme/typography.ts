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
  display:          { fontFamily: sans(600), fontSize: 26, letterSpacing: -0.4 },
  h1:               { fontFamily: sans(600), fontSize: 24, letterSpacing: -0.4 },
  h2:               { fontFamily: sans(600), fontSize: 14, letterSpacing: -0.1 },
  body:             { fontFamily: sans(400), fontSize: 13 },
  bodySm:           { fontFamily: sans(400), fontSize: 12 },
  kpiValueDesktop:  { fontFamily: mono(600), fontSize: 20, letterSpacing: -0.3, fontVariant: TABULAR },
  kpiValueMobile:   { fontFamily: mono(600), fontSize: 18, letterSpacing: -0.3, fontVariant: TABULAR },
  kpiLabelDesktop:  { fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.7, textTransform: 'uppercase' },
  kpiLabelMobile:   { fontFamily: mono(600), fontSize: 9,   letterSpacing: 0.7, textTransform: 'uppercase' },
  tableNum:         { fontFamily: mono(400), fontSize: 11,  fontVariant: TABULAR },
  tableNumMedium:   { fontFamily: mono(500), fontSize: 11,  fontVariant: TABULAR },
  caption:          { fontFamily: mono(600), fontSize: 10,  letterSpacing: 0.75, textTransform: 'uppercase' },
  captionLg:        { fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.75, textTransform: 'uppercase' },
  kbd:              { fontFamily: mono(500), fontSize: 10 },
  kbdSm:            { fontFamily: mono(500), fontSize: 9.5 },
  tab:              { fontFamily: mono(500), fontSize: 12 },
  breadcrumb:       { fontFamily: mono(400), fontSize: 11 },
  statusBar:        { fontFamily: mono(400), fontSize: 10 },
};

// ─── Spec 140: phone type ramp (additive — the one NEW type sub-system) ──────
//
// A phone-tier ramp introduced by the external phone design handoff. It is
// ADDITIVE: the `Type` map above is left byte-unchanged so desktop/tablet are
// unaffected (AC-13/AC-REG). Later phone specs (Inventory row, Ordering card)
// reuse these roles, so it lives here as a single exported map rather than a
// local const block. Composes with `sans()` / `mono()` and adds NO palette
// values.
//
// Legibility floors baked into the constants (asserted in jest): `metaMono`
// never renders below 10.5px and `microCaption` never below 8.5px — the two
// smallest mono roles that carry real information on a phone in a walk-in.
export const PhoneType: Record<string, TextStyle> = {
  screenTitle:    { fontFamily: sans(600), fontSize: 20,   letterSpacing: -0.4 },
  itemName:       { fontFamily: sans(600), fontSize: 15,   letterSpacing: -0.1 },
  body:           { fontFamily: sans(400), fontSize: 14 },
  // floor ≥ 10.5
  metaMono:       { fontFamily: mono(400), fontSize: 11,   fontVariant: TABULAR },
  caption:        { fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.85, textTransform: 'uppercase' },
  // floor ≥ 8.5
  microCaption:   { fontFamily: mono(600), fontSize: 9,    letterSpacing: 0.7,  textTransform: 'uppercase' },
  wellValue:      { fontFamily: mono(600), fontSize: 16,   fontVariant: TABULAR },
  wellValueSheet: { fontFamily: mono(600), fontSize: 20,   fontVariant: TABULAR },
  kpiValue:       { fontFamily: mono(600), fontSize: 19,   letterSpacing: -0.3, fontVariant: TABULAR },
  keypadKey:      { fontFamily: mono(500), fontSize: 18 },
  tableNum:       { fontFamily: mono(600), fontSize: 14,   fontVariant: TABULAR },
};
