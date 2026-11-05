// src/components/cmd/ExportLanguagePrompt.test.tsx — Spec 183.
//
// Pins the export language prompt's contract (spec 183 §1b):
//   - pure helpers: per-format option sets + the default-locale rule
//     (zh-CN UI + PDF → en; undefined UI locale → en)
//   - AC-5 option rendering (PDF has NO 中文 segment at all)
//   - AC-6 preselection, AC-7 confirm with default / changed pick
//   - AC-9 every dismiss path (Cancel, backdrop, Modal.onRequestClose) → onCancel
//   - the once-guard (first of confirm / cancel wins)
//   - AC-8 `setLocale` never called; remount reseeds from the UI locale
//   - store switch while open → renders nothing + onCancel exactly once
//   - AC-20 a11y label + radiogroup / radio roles
//   - the REMOVABLE PDF-only hint (spec 183 §1b.9)
//
// Boundary mocks: the Zustand store (its real import graph needs env vars),
// the Cmd colors hook, and `useT` as a key → string dict.

const mockState: {
  currentStore: { id: string; name: string } | null;
  locale: 'en' | 'es' | 'zh-CN' | undefined;
  setLocale: jest.Mock;
} = {
  currentStore: { id: 'store-1', name: 'Store One' },
  locale: 'en',
  setLocale: jest.fn(),
};

jest.mock('../../store/useStore', () => {
  const fn: any = jest.fn((selector: (s: any) => any) => selector(mockState));
  fn.getState = () => mockState;
  return { useStore: fn };
});

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    const dict: Record<string, string> = {
      'chrome.localeSwitcher.aria': 'Change language',
      'chrome.localeSwitcher.labels.en': 'EN',
      'chrome.localeSwitcher.labels.es': 'ES',
      'chrome.localeSwitcher.labels.zh-CN': '中文',
      'common.cancel': 'Cancel',
      'section.reorder.exportLanguagePrompt.title': 'Which language?',
      'section.reorder.exportLanguagePrompt.subtitle': '{format} · {vendor}',
      'section.reorder.exportLanguagePrompt.formatCsv': 'CSV',
      'section.reorder.exportLanguagePrompt.formatPdf': 'PDF',
      'section.reorder.exportLanguagePrompt.formatQuickOrder': 'Quick-order list',
      'section.reorder.exportLanguagePrompt.pdfLatinOnly': 'PDF is available in English or Spanish.',
      'section.reorder.exportLanguagePrompt.confirm': 'Continue',
      'section.reorder.exportLanguagePrompt.aria': 'Choose export language',
    };
    let out = dict[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return out;
  },
}));

import React from 'react';
import { Modal, TouchableOpacity } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import {
  ExportLanguagePrompt,
  exportLocaleOptions,
  defaultExportLocale,
  type ReorderExportFormat,
} from './ExportLanguagePrompt';
import type { Locale } from '../../i18n';

function renderPrompt(
  format: ReorderExportFormat,
  over: { storeId?: string; onConfirm?: jest.Mock; onCancel?: jest.Mock } = {},
) {
  const onConfirm = over.onConfirm ?? jest.fn();
  const onCancel = over.onCancel ?? jest.fn();
  // A FRESH element per call — re-rendering the identical element object would
  // let React bail out, and the mocked store has no subscription to force it.
  const el = () => (
    <ExportLanguagePrompt
      format={format}
      vendorName="Produce Co"
      storeId={over.storeId ?? 'store-1'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
  const view = render(el());
  return { ...view, onConfirm, onCancel, el };
}

const selected = (locale: Locale) =>
  screen.getByTestId(`export-lang-option-${locale}`).props.accessibilityState.selected;

beforeEach(() => {
  mockState.currentStore = { id: 'store-1', name: 'Store One' };
  mockState.locale = 'en';
  mockState.setLocale = jest.fn();
});

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('exportLocaleOptions / defaultExportLocale', () => {
  it('per-format option sets', () => {
    expect(exportLocaleOptions('csv')).toEqual(['en', 'es', 'zh-CN']);
    expect(exportLocaleOptions('quickOrder')).toEqual(['en', 'es', 'zh-CN']);
    expect(exportLocaleOptions('pdf')).toEqual(['en', 'es']);
  });

  it.each<[ReorderExportFormat, Locale | undefined, Locale]>([
    ['csv', 'en', 'en'], ['csv', 'es', 'es'], ['csv', 'zh-CN', 'zh-CN'], ['csv', undefined, 'en'],
    ['quickOrder', 'en', 'en'], ['quickOrder', 'es', 'es'], ['quickOrder', 'zh-CN', 'zh-CN'], ['quickOrder', undefined, 'en'],
    ['pdf', 'en', 'en'], ['pdf', 'es', 'es'], ['pdf', 'zh-CN', 'en'], ['pdf', undefined, 'en'],
  ])('defaultExportLocale(%s, %s) → %s', (format, ui, expected) => {
    expect(defaultExportLocale(format, ui)).toBe(expected);
  });
});

// ── AC-5 options ────────────────────────────────────────────────────────────
describe('AC-5 — options per format', () => {
  it.each<ReorderExportFormat>(['csv', 'quickOrder'])('%s renders EN / ES / 中文', (format) => {
    renderPrompt(format);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByTestId('export-lang-option-zh-CN')).toBeTruthy();
    expect(screen.getByText('中文')).toBeTruthy();
  });

  it('pdf renders EN / ES only — 中文 is ABSENT (not disabled)', () => {
    renderPrompt('pdf');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByTestId('export-lang-option-zh-CN')).toBeNull();
    expect(screen.queryByText('中文')).toBeNull();
  });
});

