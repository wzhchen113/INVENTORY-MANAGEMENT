// src/utils/enumLabels.test.ts
//
// Spec 039 — Track 1 (jest) spot-check coverage for the enum label
// resolvers. The catalog-parity test in `src/i18n/i18n.test.ts` covers
// key-set equality across en/es/zh-CN; this file adds two cheap
// guarantees the parity test can't:
//
//   1. Every enum value (every WasteReason, every UserRole, every
//      InventoryCountKind, every AuditAction, every DayName) resolves
//      to a non-empty, non-identity translation in English. Catches
//      drift when a future spec adds an enum value without updating
//      the catalog or the KEY map.
//   2. Sample Spanish + Chinese translations look right (snapshot the
//      hot keys to surface accidental translator-pass regressions).
//
// All assertions go through the real `t()` from `src/i18n/index.ts`
// against the real catalog JSONs — no mocks. The resolvers are pure
// (TFn parameter) so testing them is just data + math.

import { t } from '../i18n';
import { formatAuditAction } from './formatAuditAction';
import {
  wasteReasonLabel,
  wasteReasonShortLabel,
  roleLabel,
  userStatusLabel,
  inventoryCountKindLabel,
  inventoryCountKindSubLabel,
  dayOfWeekShortLabel,
  dayOfWeekLongLabel,
  unitLabel,
  type DayName,
} from './enumLabels';
import { matchesQuery } from '../i18n/matchesQuery';
import type {
  WasteReason,
  UserRole,
  InventoryCountKind,
  AuditAction,
} from '../types';
import type { Locale } from '../i18n';

type TFn = (key: string, vars?: Record<string, string | number>) => string;
const tFor = (loc: Locale): TFn => (k, v) => t(loc, k, v);

describe('enum.itemStatus catalog values', () => {
  // Direct catalog drift-detection insurance: every other enum family in
  // this file iterates its TypeScript union, but `Status` is consumed via
  // `statusLabel(s, T)` in `statusColors.ts` whose only test (StatusPill)
  // uses a mock T. If a catalog value is renamed, the StatusPill test
  // wouldn't catch it. These three assertions hit the real JSON.
  it('zh-CN translation of enum.itemStatus.ok is the Chinese label', () => {
    expect(t('zh-CN', 'enum.itemStatus.ok')).toBe('正常');
  });
  it('es translation of enum.itemStatus.low is BAJO', () => {
    expect(t('es', 'enum.itemStatus.low')).toBe('BAJO');
  });
  it('en value of enum.itemStatus.out is OUT', () => {
    expect(t('en', 'enum.itemStatus.out')).toBe('OUT');
  });
});

describe('formatAuditAction', () => {
  const ACTIONS: AuditAction[] = [
    'EOD entry',
    'Item edit',
    'Item added',
    'Item deleted',
    'POS import',
    'Waste log',
    'User invite',
    'User deleted',
    'Recipe saved',
    'Recipe deleted',
    'Prep recipe saved',
    'Prep recipe deleted',
    'Stock adjusted',
    'Order missed',
  ];

  it('maps every AuditAction value to a non-empty translation in English', () => {
    const T = tFor('en');
    for (const a of ACTIONS) {
      const out = formatAuditAction({ action: a }, T);
      expect(out.length).toBeGreaterThan(0);
      // Translation must differ from the raw English canonical for at
      // least the surfaced display form. The mapping uses verb phrases
      // ("submitted EOD count"), not the noun form ("EOD entry").
      expect(out).not.toBe(a);
      // Must not be a dot-path leak — i.e. lookup hit, not fall-through.
      expect(out).not.toMatch(/^enum\./);
    }
  });

  it('returns Spanish translation for eodEntry', () => {
    const T = tFor('es');
    expect(formatAuditAction({ action: 'EOD entry' }, T)).toBe('envió conteo EOD');
  });

  it('returns Chinese translation for wasteLog', () => {
    const T = tFor('zh-CN');
    expect(formatAuditAction({ action: 'Waste log' }, T)).toBe('记录损耗');
  });

  it('returns Spanish translation for orderMissed (spec 075)', () => {
    const T = tFor('es');
    expect(formatAuditAction({ action: 'Order missed' }, T)).toBe('pedido omitido');
  });

  it('returns Chinese translation for orderMissed (spec 075)', () => {
    const T = tFor('zh-CN');
    expect(formatAuditAction({ action: 'Order missed' }, T)).toBe('漏单');
  });
});

describe('wasteReasonLabel + wasteReasonShortLabel', () => {
  const REASONS: WasteReason[] = [
    'Expired',
    'Dropped/spilled',
    'Over-prepped',
    'Quality issue',
    'Theft',
    'Other',
  ];

  it('every WasteReason resolves in English (long + short)', () => {
    const T = tFor('en');
    for (const r of REASONS) {
      expect(wasteReasonLabel(r, T).length).toBeGreaterThan(0);
      expect(wasteReasonShortLabel(r, T).length).toBeGreaterThan(0);
      expect(wasteReasonLabel(r, T)).not.toMatch(/^enum\./);
      expect(wasteReasonShortLabel(r, T)).not.toMatch(/^enum\./);
    }
  });

  it('Spanish translation of Expired', () => {
    expect(wasteReasonLabel('Expired', tFor('es'))).toBe('Vencido');
  });

  it('Chinese translation of Dropped/spilled', () => {
    expect(wasteReasonLabel('Dropped/spilled', tFor('zh-CN'))).toBe('掉落/洒出');
  });
});

