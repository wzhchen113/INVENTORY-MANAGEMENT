import { LightCmd } from './colors';

export type Status = 'ok' | 'low' | 'out' | 'info';

type CmdPalette = typeof LightCmd;
type TFn = (key: string, vars?: Record<string, string | number>) => string;

export const statusFg = (c: CmdPalette, s: Status): string =>
  s === 'ok' ? c.ok : s === 'low' ? c.warn : s === 'out' ? c.danger : c.info;

export const statusBg = (c: CmdPalette, s: Status): string =>
  s === 'ok' ? c.okBg : s === 'low' ? c.warnBg : s === 'out' ? c.dangerBg : c.infoBg;

// Spec 039 — locale-aware label. Every call site lives inside a
// component that already calls `useT()`; pass `T` through so the
// resolver stays a pure function (no new hook, no React rules-of-hooks
// concern). See spec 039 §1(a) for rationale.
export const statusLabel = (s: Status, T: TFn): string =>
  T(`enum.itemStatus.${s}`);
