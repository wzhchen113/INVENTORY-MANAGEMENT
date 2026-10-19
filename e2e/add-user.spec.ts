// e2e/add-user.spec.ts — Spec 165 §J: add a username-only store user (no
// email), set its password, and delete it. Sibling of invite.spec.ts.
//
// WHY MASTER: Users & access is master-gated (Spec 030) — see invite.spec.ts.
//
// DATA ISOLATION: the username is uniquified per run (zz_e2e_<last 8 of
// RUN_ID>, within the 3-20 char rule) and the spec deletes the account it
// created through the real DELETE flow, so a local re-run leaves no row.
//
// NOT COVERED HERE — username sign-in. The login path resolves a username via
// the `username-resolve` edge function, which needs the
// USERNAME_RESOLVE_SERVICE_TOKEN server secret + the matching
// EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN bundle token; e2e.yml boots the stack
// with neither, so a username sign-in here would fail closed for an
// environment reason. Sign-in (and old-password-fails / new-password-works
// after SET PASSWORD) is proven by scripts/smoke-store-user.sh against the
// local stack instead.
//
// Selector contract: users-add-trigger, user-row-<id>, user-username-login-<id>,
// user-set-password-<id>, user-reset-pw-<id> (UsersSection); add-user-name,
// add-user-username, add-user-password, add-user-store-<id>, add-user-submit,
// add-user-hint (AddStoreUserDrawer); set-password-input, set-password-submit
// (SetStoreUserPasswordModal).

import { test, expect } from '@playwright/test';
import { RUN_ID, SEED, SIDEBAR_NAV, STORAGE_STATE } from './fixtures/constants';
import { gotoShell } from './fixtures/storeGate';

test.use({ storageState: STORAGE_STATE.master });

test.describe('add store user (username, no email)', () => {
  test('master adds a username-only store user, sets its password, deletes it', async ({ page }) => {
    const username = `zz_e2e_${RUN_ID.slice(-8)}`;

    await gotoShell(page);
    await page.getByTestId(SIDEBAR_NAV.users).click();
    await expect(page.getByTestId('users-root')).toBeVisible();

    // Open the drawer; submit is gated until every field is valid.
    await page.getByTestId('users-add-trigger').click();
    await expect(page.getByTestId('add-user-name')).toBeVisible();
    await expect(page.getByTestId('add-user-submit')).toBeDisabled();

    await page.getByTestId('add-user-name').fill('E2E Store User');
    // Typed uppercase → lowercased as the admin types.
    await page.getByTestId('add-user-username').fill(username.toUpperCase());
    await expect(page.getByTestId('add-user-username')).toHaveValue(username);
    await page.getByTestId('add-user-password').fill('short');
    await expect(page.getByTestId('add-user-submit')).toBeDisabled();
    await page.getByTestId('add-user-password').fill('e2e-password-165');
    await page.getByTestId(`add-user-store-${SEED.towsonStoreId}`).click();
    await expect(page.getByTestId('add-user-hint')).toHaveText('ready to create');
    await page.getByTestId('add-user-submit').click();

    // Drawer closes on success and the new row lands with @username + marker.
    await expect(page.getByTestId('add-user-name')).toHaveCount(0);
    const identity = page.getByText(new RegExp(`^@${username} · `));
    await expect(identity).toBeVisible();
    const row = page.locator('[data-testid^="user-row-"]', { has: identity });
    const rowTestId = await row.getAttribute('data-testid');
    const id = (rowTestId ?? '').replace('user-row-', '');
    expect(id).not.toBe('');
    await expect(page.getByTestId(`user-username-login-${id}`)).toBeVisible();
    // The placeholder address is never rendered.
    await expect(page.getByText(/no-email\.invalid/)).toHaveCount(0);
    // SET PASSWORD replaces the email RESET PW for this account.
    await expect(page.getByTestId(`user-reset-pw-${id}`)).toHaveCount(0);

    // SET PASSWORD.
    await page.getByTestId(`user-set-password-${id}`).click();
    await expect(page.getByTestId('set-password-input')).toBeVisible();
    await page.getByTestId('set-password-input').fill('e2e-password-new');
    await page.getByTestId('set-password-submit').click();
    await expect(page.getByTestId('set-password-input')).toHaveCount(0);

    // Delete through the real flow: the confirm text is the username.
    await row.getByText('DELETE', { exact: true }).click();
    await expect(page.getByText(`type "${username}" to enable`)).toBeVisible();
    await page.getByRole('textbox').last().fill(username);
    await page.getByRole('button', { name: 'DELETE USER' }).click();
    await expect(row).toHaveCount(0);
  });
});