// ── AC-6 default selection ──────────────────────────────────────────────────
describe('AC-6 — the UI locale is preselected', () => {
  it('es UI → ES selected', () => {
    mockState.locale = 'es';
    renderPrompt('csv');
    expect(selected('es')).toBe(true);
    expect(selected('en')).toBe(false);
  });

  it('zh-CN UI + quick-order → 中文 selected', () => {
    mockState.locale = 'zh-CN';
    renderPrompt('quickOrder');
    expect(selected('zh-CN')).toBe(true);
  });

  it('zh-CN UI + PDF → EN selected', () => {
    mockState.locale = 'zh-CN';
    renderPrompt('pdf');
    expect(selected('en')).toBe(true);
    expect(selected('es')).toBe(false);
  });
});

// ── AC-7 confirm ────────────────────────────────────────────────────────────
describe('AC-7 — confirm passes the picked locale', () => {
  it('confirm with the default passes the UI locale', () => {
    mockState.locale = 'es';
    const { onConfirm, onCancel } = renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('es');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('zh-CN UI + PDF: confirm with the default passes en', () => {
    mockState.locale = 'zh-CN';
    const { onConfirm } = renderPrompt('pdf');
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('en');
  });

  it('picking ES then confirming passes es', () => {
    const { onConfirm } = renderPrompt('quickOrder');
    fireEvent.press(screen.getByTestId('export-lang-option-es'));
    expect(selected('es')).toBe(true);
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('es');
  });
});

// ── AC-9 cancel paths ───────────────────────────────────────────────────────
describe('AC-9 — every dismiss path cancels, never confirms', () => {
  it('the Cancel button', () => {
    const { onConfirm, onCancel } = renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the ResponsiveSheet backdrop tap', () => {
    const { onConfirm, onCancel } = renderPrompt('pdf');
    // The first TouchableOpacity under the Modal is ResponsiveSheet's backdrop.
    fireEvent.press(screen.UNSAFE_getAllByType(TouchableOpacity)[0]);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Modal.onRequestClose (Android back / Escape on web)', () => {
    const { onConfirm, onCancel } = renderPrompt('quickOrder');
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ── Once-guard ──────────────────────────────────────────────────────────────
describe('once-guard — the first of confirm / cancel wins', () => {
  it('double Continue → one onConfirm', () => {
    const { onConfirm } = renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Continue then a cancel path → no onCancel', () => {
    const { onConfirm, onCancel } = renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    fireEvent.press(screen.getByTestId('export-lang-cancel'));
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ── AC-8 export-scoped ──────────────────────────────────────────────────────
describe('AC-8 — never touches the app locale', () => {
  it('setLocale is never called on option press, confirm or cancel', () => {
    renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-option-zh-CN'));
    fireEvent.press(screen.getByTestId('export-lang-option-es'));
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    expect(mockState.setLocale).not.toHaveBeenCalled();
    expect(mockState.locale).toBe('en');

    screen.unmount();
    renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-cancel'));
    expect(mockState.setLocale).not.toHaveBeenCalled();
  });

  it('a remount after picking ES reseeds from the UI locale (no memory)', () => {
    renderPrompt('csv');
    fireEvent.press(screen.getByTestId('export-lang-option-es'));
    fireEvent.press(screen.getByTestId('export-lang-confirm'));
    screen.unmount();
    renderPrompt('csv');
    expect(selected('en')).toBe(true);
    expect(selected('es')).toBe(false);
  });
});

// ── Store switch while open ─────────────────────────────────────────────────
describe('store switch while the prompt is open', () => {
  it('renders nothing and calls onCancel exactly once', () => {
    const { onConfirm, onCancel, rerender, el } = renderPrompt('csv');
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
    mockState.currentStore = { id: 'store-2', name: 'Store Two' };
    rerender(el());
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(el());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ── AC-20 a11y + content ────────────────────────────────────────────────────
describe('AC-20 — accessibility and content', () => {
  it('sheet + radiogroup carry the export aria label; radio roles present', () => {
    renderPrompt('csv');
    expect(screen.UNSAFE_getByType(Modal).props.accessibilityLabel).toBe('Choose export language');
    const labelled = screen.getAllByLabelText('Choose export language');
    expect(labelled.some((n) => n.props.accessibilityRole === 'radiogroup')).toBe(true);
    // The prompt must not announce "Change language" (it never changes it).
    expect(screen.queryByLabelText('Change language')).toBeNull();
    expect(screen.getAllByRole('radio').length).toBe(3);
  });

  it('title + "{format} · {vendor}" subtitle', () => {
    renderPrompt('quickOrder');
    expect(screen.getByText('Which language?')).toBeTruthy();
    expect(screen.getByText('Quick-order list · Produce Co')).toBeTruthy();
  });

  // REMOVABLE with the `pdfLatinOnly` key (spec 183 §1b.9).
  it('the PDF-only hint renders for PDF only', () => {
    renderPrompt('pdf');
    expect(screen.getByTestId('export-lang-pdf-hint')).toBeTruthy();
    screen.unmount();
    renderPrompt('csv');
    expect(screen.queryByTestId('export-lang-pdf-hint')).toBeNull();
  });
});
