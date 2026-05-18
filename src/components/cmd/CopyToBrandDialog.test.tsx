// src/components/cmd/CopyToBrandDialog.test.tsx — Spec 049 coverage.
//
// Three paths per the architect's frontend slice:
//   1. render — modal shows title, item preview, target picker, skip notice.
//   2. success path — confirm calls `copyCatalogRows(...)` with the
//      correct args AND fires the success toast with the result envelope.
//   3. error path — RPC rejects → error toast surfaces and dialog stays
//      open so the user can retry.
//
// Boundary mocking (same shape as StatusPill.test.tsx + RecipeCategoriesSection.test.tsx):
//   - `react-native-toast-message` (global, jest.setup.ts) — Toast.show
//     is a jest.fn() so we can assert call shape.
//   - `../../theme/colors` — `useCmdColors()` returns a deterministic
//     palette so we don't drag the Zustand store import chain in.
//   - `../../theme/breakpoints` — `useIsPhone()` pinned to false so the
//     non-phone render path executes (matches the desktop test target).
//   - `../../hooks/useT` — key-echoing translator (with simple {var}
//     interpolation) so assertions can key off stable dot-paths.
//   - `../../store/useStore` — fixed snapshot exposing `brandsList` and
//     a `loadBrandsList` jest.fn().
//   - `../../lib/db` — `copyCatalogRows` jest.fn() per test, resolved
//     to a fake result envelope OR rejected with a fake error.
//
// Component-project (jsdom) because this file imports a `.tsx`.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:           '#FFFFFF',
    panel:        '#F4F4F4',
    panel2:       '#EAEAEA',
    border:       '#CCCCCC',
    borderStrong: '#888888',
    fg:           '#000000',
    fg2:          '#444444',
    fg3:          '#888888',
    accent:       '#185FA5',
    accentBg:     '#E6F1FB',
    accentFg:     '#FFFFFF',
    warn:         '#854F0B',
    warnBg:       '#FAEEDA',
    danger:       '#791F1F',
    dangerBg:     '#FCEBEB',
    ok:           '#3B6D11',
    okBg:         '#EAF3DE',
    info:         '#185FA5',
    infoBg:       '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../theme/breakpoints', () => ({
  useIsPhone: () => false,
  useIsCompact: () => false,
  useBreakpoint: () => 'desktop' as const,
}));

// ResponsiveSheet wraps the body in a RN Modal + safe-area inset reader.
// Bypass it for the unit test — render children inline so we can assert
// against the dialog's content without dragging the SafeAreaProvider /
// Modal portal machinery in. Same rationale as the
// RecipeCategoriesSection test's translateOnSave stub: mock the wrapper
// at its boundary, exercise the contained logic.
jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) => {
      if (!visible) return null;
      return React.createElement(
        View,
        { testID: 'responsive-sheet' },
        header,
        children,
        footer,
      );
    },
  };
});

// useT — key-echoing translator with {var} interpolation. Match the
// RecipeCategoriesSection.test.tsx pattern.
jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

