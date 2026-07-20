// Spec 132 — the popup UI logic. A thin client: it renders auth, the dry-run
// toggle (DEFAULT ON — AC-10), the pending-PO pickup for the current tab (AC-3),
// the Run control, the per-item report (AC-7), and the explicit mark-ordered
// button (AC-8). ALL supabase-js / tab / scripting work happens in the
// background; the popup only sends messages.

import type {
  AuthStatusResponse,
  MarkOrderedResponse,
  PendingResponse,
  Request,
  RunResponse,
} from '../lib/messages';
import { summarizeReport } from '../core/report';
import type { PendingOrder, ReportLine } from '../lib/types';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function send<T>(message: Request): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function show(el: HTMLElement, on: boolean): void {
  el.classList.toggle('hidden', !on);
}

let currentPoId: string | null = null;

// ─── auth ─────────────────────────────────────────────────────────────────

async function refreshAuth(): Promise<void> {
  const status = await send<AuthStatusResponse>({ type: 'AUTH_STATUS' });
  const signedIn = status.signedIn;
  show($('signed-in'), signedIn);
  show($('signed-out'), !signedIn);
  show($('main'), signedIn);
  if (signedIn) {
    $('user-email').textContent = status.email ?? '';
    await refreshPending();
  }
}

async function onSignIn(): Promise<void> {
  const email = ($('email') as HTMLInputElement).value.trim();
  const password = ($('password') as HTMLInputElement).value;
  const errEl = $('auth-error');
  show(errEl, false);
  const status = await send<AuthStatusResponse>({ type: 'SIGN_IN', email, password });
  if (status.error) {
    errEl.textContent = status.error;
    show(errEl, true);
    return;
  }
  ($('password') as HTMLInputElement).value = '';
  await refreshAuth();
}

async function onSignOut(): Promise<void> {
  await send({ type: 'SIGN_OUT' });
  await refreshAuth();
}

// ─── pickup ─────────────────────────────────────────────────────────────────

function poLabel(o: PendingOrder): string {
  const gap = o.unmappedCount > 0 ? ` — ${o.unmappedCount} unmapped` : '';
  return `${o.vendorName}: ${o.lineCount} line(s)${gap} [${o.poId.slice(0, 8)}]`;
}

async function refreshPending(): Promise<void> {
  const statusEl = $('site-status');
  const selectEl = $('po-select') as HTMLSelectElement;
  const runBtn = $('run');
  show(selectEl, false);
  show(runBtn, false);
  show($('report-card'), false);

  const res = await send<PendingResponse>({ type: 'PENDING_FOR_TAB' });
  if (res.error) {
    statusEl.textContent = `Error: ${res.error}`;
    return;
  }
  if (!res.onVendorSite) {
    statusEl.textContent = 'Open a BJ’s or Sam’s Club tab to pick up a pending PO.';
    return;
  }
  if (res.orders.length === 0) {
    statusEl.textContent = `No pending PO for this vendor (${res.origin}).`;
    return;
  }
  statusEl.textContent = `${res.orders.length} pending PO(s) for this vendor:`;
  selectEl.innerHTML = '';
  for (const o of res.orders) {
    const opt = document.createElement('option');
    opt.value = o.poId;
    opt.textContent = poLabel(o);
    selectEl.appendChild(opt);
  }
  currentPoId = res.orders[0].poId;
  show(selectEl, true);
  show(runBtn, true);
}

// ─── run + report ───────────────────────────────────────────────────────────

function renderReport(report: ReportLine[]): void {
  const listEl = $('report-list');
  listEl.innerHTML = '';
  for (const line of report) {
    const wrap = document.createElement('div');
    wrap.className = 'item';
    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = line.itemName || line.orderCode || line.itemId;
    const pill = document.createElement('span');
    pill.className = `pill ${line.status}`;
    pill.textContent = line.status;
    nameRow.appendChild(name);
    nameRow.appendChild(pill);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${line.orderCode ?? 'no code'} · ${line.qty} ${line.unit}`;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = line.detail;
    wrap.appendChild(nameRow);
    wrap.appendChild(meta);
    wrap.appendChild(detail);
    listEl.appendChild(wrap);
  }
  const s = summarizeReport(report);
  $('report-summary').textContent = `${s.added} added · ${s.wouldAdd} would-add · ${s.unmatched} unmatched · ${s.ambiguous} ambiguous · ${s.failed} failed`;
}

async function onRun(): Promise<void> {
  const selectEl = $('po-select') as HTMLSelectElement;
  currentPoId = selectEl.value || currentPoId;
  if (!currentPoId) return;
  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const runBtn = $('run') as HTMLButtonElement;
  const errEl = $('run-error');
  const stopEl = $('run-stop');
  show(errEl, false);
  show(stopEl, false);
  runBtn.disabled = true;
  runBtn.textContent = dryRun ? 'Running dry-run…' : 'Filling cart…';

  try {
    const res = await send<RunResponse>({ type: 'RUN', poId: currentPoId, dryRun });
    if (res.error) {
      errEl.textContent = res.error;
      show(errEl, true);
      return;
    }
    renderReport(res.report);
    show($('report-card'), true);
    if (res.stopped) {
      stopEl.textContent = res.stopped.detail;
      show(stopEl, true);
    }
    // Mark-ordered is offered only after a LIVE run (payment happens between
    // fill and mark — AC-8); dry-run never writes back (AC-10).
    const markBtn = $('mark-ordered');
    show(markBtn, !dryRun && !res.stopped);
    show($('mark-msg'), false);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Fill cart from PO';
  }
}

async function onMarkOrdered(): Promise<void> {
  if (!currentPoId) return;
  const dryRun = ($('dry-run') as HTMLInputElement).checked;
  const msgEl = $('mark-msg');
  const res = await send<MarkOrderedResponse>({ type: 'MARK_ORDERED', poId: currentPoId, dryRun });
  if (res.error) {
    msgEl.textContent = `Error: ${res.error}`;
    msgEl.className = 'msg err';
  } else if (res.suppressedByDryRun) {
    msgEl.textContent = 'Dry-run is on — the PO was NOT marked ordered.';
    msgEl.className = 'msg stop';
  } else if (res.updated > 0) {
    msgEl.textContent = 'PO marked ordered — it will drop out of the pending set.';
    msgEl.className = 'msg';
    show($('mark-ordered'), false);
  } else {
    msgEl.textContent = 'No change (PO was already ordered or not visible).';
    msgEl.className = 'msg';
  }
  show(msgEl, true);
}

// ─── wire up ─────────────────────────────────────────────────────────────────

$('sign-in').addEventListener('click', () => void onSignIn());
$('sign-out').addEventListener('click', () => void onSignOut());
$('run').addEventListener('click', () => void onRun());
$('mark-ordered').addEventListener('click', () => void onMarkOrdered());
($('po-select') as HTMLSelectElement).addEventListener('change', (e) => {
  currentPoId = (e.target as HTMLSelectElement).value;
});

void refreshAuth();
