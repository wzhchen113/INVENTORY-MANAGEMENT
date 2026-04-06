// src/lib/api.ts
// Local json-server API client for dev/testing
// Start server: npx json-server db.json --port 3001

const BASE_URL = 'http://localhost:3001';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Inventory ──────────────────────────────────────────────

export async function fetchInventory(storeId?: string) {
  const query = storeId ? `?storeId=${storeId}` : '';
  return request<any[]>(`/inventory${query}`);
}

export async function addInventoryItem(item: Record<string, any>) {
  return request<any>('/inventory', {
    method: 'POST',
    body: JSON.stringify(item),
  });
}

export async function updateInventoryItem(id: string | number, updates: Record<string, any>) {
  return request<any>(`/inventory/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteInventoryItem(id: string | number) {
  return request<void>(`/inventory/${id}`, { method: 'DELETE' });
}

// ── Menus ──────────────────────────────────────────────────

export async function fetchMenus() {
  return request<any[]>('/menus');
}

export async function addMenu(menu: Record<string, any>) {
  return request<any>('/menus', {
    method: 'POST',
    body: JSON.stringify(menu),
  });
}

export async function updateMenu(id: string | number, updates: Record<string, any>) {
  return request<any>(`/menus/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteMenu(id: string | number) {
  return request<void>(`/menus/${id}`, { method: 'DELETE' });
}

// ── EOD Submissions ────────────────────────────────────────

export async function fetchEODSubmissions(storeId?: string) {
  const query = storeId ? `?storeId=${storeId}` : '';
  return request<any[]>(`/eodSubmissions${query}`);
}

export async function addEODSubmission(submission: Record<string, any>) {
  return request<any>('/eodSubmissions', {
    method: 'POST',
    body: JSON.stringify(submission),
  });
}

export async function updateEODSubmission(id: string | number, updates: Record<string, any>) {
  return request<any>(`/eodSubmissions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// ── Waste Log ──────────────────────────────────────────────

export async function fetchWasteLog(storeId?: string) {
  const query = storeId ? `?storeId=${storeId}` : '';
  return request<any[]>(`/wasteLog${query}`);
}

export async function addWasteEntry(entry: Record<string, any>) {
  return request<any>('/wasteLog', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

// ── Audit Log ──────────────────────────────────────────────

export async function fetchAuditLog(storeId?: string) {
  const query = storeId ? `?storeId=${storeId}` : '';
  return request<any[]>(`/auditLog${query}`);
}

export async function addAuditEntry(entry: Record<string, any>) {
  return request<any>('/auditLog', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

// ── Health check ───────────────────────────────────────────

export async function isServerRunning(): Promise<boolean> {
  try {
    await fetch(BASE_URL, { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}
