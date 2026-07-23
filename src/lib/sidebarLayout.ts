// src/lib/sidebarLayout.ts
//
// Spec 008 §7 — pure utilities for the per-user Cmd UI sidebar override.
// No React, no DOM, no store imports — testable in isolation.
//
// Three exports:
//   - applySidebarOverride(default, override) — merge default groups +
//     user override list into the rendered group structure.
//   - produceOverride(rendered, default)     — diff the user's edited
//     rendered groups back into a minimal override list.
//   - isValidOverride(unknown)               — defensive shape guard for
//     auth.ts to gate JSON loaded from profiles.sidebar_layout.
//
// Override-list shape (architect §2):
//   { v: 1, items: [{ id, group?, order?, hidden? }, ...] }
//
// The merge algorithm preserves the architect's §7 "future items
// auto-append to default group" semantic: an item present in
// defaultGroups but absent from the override list inherits its
// default group + default order. Stale override entries (id no longer
// in default) are dropped silently.

import type { TreeItem } from '../components/cmd/TreeGroup';
import type {
  SidebarLayoutOverride,
  SidebarLayoutOverrideEntry,
} from '../types';

/**
 * Local shape — same as `SidebarGroup` exported from
 * `src/components/cmd/Sidebar.tsx`. Duplicated here only to avoid a
 * circular-ish dep (Sidebar.tsx imports from this module via its consumer).
 * Structurally identical and type-compatible.
 */
export interface SidebarGroup {
  label: string;
  items: TreeItem[];
}

export type { TreeItem, SidebarLayoutOverride, SidebarLayoutOverrideEntry };

/**
 * Defensive shape guard. Anything that doesn't match `{ v: 1, items: [] }`
 * is treated as null at the call site → UI falls back to default.
 */
export function isValidOverride(input: unknown): input is SidebarLayoutOverride {
  if (!input || typeof input !== 'object') return false;
  const o = input as { v?: unknown; items?: unknown };
  if (o.v !== 1) return false;
  if (!Array.isArray(o.items)) return false;
  return o.items.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) return false;
    if (e.group !== undefined && typeof e.group !== 'string') return false;
    if (e.order !== undefined && typeof e.order !== 'number') return false;
    if (e.hidden !== undefined && typeof e.hidden !== 'boolean') return false;
    return true;
  });
}

/**
 * Spec 137 — legacy sidebar-override id remap. The unified "Ordering"
 * destination replaced the separate `Reorder` and `PurchaseOrders` sidebar
 * items. A saved spec-008 override referencing the removed ids would be
 * silently dropped as stale by the merge (only ids present in defaultGroups get
 * positioned). This alias table actively remaps those ids onto `Ordering` so a
 * user who moved/hid the old items carries that intent onto the new item.
 */
const LEGACY_SIDEBAR_ID_ALIASES: Record<string, string> = {
  Reorder: 'Ordering',
  PurchaseOrders: 'Ordering',
};

/**
 * Spec 137 — pure remap of a saved override's entry ids through
 * LEGACY_SIDEBAR_ID_ALIASES. Dedupes by keeping the FIRST occurrence of a
 * resulting id (deterministic by array order — so `[Reorder, PurchaseOrders]`
 * collapses to a single `Ordering`); everything else passes through untouched.
 * Returns the input unchanged when empty/null. No React/DOM — unit-testable.
 */
export function remapLegacySidebarOverrideIds(
  override: SidebarLayoutOverride | null | undefined,
): SidebarLayoutOverride | null | undefined {
  if (!override || !Array.isArray(override.items) || override.items.length === 0) {
    return override;
  }
  const seen = new Set<string>();
  const items: SidebarLayoutOverrideEntry[] = [];
  for (const entry of override.items) {
    const mappedId = LEGACY_SIDEBAR_ID_ALIASES[entry.id] ?? entry.id;
    if (seen.has(mappedId)) continue; // dedupe — keep the first occurrence
    seen.add(mappedId);
    items.push(mappedId === entry.id ? entry : { ...entry, id: mappedId });
  }
  return { ...override, items };
}

/**
 * Default sortKey for an item at default position [groupIndex, itemIndex].
 * Group-major encoding so cross-group default order is preserved.
 * Spec §7 — `defaultPos` in produceOverride uses the same formula.
 */
function defaultSortKey(groupIndex: number, itemIndex: number): number {
  return groupIndex * 1000 + itemIndex;
}

/**
 * §7 merge algorithm. Returns the rendered group structure.
 *
 * `editMode` flag (extension over architect's §7):
 *   - false (normal render): hidden items are dropped from the output.
 *   - true (edit mode): hidden items are KEPT, with `hiddenByUser: true`
 *     on the TreeItem so the eye-off icon is reachable.
 *
 * Note: `hiddenByUser` is added to the returned items via a shallow copy.
 * Default group order (Operations / Planning / Insights, derived from
 * defaultGroups) is preserved — the override list does NOT carry
 * group-order data per architect §13.
 */
