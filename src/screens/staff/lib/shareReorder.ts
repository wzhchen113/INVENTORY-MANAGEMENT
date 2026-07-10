// src/screens/staff/lib/shareReorder.ts — cross-platform reorder export/share.
//
// Spec 089 (C) = Option 2 (PDF EVERYWHERE, user-approved). CSV + plain-text
// + PDF all work on BOTH web AND native:
//   - CSV / text  → web: Blob + anchor download (same shape as the admin
//                   `triggerDownload`). native: write a temp file to the
//                   cache dir via expo-file-system, then open the OS share
//                   sheet via expo-sharing.
//   - PDF         → both platforms via `expo-print` (HTML → PDF). On native
//                   we then share the generated file; on web expo-print
//                   opens the browser print dialog (its react-native-web
//                   shim), which is the web "export PDF" affordance.
//
// The PURE content builders (buildReorderCsv / buildReorderText /
// buildReorderPdfHtml) live in the shared `src/utils/reorderExport.ts`
// (jest-covered, theme-free). THIS module is the IMPURE platform-branched
// I/O orchestrator (staff-local). Both wrap errors → a staff bottom Toast,
// never throw to the caller.
//
// The caller passes the DERIVED payload (primary vendors + client-recomputed
// kpis) so the exported contents match the on-screen filtered + as-of view
// (same invariant the admin enforces).

import { Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import type { ReorderPayload } from '../../../types';
import type { Locale } from '../../../i18n';
import { slugifyStore, todayLocalIso } from '../../../utils/reorderExport';
// Staff exports are cost-free (owner decision 2026-07) — the price-stripped
// mirrors of the shared builders. The shared util stays intact for admin.
import {
  buildStaffReorderCsv,
  buildStaffReorderPdfHtml,
  buildStaffReorderText,
} from './reorderExportStaff';

type Format = 'csv' | 'text' | 'pdf';

function asOfFromPayload(payload: ReorderPayload): string {
  return (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
}

function filenameBase(payload: ReorderPayload, storeName: string): string {
  return `IMR_Reorder_${slugifyStore(storeName)}_${asOfFromPayload(payload)}`;
}

function successToast(format: Format, filename: string): void {
  Toast.show({
    type: 'success',
    text1:
      format === 'csv'
        ? 'CSV exported'
        : format === 'text'
          ? 'Text exported'
          : 'PDF exported',
    text2: filename,
    position: 'bottom',
    visibilityTime: 3000,
  });
}

function failureToast(format: Format, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // eslint-disable-next-line no-console
  console.warn(`[imr-staff] reorder ${format} export failed:`, message);
  Toast.show({
    type: 'error',
    text1:
      format === 'csv'
        ? 'CSV export failed'
        : format === 'text'
          ? 'Text export failed'
          : 'PDF export failed',
    text2: message.slice(0, 120) || 'Unable to build the file',
    position: 'bottom',
    visibilityTime: 4000,
  });
}

// ── web download (Blob + anchor) — mirrors the admin triggerDownload ──
function webDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has a chance to commit the download.
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

// ── native: write a temp file to the cache dir, then open the share sheet ──
async function nativeShare(content: string, filename: string, mimeType: string): Promise<void> {
  // expo-file-system v19 (SDK 54) object API: write to the cache dir
  // (`Paths.cache`) — ephemeral, no permission prompt (NOT the document dir).
  // `create({ overwrite: true })` then a synchronous `write(string)`.
  // Check share-sheet availability BEFORE writing the temp file, so an
  // unavailable platform (e.g. web-in-Expo-Go) doesn't leave an orphaned
  // file behind in the cache dir.
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device');
  }
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: 'Share reorder list' });
}

/** Export/share the reorder list as CSV. */
export async function shareReorderCsv(
  payload: ReorderPayload,
  storeName: string,
  locale: Locale = 'en',
): Promise<void> {
  try {
    const content = buildStaffReorderCsv(payload, locale);
    const filename = `${filenameBase(payload, storeName)}.csv`;
    const mimeType = 'text/csv';
    if (Platform.OS === 'web') {
      webDownload(content, filename, 'text/csv;charset=utf-8;');
    } else {
      await nativeShare(content, filename, mimeType);
    }
    successToast('csv', filename);
  } catch (err) {
    failureToast('csv', err);
  }
}

/** Export/share the reorder list as plain text. */
export async function shareReorderText(
  payload: ReorderPayload,
  storeName: string,
  locale: Locale = 'en',
): Promise<void> {
  try {
    const content = buildStaffReorderText(payload, storeName, locale);
    const filename = `${filenameBase(payload, storeName)}.txt`;
    const mimeType = 'text/plain';
    if (Platform.OS === 'web') {
      webDownload(content, filename, 'text/plain;charset=utf-8;');
    } else {
      await nativeShare(content, filename, mimeType);
    }
    successToast('text', filename);
  } catch (err) {
    failureToast('text', err);
  }
}

/**
 * Export/share the reorder list as PDF via expo-print (HTML → PDF).
 *   - web    → `Print.printAsync({ html })` opens the browser print dialog
 *              (expo-print's react-native-web shim) — the web PDF affordance.
 *   - native → `Print.printToFileAsync({ html })` renders a temp PDF, then
 *              the OS share sheet shares it.
 */
export async function shareReorderPdf(
  payload: ReorderPayload,
  storeName: string,
  locale: Locale = 'en',
): Promise<void> {
  try {
    const html = buildStaffReorderPdfHtml(payload, storeName, locale);
    const filename = `${filenameBase(payload, storeName)}.pdf`;
    if (Platform.OS === 'web') {
      // expo-print on web drives window.print via an iframe; there is no
      // file artifact to name.
      await Print.printAsync({ html });
    } else {
      // Check share-sheet availability BEFORE rendering the PDF, so an
      // unavailable share sheet doesn't leave an orphaned temp PDF behind.
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        throw new Error('Sharing is not available on this device');
      }
      const { uri } = await Print.printToFileAsync({ html });
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Share reorder list',
        UTI: 'com.adobe.pdf',
      });
    }
    successToast('pdf', filename);
  } catch (err) {
    failureToast('pdf', err);
  }
}
