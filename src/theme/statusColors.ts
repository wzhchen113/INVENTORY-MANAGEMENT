import { LightCmd } from './colors';

export type Status = 'ok' | 'low' | 'out' | 'info';

type CmdPalette = typeof LightCmd;

export const statusFg = (c: CmdPalette, s: Status): string =>
  s === 'ok' ? c.ok : s === 'low' ? c.warn : s === 'out' ? c.danger : c.info;

export const statusBg = (c: CmdPalette, s: Status): string =>
  s === 'ok' ? c.okBg : s === 'low' ? c.warnBg : s === 'out' ? c.dangerBg : c.infoBg;

export const statusLabel = (s: Status): string =>
  s === 'ok' ? 'OK' : s === 'low' ? 'LOW' : s === 'out' ? 'OUT' : 'INFO';
