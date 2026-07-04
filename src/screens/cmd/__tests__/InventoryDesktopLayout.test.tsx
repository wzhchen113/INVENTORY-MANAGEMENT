// src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx — Spec 112.
//
// Pins the items.tsv branch's detail-on-demand lifecycle + the ★ money
// single-definition property. Mounts the real InventoryDesktopLayout with a
// mocked store slice (mirrors InventoryCatalogMode.test.tsx). Desktop path is
// forced via a `useIsDesktop → true` mock + a wide `useWindowDimensions`.
//
// Cases (spec 112 AC-13):
//   1  operational columns render at full width (header labels + a data row)
//   2  NO detail pane on entry (selectedName null → pane absent)
//   3  click opens; ✕ closes; Esc (web keydown) closes; same-row re-click closes
//   4  row swap while open swaps content without closing
//   5  store switch clears selection (pane absent)
//   6  ★ money value-pin: cell "$0.02"/"$120" AND equal to the detail header
//   8  catalog.tsv boundary — switching viewMode still renders InventoryCatalogMode
//
// (Collapse tiers — AC-13 case 7 — are pinned in InventoryTable.test.tsx,
// which renders the table at explicit widths.)

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

// Key-echoing translator so we can query by the raw i18n key path (e.g.
// 'section.inventory.closeDetailAria' is the ✕ button's a11y label).
jest.mock('../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('../../../hooks/useLocale', () => ({ useLocale: () => 'en' }));

// Force Platform.OS = 'web' so the AC-5/AC-14 web-only Esc keydown listener
// installs (jest-expo defaults the jsdom project to 'ios'). Mirrors the
// useConnectionStatus.test.ts Platform mock idiom.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

// Desktop path — force the ≥1100 branch (table + side-pane).
const mockIsDesktop = jest.fn(() => true);
jest.mock('../../../theme/breakpoints', () => ({
  useIsDesktop: () => mockIsDesktop(),
  DESKTOP_MIN_WIDTH: 1100,
}));

// Reactive window width — the AC-7 fix derives the table width from
// useWindowDimensions (windowWidth − chrome − pane), so tests control the tier
// by setting this. `mock`-prefixed so the factory may reference it. Default
// 1800: closed table = 1800 − FALLBACK_CHROME(260) − 0 = 1540 (≥1400 → all 8);
// open pane = 1800 − 260 − PANE_WIDTH(620) = 920 (<1200 → 6-col floor). onLayout
// never fires in the test renderer, so chromeW stays null → FALLBACK_CHROME.
let mockWindowWidth = 1800;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWindowWidth, height: 900, scale: 1, fontScale: 1 }),
}));

// getLocalizedName — pass through the English `name`.
jest.mock('../../../i18n/localizedName', () => ({
  getLocalizedName: (row: { name: string }) => row.name,
}));

// filterParser — accept everything (no filtering in these tests).
jest.mock('../../../utils/filterParser', () => ({
  parseFilter: () => ({}),
  matchesFilter: () => true,
}));

// Selectors — no chart data / recipes needed.
jest.mock('../../../lib/cmdSelectors', () => ({
  useStockSeries: () => [],
  useRecipesUsingItem: () => [],
}));

// Palette bridge — no pending action; `request` is recordable so AC-11's
// + COUNT case can assert the EODCount bridge fired with the focused item.
const mockPaletteRequest = jest.fn();
jest.mock('../../../lib/paletteAction', () => {
  const fn: any = (selector: (s: any) => any) => selector({ pending: null });
  fn.getState = () => ({
    request: (...a: unknown[]) => mockPaletteRequest(...a),
    consume: () => {},
  });
  return { usePaletteAction: fn };
});

// TabStrip — functional stub: each tab is a pressable echoing its label; the
// rightSlot (EDIT/DELETE/+COUNT in the detail pane) is rendered so those
// affordances stay reachable. This lets case 8 press 'catalog.tsv'.
jest.mock('../../../components/cmd/TabStrip', () => {
  const React = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    TabStrip: ({ tabs, onChange, rightSlot }: any) => (
      <View>
        {tabs.map((t: any) => (
          <TouchableOpacity key={t.id} onPress={() => onChange(t.id)}>
            <Text>{t.label}</Text>
          </TouchableOpacity>
        ))}
        {rightSlot ?? null}
      </View>
    ),
  };
});