export function applySidebarOverride(
  defaultGroups: SidebarGroup[],
  override: SidebarLayoutOverride | null | undefined,
  options?: { editMode?: boolean },
): SidebarGroup[] {
  const editMode = !!options?.editMode;

  if (!override || !Array.isArray(override.items) || override.items.length === 0) {
    if (!editMode) return defaultGroups;
    // Edit-mode pass through default with `hiddenByUser: false` for every item
    // (so the toggle UI in TreeGroup reads consistently).
    return defaultGroups.map((g) => ({
      label: g.label,
      items: g.items.map((it: TreeItem) => ({ ...it, hiddenByUser: false })),
    }));
  }

  const ovById = new Map<string, SidebarLayoutOverrideEntry>(
    override.items.map((e) => [e.id, e]),
  );

  // 1. Walk every default item, decide its rendered home + sort key.
  const placed: Array<{
    item: TreeItem;
    targetGroup: string;
    sortKey: number;
    hidden: boolean;
  }> = [];

  defaultGroups.forEach((g, gi) => {
    g.items.forEach((it: TreeItem, ii: number) => {
      const ov = ovById.get(it.id);
      const targetGroup = ov?.group ?? g.label;
      const sortKey = ov?.order ?? defaultSortKey(gi, ii);
      const hidden = !!ov?.hidden;
      placed.push({ item: it, targetGroup, sortKey, hidden });
    });
  });

  // 2. Re-bucket by group label, preserving the default group order.
  //    Items moved to a non-existent group label get appended in a new
  //    bucket at the end (defensive — should not happen in practice).
  const groupOrder = defaultGroups.map((g) => g.label);
  const byGroup = new Map<string, typeof placed>();
  groupOrder.forEach((label) => byGroup.set(label, []));
  placed.forEach((p) => {
    if (!byGroup.has(p.targetGroup)) byGroup.set(p.targetGroup, []);
    byGroup.get(p.targetGroup)!.push(p);
  });

  // 3. Sort each group by sortKey, optionally drop hidden, decorate
  //    with hiddenByUser for the edit-mode UI.
  const allLabels = Array.from(byGroup.keys());
  return allLabels.map((label) => {
    const bucket = byGroup.get(label)!.slice().sort((a, b) => a.sortKey - b.sortKey);
    const filtered = editMode ? bucket : bucket.filter((p) => !p.hidden);
    return {
      label,
      items: filtered.map((p) => ({ ...p.item, hiddenByUser: editMode ? p.hidden : false })),
    };
  });
}

/**
 * §7 reverse pass. Given the rendered (post-edit) group structure, diff
 * back to the minimal override list.
 *
 * Inputs:
 *   - rendered: the user's edited group structure. Items may carry a
 *     `hiddenByUser` flag (set by the edit-mode UI when they click the
 *     eye toggle).
 *   - defaultGroups: the hardcoded default (source of truth for "what
 *     would be the default position of this id?").
 *
 * Returns:
 *   - null    iff no item differs from default → no override row needed.
 *   - { v:1, items:[...] } otherwise, with one entry per changed item.
 *
 * "Changed" means: moved to a different group, moved to a different
 * order-within-its-group, or hidden by the user.
 */
export function produceOverride(
  rendered: SidebarGroup[],
  defaultGroups: SidebarGroup[],
): SidebarLayoutOverride | null {
  const defaultPos = new Map<string, { group: string; order: number }>();
  defaultGroups.forEach((g, gi) => {
    g.items.forEach((it: TreeItem, ii: number) => {
      defaultPos.set(it.id, { group: g.label, order: defaultSortKey(gi, ii) });
    });
  });

  const items: SidebarLayoutOverrideEntry[] = [];
  rendered.forEach((g, gi) => {
    g.items.forEach((it: TreeItem, ii: number) => {
      const def = defaultPos.get(it.id);
      // Stale id (not in default) — drop silently. Architect §2 invariant.
      if (!def) return;

      const renderedOrder = defaultSortKey(gi, ii);
      const groupChanged = def.group !== g.label;
      const orderChanged = def.order !== renderedOrder;
      const hidden = !!(it as TreeItem & { hiddenByUser?: boolean }).hiddenByUser;

      if (groupChanged || orderChanged || hidden) {
        const entry: SidebarLayoutOverrideEntry = { id: it.id };
        if (groupChanged) entry.group = g.label;
        if (orderChanged) entry.order = renderedOrder;
        if (hidden) entry.hidden = true;
        items.push(entry);
      }
    });
  });

  return items.length === 0 ? null : { v: 1, items };
}