describe('roleLabel', () => {
  const ROLES: UserRole[] = ['user', 'admin', 'master', 'super_admin'];

  it('every UserRole resolves to a non-empty translation', () => {
    const T = tFor('en');
    for (const r of ROLES) {
      const out = roleLabel(r, T);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/^enum\./);
    }
  });

  it('Spanish translation of admin', () => {
    expect(roleLabel('admin', tFor('es'))).toBe('Administrador');
  });

  it('Chinese translation of super_admin', () => {
    expect(roleLabel('super_admin', tFor('zh-CN'))).toBe('超级管理员');
  });
});

describe('userStatusLabel', () => {
  it('returns ACTIVE / PENDING in English', () => {
    const T = tFor('en');
    expect(userStatusLabel('active', T)).toBe('ACTIVE');
    expect(userStatusLabel('pending', T)).toBe('PENDING');
  });

  it('returns Spanish ACTIVO / PENDIENTE', () => {
    const T = tFor('es');
    expect(userStatusLabel('active', T)).toBe('ACTIVO');
    expect(userStatusLabel('pending', T)).toBe('PENDIENTE');
  });
});

describe('inventoryCountKindLabel + inventoryCountKindSubLabel', () => {
  const KINDS: InventoryCountKind[] = ['spot', 'open', 'mid_shift', 'close'];

  it('every kind resolves to non-empty long + sub forms', () => {
    const T = tFor('en');
    for (const k of KINDS) {
      expect(inventoryCountKindLabel(k, T).length).toBeGreaterThan(0);
      expect(inventoryCountKindSubLabel(k, T).length).toBeGreaterThan(0);
    }
  });

  it('mid_shift maps via the camelCase key', () => {
    expect(inventoryCountKindLabel('mid_shift', tFor('en'))).toBe('Mid-shift');
    expect(inventoryCountKindSubLabel('mid_shift', tFor('en'))).toBe('between shifts');
  });
});

describe('dayOfWeek labels', () => {
  const DAYS: DayName[] = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  it('every day resolves to non-empty short + long forms', () => {
    const T = tFor('en');
    for (const d of DAYS) {
      expect(dayOfWeekShortLabel(d, T).length).toBeGreaterThan(0);
      expect(dayOfWeekLongLabel(d, T).length).toBeGreaterThan(0);
    }
  });

  it('English short forms are the three-letter UPPER form', () => {
    const T = tFor('en');
    expect(dayOfWeekShortLabel('Monday', T)).toBe('MON');
    expect(dayOfWeekShortLabel('Sunday', T)).toBe('SUN');
  });

  it('Spanish short form for Monday is LUN', () => {
    expect(dayOfWeekShortLabel('Monday', tFor('es'))).toBe('LUN');
  });

  it('Chinese short form for Monday is 周一', () => {
    expect(dayOfWeekShortLabel('Monday', tFor('zh-CN'))).toBe('周一');
  });
});

describe('unitLabel', () => {
  it('every canonical unit resolves to non-empty translation', () => {
    const T = tFor('en');
    for (const u of ['g', 'kg', 'oz', 'lbs', 'fl_oz', 'cups', 'qt', 'gal', 'each', 'cases', 'bags']) {
      const out = unitLabel(u, T);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/^enum\./);
    }
  });

  it('fl_oz maps via the flOz catalog key', () => {
    // English value of `enum.unit.flOz` is the stored `fl_oz` form.
    expect(unitLabel('fl_oz', tFor('en'))).toBe('fl_oz');
  });

  it('Chinese translation of lbs', () => {
    expect(unitLabel('lbs', tFor('zh-CN'))).toBe('磅');
  });

  it('unknown unit falls through unchanged', () => {
    expect(unitLabel('case', tFor('en'))).toBe('case');
    expect(unitLabel('bag-of-X', tFor('en'))).toBe('bag-of-X');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(unitLabel('', tFor('en'))).toBe('');
    expect(unitLabel(null, tFor('en'))).toBe('');
    expect(unitLabel(undefined, tFor('en'))).toBe('');
  });
});

describe('matchesQuery', () => {
  it('matches case-insensitively', () => {
    expect(matchesQuery('exp', ['Expired'])).toBe(true);
    expect(matchesQuery('EXP', ['expired'])).toBe(true);
  });

  it('strips diacritics on both sides', () => {
    expect(matchesQuery('venc', ['Vencido'])).toBe(true);
    expect(matchesQuery('VENC', ['vencido'])).toBe(true);
    expect(matchesQuery('cai', ['Caído'])).toBe(true);
    expect(matchesQuery('caí', ['caido'])).toBe(true);
  });

  it('returns true for empty / whitespace-only query', () => {
    expect(matchesQuery('', ['anything'])).toBe(true);
    expect(matchesQuery('   ', ['anything'])).toBe(true);
  });

  it('returns false when no candidate matches', () => {
    expect(matchesQuery('xyz', ['abc', 'def'])).toBe(false);
  });

  it('handles null / undefined candidates without throwing', () => {
    expect(matchesQuery('x', [null, undefined, 'xray'])).toBe(true);
    expect(matchesQuery('zzz', [null, undefined, 'xray'])).toBe(false);
  });
});