// Heavy / irrelevant children stubbed to null or a marker.
jest.mock('../../../components/cmd/StockHistoryChart', () => ({ StockHistoryChart: () => null }));
jest.mock('../../../components/cmd/PropertiesJson', () => ({ PropertiesJson: () => null }));
jest.mock('../../../components/cmd/SectionCaption', () => ({ SectionCaption: () => null }));
jest.mock('../../../components/cmd/ActivityRow', () => ({ ActivityRow: () => null }));
jest.mock('../../../components/cmd/ComingSoonPanel', () => ({ ComingSoonPanel: () => null }));
jest.mock('../../../components/cmd/ListSkeleton', () => ({ ListSkeleton: () => null }));
jest.mock('../../../components/cmd/FilterInput', () => ({ FilterInput: () => null }));
jest.mock('../../../components/cmd/StatusBar', () => ({ CmdStatusBar: () => null }));
// Marker when open so AC-11 can assert EDIT actually opens the drawer.
jest.mock('../../../components/cmd/IngredientFormDrawer', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    IngredientFormDrawer: ({ visible }: { visible?: boolean }) =>
      visible ? <Text>EDIT_DRAWER_OPEN</Text> : null,
  };
});

// confirmAction — auto-confirm + record, so AC-11's DELETE case can assert the
// gate fired BEFORE the destructive action (mirrors POsSection.test.tsx).
const mockConfirm = jest.fn(
  (_t: string, _m: string, onConfirm: () => void) => onConfirm(),
);
jest.mock('../../../utils/confirmAction', () => ({
  confirmAction: (...args: unknown[]) =>
    (mockConfirm as unknown as (...a: unknown[]) => void)(...args),
}));

// Toast — the DELETE handler fires a success toast; stub so jsdom stays quiet.
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// InventoryCatalogMode / CategoriesSection — identifiable markers for the
// boundary test.
jest.mock('../sections/InventoryCatalogMode', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  // Render the layout-provided topSlot (the items/catalog/categories TabStrip)
  // so tests can navigate BACK to items.tsv from catalog mode (SF-1 pin).
  return {
    __esModule: true,
    default: ({ topSlot }: { topSlot?: React.ReactNode }) => (
      <View>
        {topSlot ?? null}
        <Text>CATALOG_MODE_MARKER</Text>
      </View>
    ),
  };
});
jest.mock('../sections/CategoriesSection', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text>CATEGORIES_MARKER</Text> };
});

// The rest of the section-dispatch imports are never rendered (section is
// always 'Inventory') but are statically imported by the component — several
// transitively pull heavy deps (db.ts → supabase, sharePo → expo-sharing), so
// each must be stubbed with a hoisted jest.mock (a runtime loop does NOT hoist
// and would let the real modules load first).
jest.mock('../sections/VendorsSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/WasteLogSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/DashboardSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/EODCountSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/InventoryCountSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/ReceivingSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/RestockSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/ReorderSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/POsSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/RecipesSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/PrepRecipesSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/MenuImpactSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/ReconciliationSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/POSImportsSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/AuditLogSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/ReportsSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/BrandsSection', () => ({ __esModule: true, default: () => null }));
jest.mock('../sections/UsersSection', () => ({ __esModule: true, default: () => null }));

