import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useLocale } from '../../hooks/useLocale';
import { useIsPhone } from '../../theme/breakpoints';
import { getLocalizedName } from '../../i18n/localizedName';
import { ResponsiveSheet } from './ResponsiveSheet';
import type { StoreStockPreview } from '../../lib/db';
import { plural, type StockRunReport } from '../../utils/stockResult';
import type { Store } from '../../types';

interface Props {
  /** The store being stocked. */
  store: Store;
  brandId: string;
  onClose: () => void;
  /** Fired after a successful run, before `onClose`. Failures keep the dialog open. */
  onStocked: (report: StockRunReport) => void;
}

// Spec 184 — copy a store's missing items from another store of the same brand.
//
// The parent mounts this per open, so each open starts with no picks and a fresh
// preview. The preview is one read holding every source's numbers, so picking a
// source costs no round trip. Copy is hardcoded English, matching StoreFormDrawer
// and StoresTab, apart from catalog names, which are localized.
//
// There is deliberately no selection of the source's items (R-6, AC-37). The only
// ticks are on the list of rows no store carries. The AC-30 statement is the
// confirm step: nothing is written until the operator presses STOCK under it.
export const StockStoreDialog: React.FC<Props> = ({ store, brandId, onClose, onStocked }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const locale = useLocale();
  const loadStoreStockPreview = useStore((s) => s.loadStoreStockPreview);
  const stockStoreFromStore = useStore((s) => s.stockStoreFromStore);

  const [status, setStatus] = React.useState<'loading' | 'failed' | 'ready'>('loading');
  const [preview, setPreview] = React.useState<StoreStockPreview | null>(null);
  const [sourceId, setSourceId] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(() => new Set());
  const [submitting, setSubmitting] = React.useState(false);
  // AC-35 — state only flips on the next render, so a second press in the same
  // tick would still read `submitting === false`. The ref can't be raced.
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadStoreStockPreview(brandId, store.id).then((p) => {
      if (cancelled) return;
      setPreview(p ?? null);
      setStatus(p ? 'ready' : 'failed');
    });
    return () => { cancelled = true; };
  }, [brandId, store.id, loadStoreStockPreview]);

  const sources = preview?.sources ?? [];
  const uncarried = preview?.uncarried ?? [];
  const source = sources.find((s) => s.storeId === sourceId) ?? null;
  const canSubmit = !!source && (source.itemsToAdd > 0 || ticked.size > 0);
  const rowsToAdd = (source?.itemsToAdd ?? 0) + ticked.size;

  const close = () => {
    if (inFlight.current) return;
    onClose();
  };

  const submit = async () => {
    if (!source || !canSubmit || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      // Only the ticked rows that are still on the list (AC-32).
      const extras = uncarried.filter((u) => ticked.has(u.catalogId)).map((u) => u.catalogId);
      // Resolves null after notifyBackendError, and never rejects. On failure the
      // dialog stays open with the picks intact (AC-35).
      const result = await stockStoreFromStore(store.id, source.storeId, extras);
      if (!result) return;
      onStocked({
        targetStoreId: store.id,
        targetName: store.name,
        sourceName: source.name,
        result,
      });
      onClose();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const toggleTick = (catalogId: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(catalogId)) next.delete(catalogId);
      else next.add(catalogId);
      return next;
    });
  };

  const caption = {
    fontFamily: mono(700),
    fontSize: 9.5,
    color: C.fg3,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  };
  const body = { fontFamily: sans(400), fontSize: 13, color: C.fg };
  const note = { fontFamily: sans(400), fontSize: 11.5, color: C.fg3 };

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>STOCK</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg, flex: 1 }} numberOfLines={1}>
        {store.name}
      </Text>
      {isPhone ? (
        <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        backgroundColor: C.panel,
      }}
    >
      <TouchableOpacity
        testID="stock-cancel"
        onPress={close}
        disabled={submitting}
        accessibilityRole="button"
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.border,
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      {/* AC-29, AC-31 — with nothing to do, no submit is offered at all. */}
      {canSubmit ? (
        <TouchableOpacity
          testID="stock-submit"
          onPress={submit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={`Stock ${store.name} from ${source?.name ?? ''}`}
          style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: CmdRadius.sm,
            backgroundColor: submitting ? C.panel2 : C.accent,
            opacity: submitting ? 0.6 : 1,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: submitting ? C.fg3 : C.accentFg }}>
            {submitting ? 'STOCKING…' : `STOCK ${plural(rowsToAdd, 'ITEM', 'ITEMS')}`}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <ResponsiveSheet
      visible
      onClose={close}
      desktopWidth={480}
      header={header}
      footer={footer}
      accessibilityLabel={`Stock ${store.name}`}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 16 }}>
        {status === 'loading' ? (
          <Text testID="stock-preview-loading" style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            loading stock options…
          </Text>
        ) : status === 'failed' ? (
          <Text testID="stock-preview-failed" style={{ ...body, color: C.danger }}>
            Could not load stock options. Close this and try again.
          </Text>
        ) : sources.length === 0 ? (
          <Text testID="stock-no-source" style={body}>
            No other store in this brand has items, so there is no store to copy from. Add this
            store’s items by hand or by CSV import.
          </Text>
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <Text style={caption}>Copy from</Text>
              {sources.map((s) => {
                const selected = s.storeId === sourceId;
                return (
                  <TouchableOpacity
                    key={s.storeId}
                    testID={`stock-source-${s.storeId}`}
                    onPress={() => setSourceId(s.storeId)}
                    disabled={submitting}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, checked: selected }}
                    accessibilityLabel={`${s.name}, ${plural(s.itemCount, 'item')}`}
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: selected ? C.accent : C.border,
                      backgroundColor: selected ? C.accentBg : C.panel2,
                    }}
                  >
                    <View
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: selected ? C.accent : C.borderStrong,
                        backgroundColor: selected ? C.accent : 'transparent',
                      }}
                    />
                    <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                      {s.name}
                    </Text>
                    {s.status !== 'active' ? (
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3 }}>INACTIVE</Text>
                    ) : null}
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>
                      {plural(s.itemCount, 'item')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* AC-30, AC-31 — what a press would do, before anything is written. */}
            {source ? (
              <View
                testID="stock-plan"
                style={{
                  gap: 6,
                  padding: 12,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.border,
                  backgroundColor: C.panel2,
                }}
              >
                {source.itemsToAdd === 0 ? (
                  <Text testID="stock-nothing-to-add" style={body}>
                    {store.name} already has everything from {source.name}.
                  </Text>
                ) : (
                  <>
                    <Text testID="stock-plan-counts" style={body}>
                      {plural(source.itemsToAdd, 'item')} from {source.name} will be added;{' '}
                      {source.itemsAlreadyAtTarget} of {source.itemCount}{' '}
                      {source.itemsAlreadyAtTarget === 1 ? 'is' : 'are'} already at {store.name}.
                    </Text>
                    {source.itemsNoVendorLink > 0 ? (
                      <Text testID="stock-plan-no-link" style={{ ...body, color: C.warn }}>
                        {source.itemsNoVendorLink} of those {source.itemsNoVendorLink === 1 ? 'has' : 'have'} no
                        vendor link, so {source.itemsNoVendorLink === 1 ? 'it won’t' : 'they won’t'} appear at EOD until linked.
                      </Text>
                    ) : null}
                    <Text testID="stock-plan-zero-stock" style={body}>
                      Stock starts at 0. The first count sets it.
                    </Text>
                  </>
                )}
                {source.carriedElsewhereCount > 0 ? (
                  <Text testID="stock-plan-elsewhere" style={{ ...body, color: C.fg2 }}>
                    Other stores in this brand carry {plural(source.carriedElsewhereCount, 'more item')} that
                    neither {source.name} nor {store.name} has. Running STOCK again from another store adds
                    them.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* AC-32 — absent altogether when the brand has no such rows. */}
            {uncarried.length > 0 ? (
              <View testID="stock-uncarried" style={{ gap: 6 }}>
                <Text style={caption}>Carried by no store (optional)</Text>
                <Text testID="stock-uncarried-note" style={note}>
                  Ticked rows are added with blank par and cost and no vendor link, so they won’t show at
                  EOD until linked. Some may be ingredients removed on purpose.
                </Text>
                <ScrollView
                  testID="stock-uncarried-list"
                  nestedScrollEnabled
                  style={{
                    maxHeight: 220,
                    borderWidth: 1,
                    borderColor: C.border,
                    borderRadius: CmdRadius.sm,
                  }}
                >
                  {uncarried.map((u, i) => {
                    const checked = ticked.has(u.catalogId);
                    const name = getLocalizedName({ name: u.name, i18nNames: u.i18nNames }, locale);
                    return (
                      <TouchableOpacity
                        key={u.catalogId}
                        testID={`stock-uncarried-${u.catalogId}`}
                        onPress={() => toggleTick(u.catalogId)}
                        disabled={submitting}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        accessibilityLabel={name}
                        style={{
                          minHeight: 44,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
                        }}
                      >
                        <View
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: 2,
                            borderWidth: 1,
                            borderColor: checked ? C.accent : C.borderStrong,
                            backgroundColor: checked ? C.accent : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {checked ? (
                            <Text style={{ fontFamily: mono(700), fontSize: 10, lineHeight: 12, color: C.accentFg }}>✓</Text>
                          ) : null}
                        </View>
                        <Text style={{ fontFamily: sans(500), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
                          {[u.category, u.unit].filter(Boolean).join(' · ')}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </ResponsiveSheet>
  );
};
