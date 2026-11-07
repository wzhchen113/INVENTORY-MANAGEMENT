// src/components/cmd/StockStoreDialog.test.tsx — Spec 184: AC-28 to AC-32, AC-35, AC-37.
//
// Boundary mocking mirrors StoreFormDrawer.test.tsx: theme and breakpoints pinned,
// ResponsiveSheet bypassed to render inline, useStore a mutable snapshot.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../theme/breakpoints', () => ({
  useIsPhone: () => false,
  useIsCompact: () => false,
  useBreakpoint: () => 'desktop' as const,
}));

jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) => {
      if (!visible) return null;
      return React.createElement(View, { testID: 'responsive-sheet' }, header, children, footer);
    },
  };
});

jest.mock('../../store/useStore', () => {
  const state: any = {
    locale: 'en',
    loadStoreStockPreview: jest.fn(),
    stockStoreFromStore: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import { StockStoreDialog } from './StockStoreDialog';
import type { Store } from '../../types';

const state = jest.requireMock('../../store/useStore').useStore.__state;
const previewMock = state.loadStoreStockPreview as jest.Mock;
const stockMock = state.stockStoreFromStore as jest.Mock;

const TARGET: Store = { id: 's-target', brandId: 'b1', name: 'Kenyon', address: '1 Main', status: 'active' };

const TOWSON = {
  storeId: 's-towson', name: 'Towson', status: 'active', itemCount: 149, itemsToAdd: 140,
  itemsAlreadyAtTarget: 9, itemsNoVendorLink: 2, carriedElsewhereCount: 1,
};
const CHARLES = {
  storeId: 's-charles', name: 'Charles', status: 'inactive', itemCount: 1, itemsToAdd: 0,
  itemsAlreadyAtTarget: 1, itemsNoVendorLink: 0, carriedElsewhereCount: 0,
};
const UNCARRIED = [
  { catalogId: 'c1', name: 'Saffron', unit: 'g', category: 'Spice', i18nNames: { es: 'Azafrán' } },
  { catalogId: 'c2', name: 'Truffle', unit: 'oz', category: null, i18nNames: {} },
];
const RESULT = {
  itemsCopied: 140, itemsSkipped: 9, linksAdded: 141, linksSkippedCrossBrand: 0, extrasAdded: 0,
  extrasSkipped: 0, itemsNoVendorLink: 2, targetHasOrderSchedule: true, uncarriedRemaining: 0,
};

const preview = (over: Record<string, unknown> = {}) => ({
  brandId: 'b1', targetItemCount: 9, targetHasOrderSchedule: true,
  sources: [TOWSON, CHARLES], uncarried: [], ...over,
});

const onClose = jest.fn();
const onStocked = jest.fn();

async function open() {
  render(<StockStoreDialog store={TARGET} brandId="b1" onClose={onClose} onStocked={onStocked} />);
  await act(async () => {});
}

const allText = () =>
  screen.UNSAFE_root.findAllByType(Text)
    .map((t: any) => [].concat(t.props.children).join(''))
    .join(' ');

beforeEach(() => {
  jest.clearAllMocks();
  state.locale = 'en';
  previewMock.mockResolvedValue(preview());
  stockMock.mockResolvedValue(RESULT);
});

describe('source picker (AC-28)', () => {
  it('reads the preview for this brand and target, and lists each source with its item count', async () => {
    await open();
    expect(previewMock).toHaveBeenCalledWith('b1', 's-target');
    expect(screen.getByTestId('stock-source-s-towson')).toBeTruthy();
    expect(screen.getByText('149 items')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.getByText('INACTIVE')).toBeTruthy();
  });

  it('preselects nothing, and offers no submit until a source is picked', async () => {
    await open();
    expect(screen.getByTestId('stock-source-s-towson').props.accessibilityState.selected).toBe(false);
    expect(screen.queryByTestId('stock-plan')).toBeNull();
    expect(screen.queryByTestId('stock-submit')).toBeNull();
  });
});

describe('no source available (AC-29)', () => {
  it.each([
    ['a brand with 0 catalog rows', []],
    ['a brand with catalog rows but no stocked store', UNCARRIED],
  ])('%s: says so, with no picker, no uncarried list and no submit', async (_label, uncarried) => {
    previewMock.mockResolvedValue(preview({ sources: [], uncarried }));
    await open();
    expect(screen.getByTestId('stock-no-source')).toBeTruthy();
    expect(screen.queryByTestId('stock-uncarried')).toBeNull();
    expect(screen.queryByTestId('stock-submit')).toBeNull();
    expect(screen.queryByTestId('stock-source-s-towson')).toBeNull();
  });
});

describe('preview read failure', () => {
  it('says it could not load, with no submit', async () => {
    previewMock.mockResolvedValue(null);
    await open();
    expect(screen.getByTestId('stock-preview-failed')).toBeTruthy();
    expect(screen.queryByTestId('stock-no-source')).toBeNull();
    expect(screen.queryByTestId('stock-submit')).toBeNull();
  });
});

describe('the statement before writing (AC-30, AC-31)', () => {
  it('states the source, the counts, the no-link items, zero stock, and the rows elsewhere', async () => {
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));

    const text = allText();
    expect(text).toContain('140 items from Towson will be added; 9 of 149 are already at Kenyon.');
    expect(text).toContain('2 of those have no vendor link, so they won’t appear at EOD until linked.');
    expect(text).toContain('Stock starts at 0.');
    expect(text).toContain('1 more item');
    expect(text).toContain('Running STOCK again from another store adds them.');
    expect(screen.getByTestId('stock-submit')).toBeTruthy();
    expect(stockMock).not.toHaveBeenCalled();
  });

  it('agrees in number when one item is already there and one has no link', async () => {
    previewMock.mockResolvedValue(preview({
      sources: [{ ...TOWSON, itemsAlreadyAtTarget: 1, itemsNoVendorLink: 1 }],
    }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    const text = allText();
    expect(text).toContain('1 of 149 is already at Kenyon.');
    expect(text).toContain('1 of those has no vendor link, so it won’t appear at EOD until linked.');
  });

  it('hides the no-link and elsewhere lines at 0', async () => {
    previewMock.mockResolvedValue(preview({
      sources: [{ ...TOWSON, itemsNoVendorLink: 0, carriedElsewhereCount: 0 }],
    }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    expect(screen.queryByTestId('stock-plan-no-link')).toBeNull();
    expect(screen.queryByTestId('stock-plan-elsewhere')).toBeNull();
  });

  it('never implies the full catalog (R-5)', async () => {
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    expect(allText()).not.toMatch(/\b(full|whole|entire|complete|fully)\b/i);
  });

  it('AC-31: with nothing to add and nothing ticked, says so and offers no submit', async () => {
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-charles'));
    expect(screen.getByTestId('stock-nothing-to-add')).toBeTruthy();
    expect(allText()).toContain('Kenyon already has everything from Charles.');
    expect(screen.queryByTestId('stock-submit')).toBeNull();
  });

  it('AC-31: a tick makes a source with nothing to add submittable', async () => {
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-charles'));
    expect(screen.queryByTestId('stock-submit')).toBeNull();
    fireEvent.press(screen.getByTestId('stock-uncarried-c1'));
    expect(screen.getByTestId('stock-submit')).toBeTruthy();
    expect(screen.getByText('STOCK 1 ITEM')).toBeTruthy();
  });
});

describe('uncarried rows (AC-32, AC-37)', () => {
  it('does not render when the brand has none', async () => {
    await open();
    expect(screen.queryByTestId('stock-uncarried')).toBeNull();
  });

  it('shows name, category and unit in a scrollable list, none ticked, with the warning copy', async () => {
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    expect(screen.getByTestId('stock-uncarried-list')).toBeTruthy();
    expect(screen.getByText('Saffron')).toBeTruthy();
    expect(screen.getByText('Spice · g')).toBeTruthy();
    expect(screen.getByText('oz')).toBeTruthy();
    for (const id of ['c1', 'c2']) {
      expect(screen.getByTestId(`stock-uncarried-${id}`).props.accessibilityState.checked).toBe(false);
    }
    const note = allText();
    expect(note).toContain('blank par and cost and no vendor link');
    expect(note).toContain('won’t show at EOD until linked');
    expect(note).toContain('removed on purpose');
  });

  it('localizes the name', async () => {
    state.locale = 'es';
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    expect(screen.getByText('Azafrán')).toBeTruthy();
    expect(screen.getByText('Truffle')).toBeTruthy();
  });

  it('sends only the ticked ids, and untick removes one', async () => {
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    fireEvent.press(screen.getByTestId('stock-uncarried-c1'));
    fireEvent.press(screen.getByTestId('stock-uncarried-c2'));
    fireEvent.press(screen.getByTestId('stock-uncarried-c1'));
    fireEvent.press(screen.getByTestId('stock-submit'));
    await act(async () => {});
    expect(stockMock).toHaveBeenCalledWith('s-target', 's-towson', ['c2']);
  });

  it('AC-37: the only ticks are on the uncarried list', async () => {
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    expect(screen.UNSAFE_queryAllByProps({ accessibilityRole: 'checkbox' })).toHaveLength(0);
  });
});

describe('submit (AC-33, AC-35)', () => {
  it('on success hands the result up, then closes', async () => {
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    fireEvent.press(screen.getByTestId('stock-submit'));
    await act(async () => {});

    expect(stockMock).toHaveBeenCalledWith('s-target', 's-towson', []);
    expect(onStocked).toHaveBeenCalledWith({
      targetStoreId: 's-target', targetName: 'Kenyon', sourceName: 'Towson', result: RESULT,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStocked.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it('on failure stays open with the picks intact and reports nothing', async () => {
    stockMock.mockResolvedValue(null);
    previewMock.mockResolvedValue(preview({ uncarried: UNCARRIED }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    fireEvent.press(screen.getByTestId('stock-uncarried-c1'));
    fireEvent.press(screen.getByTestId('stock-submit'));
    await act(async () => {});

    expect(onStocked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('stock-source-s-towson').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('stock-uncarried-c1').props.accessibilityState.checked).toBe(true);
    // And it can be retried.
    expect(screen.getByText('STOCK 141 ITEMS')).toBeTruthy();
  });

  it('a second press in flight sends no second call, and CANCEL is inert until it settles', async () => {
    let resolve: (v: unknown) => void = () => {};
    stockMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    await open();
    fireEvent.press(screen.getByTestId('stock-source-s-towson'));
    const submit = screen.getByTestId('stock-submit');
    // Same tick: before `submitting` can have re-rendered the button disabled.
    await act(async () => {
      fireEvent.press(submit);
      fireEvent.press(submit);
    });
    expect(stockMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('STOCKING…')).toBeTruthy();
    fireEvent.press(screen.getByTestId('stock-cancel'));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { resolve(RESULT); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
