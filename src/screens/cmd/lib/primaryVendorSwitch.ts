// src/screens/cmd/lib/primaryVendorSwitch.ts
//
// Spec 201 (§9) — the ONE "switch primary vendor" flow shared by the desktop
// ReorderSection row and the phone VendorOrderCard row, so the two admin tiers
// cannot drift on the confirm copy, the refusal toast or the outcome handling.
// The store action owns the pre-check / write / revert / reload
// (`switchItemPrimaryVendor`); this module only wires the UI around it:
//   - `confirm` wraps the callback-based `confirmAction` in a Promise (the
//     cross-platform confirm — web `window.confirm`, native `Alert.alert`);
//   - `'refused'` (3c — the item is already on today's order for the current
//     primary vendor, from the pre-check OR the server backstop) → error toast;
//   - `'switched'` → success toast (the reorder reload already ran);
//   - `'failed'` → nothing here: the store already called notifyBackendError;
//   - `'cancelled'` → nothing.
import Toast from 'react-native-toast-message';
import { confirmAction } from '../../../utils/confirmAction';
import type { PrimaryVendorSwitchResult } from '../../../store/useStore';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type PrimaryVendorSwitchAction = (args: {
  itemId: string;
  fromVendorId: string;
  toVendorId: string;
  asOfDate: string;
  confirm: () => Promise<boolean>;
}) => Promise<PrimaryVendorSwitchResult>;

export async function runPrimaryVendorSwitch(args: {
  itemId: string;
  itemName: string;
  from: { vendorId: string; vendorName: string };
  to: { vendorId: string; vendorName: string };
  /** The reorder as-of date on screen (YYYY-MM-DD). */
  asOfDate: string;
  T: Translate;
  switchItemPrimaryVendor: PrimaryVendorSwitchAction;
}): Promise<PrimaryVendorSwitchResult> {
  const { itemId, itemName, from, to, asOfDate, T, switchItemPrimaryVendor } = args;
  const vars = { item: itemName, from: from.vendorName, to: to.vendorName };
  const confirm = () =>
    new Promise<boolean>((resolve) => {
      confirmAction(
        T('section.reorder.switchConfirmTitle', vars),
        T('section.reorder.switchConfirmBody', vars),
        () => resolve(true),
        T('section.reorder.switchConfirmCta'),
        () => resolve(false),
      );
    });
  const result = await switchItemPrimaryVendor({
    itemId,
    fromVendorId: from.vendorId,
    toVendorId: to.vendorId,
    asOfDate,
    confirm,
  });
  if (result === 'refused') {
    Toast.show({
      type: 'error',
      text1: T('section.reorder.switchRefusedTitle'),
      text2: T('section.reorder.switchRefused', vars),
      visibilityTime: 5000,
    });
  } else if (result === 'switched') {
    Toast.show({
      type: 'success',
      text1: T('section.reorder.switchedToast', vars),
      visibilityTime: 4000,
    });
  }
  return result;
}
