// Spec 016 — single source of truth for the Reports template list.
// Both NewReportModal (template picker) and ReportsSection (catalog grid)
// derive their lists from here so a new template only needs adding once.
//
// `status` flags whether a template has a real RPC wired up:
//   - 'preview' (default in REPORTS-1) → catalog tile shows a PREVIEW badge,
//     dispatcher returns the not_implemented envelope, detail frame shows
//     "Runner coming soon" with RUN disabled.
//   - 'live' → catalog tile drops the badge, dispatcher routes to the real
//     `report_run_<id>` RPC.
//
// REPORTS-2 flipped `cogs` to 'live' (see `20260511120000_report_run_cogs.sql`).
// REPORTS-3 flipped `variance` to 'live' (see `20260512120000_report_run_variance.sql`).

import { ReportDefinition } from '../../../../types';

export interface Template {
  id: ReportDefinition['templateId'];
  name: string;
  sub: string;
  cols: string;
  icon: string;
  status: 'live' | 'preview';
}

export const TEMPLATES: Template[] = [
  { id: 'variance', name: 'Variance',           sub: 'expected vs counted',         cols: 'item · expected · counted · Δ · $ impact', icon: 'Δ', status: 'live'    },
  { id: 'waste',    name: 'Waste cost',         sub: 'by reason & category',        cols: 'date · item · qty · reason · $cost',       icon: '⌫', status: 'preview' },
  { id: 'cogs',     name: 'COGS by category',   sub: 'over time',                   cols: 'date · category · revenue · cogs · margin', icon: '%', status: 'live'    },
  { id: 'vendor',   name: 'Vendor performance', sub: 'on-time, fill-rate',          cols: 'vendor · orders · fill % · late · $',      icon: '⊡', status: 'preview' },
  { id: 'velocity', name: 'Item velocity',      sub: 'turn rate per ingredient',    cols: 'item · usage/wk · turns · DOH',            icon: '≋', status: 'preview' },
  { id: 'custom',   name: 'Custom SQL',         sub: 'write your own',              cols: '-- SELECT … FROM inventory',               icon: '>', status: 'preview' },
];

export function findTemplate(id: ReportDefinition['templateId']): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Default report name for a template at create-time. Pattern matches the
 * existing modal default ("Variance — May 2026") so seeded names read the
 * same regardless of which surface initiated the create.
 */
export function defaultReportName(template: Template, now: Date = new Date()): string {
  const month = MONTHS[now.getMonth()] ?? '';
  const year = now.getFullYear();
  return `${template.name} — ${month} ${year}`;
}
