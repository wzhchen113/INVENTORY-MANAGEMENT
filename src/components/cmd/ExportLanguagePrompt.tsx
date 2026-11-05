// src/components/cmd/ExportLanguagePrompt.tsx
//
// Spec 183 — the per-export language prompt for the Ordering page's
// CSV / PDF / Quick-order list actions (desktop ReorderSection and the phone
// PhoneOrdering overflow sheet).
//
// Contract (spec 183 §1b):
//   - MOUNT = OPEN. There is no `visible` prop; the host mounts the prompt only
//     while an export is pending. The selection is seeded from the CURRENT UI
//     locale on every mount, so the last pick is never remembered (AC-6/AC-8).
//   - EXPORT-SCOPED. The picked language only reaches `onConfirm`. This
//     component never calls `setLocale` and never writes `profiles` or the
//     persisted locale preference (AC-8).
//   - ONCE-GUARD. The first of {confirm, cancel} wins; every later call of
//     either is a no-op (double-click on Continue, Continue + backdrop tap).
//   - SYNCHRONOUS CONFIRM. Continue calls `onConfirm(picked)` directly — no
//     await / timer before it — so the host's export path can take its
//     `{ storeId, referenceDate }` snapshot before ITS first await (AC-15).
//   - EVERY DISMISS IS CANCEL. The Cancel button, the backdrop tap and the RN
//     `Modal.onRequestClose` (Android back; Escape on web via react-native-web's
//     ModalContent) all route to the guarded `onCancel` (AC-9).
//   - STORE SWITCH CLOSES IT. If the live `currentStore.id` stops matching the
//     store the prompt was opened for, it renders nothing and cancels, so a
//     file / draft PO can never come from a prompt opened for another store.
//
// The option control is the spec-139 `ExportLocalePicker`, restricted per
// format (PDF has no 中文 — jsPDF's Helvetica has no CJK glyphs).

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useIsPhone } from '../../theme/breakpoints';
import { useT } from '../../hooks/useT';
import { useLocale } from '../../hooks/useLocale';
import { useStore } from '../../store/useStore';
import type { Locale } from '../../i18n';
import { ResponsiveSheet } from './ResponsiveSheet';
import { ExportLocalePicker } from './ExportLocalePicker';

export type ReorderExportFormat = 'csv' | 'pdf' | 'quickOrder';

const ALL_LOCALES: readonly Locale[] = ['en', 'es', 'zh-CN'];
const PDF_LOCALES: readonly Locale[] = ['en', 'es'];

/** Pure: pdf → ['en','es']; csv | quickOrder → ['en','es','zh-CN']. */
export function exportLocaleOptions(format: ReorderExportFormat): readonly Locale[] {
  return format === 'pdf' ? PDF_LOCALES : ALL_LOCALES;
}

/** Pure: uiLocale if it is in exportLocaleOptions(format), else 'en'.
 *  Covers AC-6's zh-CN → en PDF exception AND an undefined / unknown uiLocale. */
export function defaultExportLocale(
  format: ReorderExportFormat,
  uiLocale: Locale | undefined,
): Locale {
  return uiLocale && exportLocaleOptions(format).includes(uiLocale) ? uiLocale : 'en';
}

const FORMAT_KEY: Record<ReorderExportFormat, string> = {
  csv: 'section.reorder.exportLanguagePrompt.formatCsv',
  pdf: 'section.reorder.exportLanguagePrompt.formatPdf',
  quickOrder: 'section.reorder.exportLanguagePrompt.formatQuickOrder',
};

interface ExportLanguagePromptProps {
  format: ReorderExportFormat;
  vendorName: string;
  /** The store id the prompt was OPENED for (see "Store switch" above). */
  storeId: string;
  /** Called at most once per mount, synchronously, from the Continue press. */
  onConfirm: (locale: Locale) => void;
  /** Called at most once per mount, from any dismiss path. */
  onCancel: () => void;
}

export const ExportLanguagePrompt: React.FC<ExportLanguagePromptProps> = ({
  format,
  vendorName,
  storeId,
  onConfirm,
  onCancel,
}) => {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  const uiLocale = useLocale();
  const liveStoreId = useStore((s) => s.currentStore?.id);
  const [picked, setPicked] = React.useState<Locale>(() => defaultExportLocale(format, uiLocale));
  const firedRef = React.useRef(false);

  const cancel = React.useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onCancel();
  }, [onCancel]);

  const confirm = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onConfirm(picked);
  };

  // Store switch while open → render nothing now, cancel in an effect so the
  // host clears its pending state (a switch back must not resurrect it).
  const storeMismatch = liveStoreId !== storeId;
  React.useEffect(() => {
    if (storeMismatch) cancel();
  }, [storeMismatch, cancel]);

  if (storeMismatch) return null;

  const aria = T('section.reorder.exportLanguagePrompt.aria');

  const header = (
    <View
      style={{
        paddingHorizontal: 18,
        paddingTop: 14,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        backgroundColor: C.panel,
        gap: 4,
      }}
    >
      <Text style={{ fontFamily: sans(600), fontSize: 14.5, color: C.fg }} numberOfLines={1}>
        {T('section.reorder.exportLanguagePrompt.title')}
      </Text>
      <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg3 }} numberOfLines={1}>
        {T('section.reorder.exportLanguagePrompt.subtitle', { format: T(FORMAT_KEY[format]), vendor: vendorName })}
      </Text>
    </View>
  );

  const btnBase = {
    minHeight: 44,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CmdRadius.sm,
    ...(isPhone ? { flex: 1 } : {}),
  } as const;

  const footer = (
    <View
      style={{
        paddingHorizontal: 18,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: C.border,
        backgroundColor: C.panel,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
      }}
    >
      <TouchableOpacity
        testID="export-lang-cancel"
        onPress={cancel}
        accessibilityRole="button"
        accessibilityLabel={T('common.cancel')}
        style={{ ...btnBase, borderWidth: 1, borderColor: C.borderStrong }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.5, color: C.fg2 }}>
          {T('common.cancel')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="export-lang-confirm"
        onPress={confirm}
        accessibilityRole="button"
        accessibilityLabel={T('section.reorder.exportLanguagePrompt.confirm')}
        style={{ ...btnBase, borderWidth: 1, borderColor: C.accent, backgroundColor: C.accent }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, letterSpacing: 0.5, color: C.accentFg }}>
          {T('section.reorder.exportLanguagePrompt.confirm')}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible
      onClose={cancel}
      presentation={{ desktop: 'center-modal', phone: 'bottom-sheet' }}
      tabletSheetHeight={0.45}
      accessibilityLabel={aria}
      header={header}
      footer={footer}
    >
      <View
        testID="export-lang-prompt"
        style={{ paddingHorizontal: 18, paddingVertical: 16, gap: 12, width: '100%', maxWidth: 380 }}
      >
        <ExportLocalePicker
          value={picked}
          onChange={setPicked}
          options={exportLocaleOptions(format)}
          size="touch"
          accessibilityLabel={aria}
          testIDPrefix="export-lang-option"
        />
        {/* Spec 183 §1b.9 — REMOVABLE (owner did not ask for it). Deleting this
            block + the `pdfLatinOnly` key in the three catalogs + its one test
            assertion removes it; nothing else depends on it. */}
        {format === 'pdf' ? (
          <Text
            testID="export-lang-pdf-hint"
            style={{ fontFamily: sans(400), fontSize: 12, lineHeight: 17, color: C.fg3 }}
          >
            {T('section.reorder.exportLanguagePrompt.pdfLatinOnly')}
          </Text>
        ) : null}
      </View>
    </ResponsiveSheet>
  );
};
