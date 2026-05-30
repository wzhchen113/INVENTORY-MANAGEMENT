import { AuditEvent, AuditAction } from '../types';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Spec 039 — English canonical → enum.auditAction.* camelCase dot-key.
// Source of truth for the mapping between AuditAction enum strings and
// i18n keys. Covers every value in the `AuditAction` union; if a future
// spec adds a new audit action, both this map AND the catalog need an
// entry (the architect-recommended jest assertion in `enumLabels.test.ts`
// catches drift).
const KEY_BY_ACTION: Record<AuditAction, string> = {
  'EOD entry':           'eodEntry',
  'Item edit':           'itemEdit',
  'Item added':          'itemAdded',
  'Item deleted':        'itemDeleted',
  'POS import':          'posImport',
  'Waste log':           'wasteLog',
  'User invite':         'userInvite',
  'User deleted':        'userDeleted',
  'Recipe saved':        'recipeSaved',
  'Recipe deleted':      'recipeDeleted',
  'Prep recipe saved':   'prepRecipeSaved',
  'Prep recipe deleted': 'prepRecipeDeleted',
  'Stock adjusted':      'stockAdjusted',
  'Order missed':        'orderMissed',
};

// Spec 039 — now takes T. Falls back to `action.toLowerCase()` for any
// unmapped action — preserves pre-i18n behavior so a future audit-action
// addition doesn't render as `undefined` if its catalog entry hasn't
// landed yet.
export function formatAuditAction(
  event: Pick<AuditEvent, 'action'>,
  T: TFn,
): string {
  const key = KEY_BY_ACTION[event.action];
  return key ? T(`enum.auditAction.${key}`) : event.action.toLowerCase();
}