// useStore — controllable slice.
jest.mock('../../../store/useStore', () => {
  const state: any = {
    inventory: [],
    vendors: [],
    auditLog: [],
    currentUser: { id: 'u1' },
    currentStore: { id: 'store-1', name: 'Store One' },
    getItemStatus: (it: any) =>
      it.currentStock <= 0 ? 'out' : it.currentStock < it.parLevel ? 'low' : 'ok',
    deleteItem: jest.fn(),
    storeLoading: false,
    // reads pulled in by DetailPane tab bodies (usage/audit) — kept empty.
    posImports: [],
    recipes: [],
    prepRecipes: [],
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import InventoryDesktopLayout from '../InventoryDesktopLayout';
import { useStore } from '../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

function makeItem(over: Record<string, any> = {}) {
  return {
    id: over.id ?? 'i1', catalogId: 'c1', name: over.name ?? 'Tomato',
    category: 'Produce', unit: 'lb',
    costPerUnit: over.costPerUnit ?? 0.02, currentStock: over.currentStock ?? 3,
    parLevel: 10, averageDailyUsage: 0, safetyStock: 0,
    vendorId: 'v1', vendorName: 'Acme', usagePerPortion: 0,
    lastUpdatedBy: 'u1', lastUpdatedAt: '2026-07-01T00:00:00Z', eodRemaining: 0,
    storeId: 'store-1', casePrice: 0, caseQty: 1,
    subUnitSize: over.subUnitSize ?? 2000, subUnitUnit: 'g',
    i18nNames: {},
    ...over,
  };
}

function seed(items: Array<Record<string, any>>) {
  mockState.inventory = items.map(makeItem);
}

function renderLayout() {
  return render(
    <InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWindowWidth = 1800;
  mockIsDesktop.mockReturnValue(true);
  mockState.currentStore = { id: 'store-1', name: 'Store One' };
  mockState.vendors = [{ id: 'v1', name: 'Acme' }];
  seed([
    { id: 'i1', name: 'Tomato', costPerUnit: 0.02, currentStock: 3, subUnitSize: 2000 },
    { id: 'i2', name: 'Basil', costPerUnit: 1, currentStock: 5, subUnitSize: 1 },
  ]);
});

const CLOSE_ARIA = 'section.inventory.closeDetailAria';

describe('InventoryDesktopLayout — items.tsv detail-on-demand (spec 112)', () => {
  // ── AC-1 / case 1 ──
  it('renders the operational column headers + a data row at full width', () => {
    renderLayout();
    // Column headers (key-echoing T → the key path).
    expect(screen.getByText('section.inventory.nameCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.onHandCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.statusCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.costPerUnitCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.stockValueCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.vendorCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.categoryCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.lastCountedCol')).toBeTruthy();
    // A data row renders its name + cost + stock-value cells.
    expect(screen.getByText('Tomato')).toBeTruthy();
    expect(screen.getByText('$0.02')).toBeTruthy();
    expect(screen.getByText('$120')).toBeTruthy();
  });

  // ── AC-3 / case 2 ──
  it('shows NO detail pane on entry (pane absent, no ✕)', () => {
    renderLayout();
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  // ── AC-4/5 / case 3 ──
  it('opens on row click, closes via ✕', () => {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(CLOSE_ARIA));
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  it('closes via Esc (web keydown)', () => {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    // Simulate a web Escape keydown (Platform.OS mocked to 'web'). Wrap in
    // act() so the listener's setSelectedName(null) state update flushes
    // before the assertion.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  it('closes via same-row re-click (toggle-off)', () => {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    // Once open, 'Tomato' is in the tree twice (table row + detail hero);
    // press the FIRST (the table row) to toggle the same row off.
    fireEvent.press(screen.getAllByText('Tomato')[0]);
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  // ── AC-6 / case 4 ──
  it('swaps content on a different-row click without closing', () => {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    // Detail header hero shows the selected name (Type.display). Tomato is now
    // in the tree twice (table row + detail hero).
    expect(screen.getAllByText('Tomato').length).toBeGreaterThanOrEqual(2);

    fireEvent.press(screen.getByText('Basil'));
    // Pane still open (✕ present).
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    // Detail now shows Basil (twice: row + hero).
    expect(screen.getAllByText('Basil').length).toBeGreaterThanOrEqual(2);
  });

  // ── AC-8b / case 5 ──
  it('clears selection (closes the pane) when the store switches', () => {
    const { rerender } = renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();

    // Simulate a store switch: change currentStore.id in the slice + re-render.
    mockState.currentStore = { id: 'store-2', name: 'Store Two' };
    rerender(
      <InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />,
    );
    // The store-id effect fires → selection cleared → pane absent.
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  // ── AC-8 / code-review SF-1 — the store-switch clear is SCOPED to the
  // per-store tab. A store switch that happens while the operator is on
  // catalog.tsv must NOT clear the shared `selectedName` (the catalog rows are
  // brand-wide; clearing would let InventoryCatalogMode's auto-select-first
  // jump the open detail to a different row). Proof: select on items.tsv, flip
  // to catalog, switch stores there, flip back — the selection SURVIVED.
  it('does NOT clear selection when the store switches while on the catalog tab', () => {
    // Store-2 carries a same-name Tomato row (the brand-catalog norm) so the
    // name-keyed selection can resolve to an item after the switch.
    mockState.inventory = [
      ...mockState.inventory,
      makeItem({ id: 'i3', name: 'Tomato', storeId: 'store-2' }),
    ];
    const { rerender } = renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();

    // Flip to catalog.tsv (the mocked InventoryCatalogMode marker renders).
    fireEvent.press(screen.getByText('catalog.tsv'));
    expect(screen.getByText('CATALOG_MODE_MARKER')).toBeTruthy();

    // Store switch WHILE on the catalog tab.
    mockState.currentStore = { id: 'store-2', name: 'Store Two' };
    rerender(
      <InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />,
    );

    // Back to items.tsv — the selection survived (the scoped effect skipped
    // the clear), so the pane is open for store-2's Tomato. Under the pre-fix
    // unscoped effect this clear would have fired and the pane would be gone.
    fireEvent.press(screen.getByText('items.tsv'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
  });

  // ── AC-2 / ★ / case 6 ──
  it('renders identical ★ money strings in the table cell and the detail header', () => {
    renderLayout();
    // Table cell strings present before opening the pane.
    expect(screen.getByText('$0.02')).toBeTruthy();
    expect(screen.getByText('$120')).toBeTruthy();

    // Open the pane → the DetailPane header StatCards render the SAME strings
    // (produced by the SAME itemMoney helpers). Both now appear ≥2× (table +
    // header) — the single-definition equality proof.
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getAllByText('$0.02').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('$120').length).toBeGreaterThanOrEqual(2);
  });

  // ── AC-8 / case 8 ──
  it('keeps the catalog.tsv boundary — switching viewMode renders InventoryCatalogMode', () => {
    renderLayout();
    // items.tsv is default → no catalog marker yet.
    expect(screen.queryByText('CATALOG_MODE_MARKER')).toBeNull();
    // Press the catalog.tsv tab (functional TabStrip stub calls onChange).
    fireEvent.press(screen.getByText('catalog.tsv'));
    expect(screen.getByText('CATALOG_MODE_MARKER')).toBeTruthy();
  });

  // ── AC-7 fix (post-impl) — the collapse tiers must REACT after mount ──
  // Regression for the onLayout-fires-once defect: the table width is derived
  // arithmetically from windowWidth − chrome − (pane while open), so opening
  // the pane must shrink the rendered column set (not overflow all 8).
  const COL_KEYS = [
    'section.inventory.nameCol', 'section.inventory.onHandCol', 'section.inventory.statusCol',
    'section.inventory.costPerUnitCol', 'section.inventory.stockValueCol',
    'section.inventory.vendorCol', 'section.inventory.categoryCol', 'section.inventory.lastCountedCol',
  ];
  const visibleColCount = () => COL_KEYS.filter((k) => screen.queryByText(k) !== null).length;

  it('REDUCES the column count when the pane opens (AC-7 pane-open re-tier)', () => {
    // window 1800 → closed tableWidth = 1800 − 260 = 1540 (≥1400 → all 8).
    renderLayout();
    expect(visibleColCount()).toBe(8);
    expect(screen.getByText('section.inventory.lastCountedCol')).toBeTruthy();

    // Open the pane → tableWidth = 1800 − 260 − 620(PANE) = 920 (<1200 → 6-col
    // floor). last-counted AND category drop; the always-6 survive. If the
    // width were frozen (the old onLayout-once bug) this would still be 8.
    fireEvent.press(screen.getByText('Tomato'));
    expect(visibleColCount()).toBe(6);
    expect(screen.queryByText('section.inventory.lastCountedCol')).toBeNull();
    expect(screen.queryByText('section.inventory.categoryCol')).toBeNull();
    // Floor survivors still render.
    expect(screen.getByText('section.inventory.vendorCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.stockValueCol')).toBeTruthy();
    expect(screen.getByText('section.inventory.costPerUnitCol')).toBeTruthy();
  });

  it('re-tiers by window width — a narrower window drops last-counted (7 cols)', () => {
    // Fresh render at a smaller window: 1500 − 260 = 1240 → tier 1200–1399 →
    // last-counted dropped, category kept. Pins that the arithmetic derivation
    // (not a frozen mount measurement) drives the tier off windowWidth.
    mockWindowWidth = 1500;
    renderLayout();
    expect(visibleColCount()).toBe(7);
    expect(screen.queryByText('section.inventory.lastCountedCol')).toBeNull();
    expect(screen.getByText('section.inventory.categoryCol')).toBeTruthy();
  });
});

// ── AC-10 — below-desktop narrow tier (list ↔ full-width detail swap) ──
// The test-engineer review flagged this AC as NOT TESTED: every case above
// forces useIsDesktop → true. These pin the <1100 branch: the InventoryRow
// list renders full-width (no table header), selecting swaps to a full-width
// detail (✕ visible), and ✕ returns to the list.
describe('AC-10 — below-desktop narrow tier', () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(false);
    mockWindowWidth = 800;
  });

  it('renders the InventoryRow list with NO table header and NO detail on entry', () => {
    renderLayout();
    // Rows render (InventoryRow is real — item names visible)…
    expect(screen.getByText('Tomato')).toBeTruthy();
    expect(screen.getByText('Basil')).toBeTruthy();
    // …but the desktop table header is absent…
    expect(screen.queryByText('section.inventory.nameCol')).toBeNull();
    expect(screen.queryByText('section.inventory.stockValueCol')).toBeNull();
    // …and no detail is open (✕ absent).
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  it('selecting a row swaps to the full-width detail (list hidden), ✕ returns to the list', () => {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    // Detail replaces the list: ✕ present, the OTHER row is gone.
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
    expect(screen.queryByText('Basil')).toBeNull();
    // ✕ returns to the full list.
    fireEvent.press(screen.getByLabelText(CLOSE_ARIA));
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
    expect(screen.getByText('Basil')).toBeTruthy();
  });
});

// ── AC-11 — detail-header actions (EDIT / DELETE / + COUNT) with the pane open ──
// Also flagged NOT TESTED. The handlers are a verbatim carry-forward from the
// pre-spec layout, but the AC lists them explicitly — pin each: DELETE is
// confirm-gated then deletes AND closes the pane; EDIT opens the drawer;
// + COUNT bridges to EODCount with the item focused.
describe('AC-11 — detail-header actions with the pane open', () => {
  function openTomatoPane() {
    renderLayout();
    fireEvent.press(screen.getByText('Tomato'));
    expect(screen.getByLabelText(CLOSE_ARIA)).toBeTruthy();
  }

  it('DELETE is confirm-gated: deleteItem fires with the item id and the pane closes', () => {
    openTomatoPane();
    fireEvent.press(screen.getByText('DELETE'));
    // The confirm gate fired BEFORE the destructive action…
    expect(mockConfirm).toHaveBeenCalled();
    // …the store action ran with the selected item's id…
    expect(mockState.deleteItem).toHaveBeenCalledWith('i1');
    // …and the pane closed (selection cleared).
    expect(screen.queryByLabelText(CLOSE_ARIA)).toBeNull();
  });

  it('EDIT opens the IngredientFormDrawer', () => {
    openTomatoPane();
    expect(screen.queryByText('EDIT_DRAWER_OPEN')).toBeNull();
    fireEvent.press(screen.getByText('EDIT'));
    expect(screen.getByText('EDIT_DRAWER_OPEN')).toBeTruthy();
  });

  it('+ COUNT bridges to the EODCount section with the item focused', () => {
    openTomatoPane();
    fireEvent.press(screen.getByText('+ COUNT'));
    expect(mockPaletteRequest).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'EODCount', eodFocusItemId: 'i1' }),
    );
  });
});
