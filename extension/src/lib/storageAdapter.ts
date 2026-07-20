// Spec 132 (D-2) — a supabase-js storage adapter backed by chrome.storage.local.
// The session (access + refresh token) persists in the EXTENSION-SANDBOXED
// chrome.storage.local — NOT readable by any web page, including the vendor
// sites. supabase-js handles refresh-token rotation. The only credential this
// touches is the admin's OWN I.M.R password at the login popup (never a vendor
// password — AC-9).

export interface SupportedStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const chromeStorageAdapter: SupportedStorage = {
  async getItem(key: string): Promise<string | null> {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === 'string' ? value : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};