// useStore — fixed snapshot. `brandsList` exposes a source brand and
// two eligible targets so the picker has chips to click. The test does
// NOT exercise the loadBrandsList code path (covered by integration).
jest.mock('../../store/useStore', () => {
  const state: any = {
    brandsList: [
      { id: 'src',  name: 'Source Brand', deletedAt: null },
      { id: 't1',   name: 'Brand One',    deletedAt: null },
      { id: 't2',   name: 'Brand Two',    deletedAt: null },
      { id: 'gone', name: 'Deleted',      deletedAt: '2026-01-01T00:00:00Z' },
    ],
    loadBrandsList: jest.fn().mockResolvedValue(undefined),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// db.copyCatalogRows — the RPC wrapper. Default resolves with a fake
// success envelope; tests can override via mockImplementationOnce /
// mockRejectedValueOnce for the error path.
jest.mock('../../lib/db', () => ({
  copyCatalogRows: jest.fn(),
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { CopyToBrandDialog } from './CopyToBrandDialog';
import { copyCatalogRows } from '../../lib/db';

const toastShowMock = (Toast as any).show as jest.Mock;
const copyCatalogRowsMock = copyCatalogRows as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// Flush microtasks — used to await the async confirm path that fires
// the RPC mock without await-ing the returned promise from the click
// handler directly (the handler is `async` but `fireEvent.press` does
// not return that promise).
async function flushMicrotasks() {
  // Two ticks: one for the resolved promise, one for the setState
  // inside the .then handler.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('CopyToBrandDialog — render', () => {
  it('renders the title, target picker chips, and the skip-on-conflict notice', () => {
    render(
      <CopyToBrandDialog
        visible
        sourceBrandId="src"
        table="catalog_ingredients"
        sourceIds={['cat-1', 'cat-2']}
        sourceNames={['Tomato', 'Basil']}
        onClose={() => {}}
      />
    );

    // Title via mocked useT — key path echoes.
    expect(screen.getByText('dialog.copyToBrand.title')).toBeTruthy();
    // Item preview rows.
    expect(screen.getByText('· Tomato')).toBeTruthy();
    expect(screen.getByText('· Basil')).toBeTruthy();
    // Eligible target brands (Source Brand excluded — it's the source;
    // Deleted excluded — soft-delete tombstone).
    expect(screen.getByText('Brand One')).toBeTruthy();
    expect(screen.getByText('Brand Two')).toBeTruthy();
    expect(screen.queryByText('Source Brand')).toBeNull();
    expect(screen.queryByText('Deleted')).toBeNull();
    // Skip-on-conflict copy.
    expect(screen.getByText('dialog.copyToBrand.skipNotice')).toBeTruthy();
  });

  it('does not render when visible=false', () => {
    render(
      <CopyToBrandDialog
        visible={false}
        sourceBrandId="src"
        table="vendors"
        sourceIds={['v-1']}
        sourceNames={['Sysco']}
        onClose={() => {}}
      />
    );
    // The component returns null when visible is false.
    expect(screen.queryByText('dialog.copyToBrand.title')).toBeNull();
  });

  it('shows the "no other brands available" empty state when no eligible targets exist', () => {
    // Drive an empty-eligible state by passing a sourceBrandId that
    // matches every brand in the mocked list. We tweak the snapshot.
    const useStoreModule = jest.requireMock('../../store/useStore');
    const saved = useStoreModule.useStore.__state.brandsList;
    useStoreModule.useStore.__state.brandsList = [
      { id: 'only', name: 'Only Brand', deletedAt: null },
    ];
    try {
      render(
        <CopyToBrandDialog
          visible
          sourceBrandId="only"
          table="catalog_ingredients"
          sourceIds={['cat-1']}
          sourceNames={['Tomato']}
          onClose={() => {}}
        />
      );
      expect(screen.getByText('dialog.copyToBrand.noBrandsAvailable')).toBeTruthy();
    } finally {
      useStoreModule.useStore.__state.brandsList = saved;
    }
  });
});

describe('CopyToBrandDialog — success path', () => {
  it('calls copyCatalogRows with the correct args and fires the success toast', async () => {
    copyCatalogRowsMock.mockResolvedValueOnce({
      copied: 3,
      skipped: 2,
      skippedNames: ['Garlic', 'Onion'],
    });
    const onSuccess = jest.fn();
    const onClose = jest.fn();

    render(
      <CopyToBrandDialog
        visible
        sourceBrandId="src"
        table="catalog_ingredients"
        sourceIds={['cat-1', 'cat-2', 'cat-3']}
        sourceNames={['Tomato', 'Basil', 'Garlic']}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // Pick "Brand One" as the target.
    fireEvent.press(screen.getByText('Brand One'));

    // Click the confirm button — the mocked translator returns the
    // key path verbatim, so `dialog.copyToBrand.confirm` is the
    // label text. The footer renders two instances (button + access
    // label), so use the FIRST match.
    const confirmHits = screen.getAllByText('dialog.copyToBrand.confirm');
    expect(confirmHits.length).toBeGreaterThan(0);
    fireEvent.press(confirmHits[0]);

    await flushMicrotasks();

    // RPC called with exactly the args the architect specified.
    expect(copyCatalogRowsMock).toHaveBeenCalledTimes(1);
    expect(copyCatalogRowsMock).toHaveBeenCalledWith(
      'src',
      't1',
      'catalog_ingredients',
      ['cat-1', 'cat-2', 'cat-3'],
    );

    // Success toast — `text1` resolves via the mocked useT (key-path
    // echo). With the {copied} / {skipped} vars supplied, the mock
    // returns the key path unchanged since there's no literal `{copied}`
    // token in the key string itself. We assert on the key path AND
    // that the call passed the right vars by checking that the
    // success toast fired exactly once with `type: 'success'` and the
    // expected text2 (table label key path).
    const successCalls = toastShowMock.mock.calls.filter(
      ([arg]: any[]) => arg && arg.type === 'success',
    );
    expect(successCalls).toHaveLength(1);
    expect(successCalls[0][0].text1).toBe('dialog.copyToBrand.successToast');
    expect(successCalls[0][0].text2).toBe('dialog.copyToBrand.tableIngredients');

    // onSuccess invoked with the result envelope, then onClose fired.
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({
      copied: 3,
      skipped: 2,
      skippedNames: ['Garlic', 'Onion'],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CopyToBrandDialog — error path', () => {
  it('shows an error toast when copyCatalogRows rejects and keeps the dialog open', async () => {
    copyCatalogRowsMock.mockRejectedValueOnce(new Error('permission denied'));
    const onSuccess = jest.fn();
    const onClose = jest.fn();

    render(
      <CopyToBrandDialog
        visible
        sourceBrandId="src"
        table="vendors"
        sourceIds={['v-1']}
        sourceNames={['Sysco']}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // Pick a target so the confirm button is enabled.
    fireEvent.press(screen.getByText('Brand One'));
    const confirmHits = screen.getAllByText('dialog.copyToBrand.confirm');
    fireEvent.press(confirmHits[0]);

    await flushMicrotasks();

    // RPC was called.
    expect(copyCatalogRowsMock).toHaveBeenCalledTimes(1);

    // Error toast surfaced — must include the backend message in text2.
    const errorCalls = toastShowMock.mock.calls.filter(
      ([arg]: any[]) => arg && arg.type === 'error',
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][0].text1).toBe('dialog.copyToBrand.errorToast');
    expect(errorCalls[0][0].text2).toBe('permission denied');

    // Dialog stays open — onClose NOT called on the error path so the
    // user can retry without re-typing their selection.
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('confirm button is disabled until a target brand is picked', () => {
    render(
      <CopyToBrandDialog
        visible
        sourceBrandId="src"
        table="catalog_ingredients"
        sourceIds={['cat-1']}
        sourceNames={['Tomato']}
        onClose={() => {}}
      />
    );

    // No target picked yet — pressing the confirm button must NOT
    // invoke the RPC. The TouchableOpacity's `disabled` prop blocks
    // the synthetic press in react-native testing-library.
    const confirmHits = screen.getAllByText('dialog.copyToBrand.confirm');
    fireEvent.press(confirmHits[0]);
    expect(copyCatalogRowsMock).not.toHaveBeenCalled();
  });
});
