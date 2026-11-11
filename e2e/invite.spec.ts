// e2e/invite.spec.ts — Spec 078 Phase 3: invite-user flow (AC-INV1/2).
//
// Signed in as MASTER (storageState), navigate to the Users section, open
// the invite drawer, fill it, submit, and assert a success signal.
//
// WHY MASTER, NOT ADMIN: the entire Users & access section is master-gated
// (Spec 030 — the sidebar entry renders only for master/super-admin). A
// plain admin never sees the "Users & access" nav item, so an admin-path
// spec would time out at the sidebar click. master@local.test is the role
// that sees both the Users section AND the invite-role chips (the
// InviteUserDrawer Role block is gated on `isMaster`). So this spec asserts
// the invite-role-user chip is visible (admin-path would not render it),
// then leaves the default 'user' role; required fields for that invite are
// email + name (requiredValid in InviteUserDrawer).
//
// DATA ISOLATION (AC-INV2 / OQ-3b): the invited email is uniquified per
// run — e2e-invite+<runId>@local.test — so a developer's local re-run does
// not collide on a prior run's invited email (and CI is safe even if the
// db reset is ever skipped). The assertion keys off the success signal for
// THIS run's email, never an absolute row count.
//
// Navigation: the Cmd shell has no URL/linking; sections switch via sidebar
// clicks. We click the Users nav item via its stable testID (spec 079
// flake-kill — no i18n-fragile label text) to reach the Users section, then
// assert against the §7 testIDs.
//
// DURABLE EFFECT (spec 079 AC-INV-DEPTH-1): spec 078 asserted only that the
// drawer closes. Spec 079 deepens this to assert the invited user landed —
// the run-unique email TEXT renders as a row in the Users list. That is the
// ONE place a getByText is correct: it asserts content the test itself
// created (the unique email), not navigation chrome, so it is not
// i18n-fragile and needs no new testID. Keyed off THIS run's email
// (uniqueInviteEmail), never an absolute row count (AC-INV2 isolation).
//
// SPEC 198 UPDATE (F1). A successful invite no longer closes the drawer: it
// shows the one-time invite link (the claim needs its code, and the database
// keeps only the code's hash). So this spec now:
//   1. waits on the REAL send-invite-email response around the submit and
//      asserts 200 — proving the deployed function accepts the new
//      `inviteCode` payload (locally there's no RESEND_API_KEY, so it takes the
//      inviteUserByEmail fallback and answers { success, method:
//      'supabase-auth' });
//   2. asserts `invite-link` matches /?register=true&invite=<32 hex>$/;
//   3. clicks `invite-done` and asserts the drawer closed and users-root shows;
//   4. REPLACES the old getByText(email) assertion (which actually matched the
//      success toast, not a Users row — invitees have no profile until they
//      register) with a service-role read: exactly one pending invitation for
//      the email, with a code_hash and invited_by = the master's id.
// The claim itself (fresh context registers through the link) is
// e2e/invite-claim.spec.ts.
//
// Selector contract: users-root, users-invite-trigger (UsersSection);
// invite-email, invite-name, invite-role-{user|admin}, invite-submit
// (InviteUserDrawer) — all 078 §7; nav-Users (079 §6 SIDEBAR_NAV);
// invite-link, invite-done (InviteLinkPanel, spec 198 §6).

import { test, expect } from '@playwright/test';
import { SIDEBAR_NAV, STORAGE_STATE, uniqueInviteEmail } from './fixtures/constants';
import { gotoShell } from './fixtures/storeGate';
import { serviceRoleClient } from './fixtures/db';

// master@local.test's user id (supabase/seed.sql `master_id`) — the stamped
// `invited_by` on invitations this spec creates (spec 198 AD-3).
const MASTER_USER_ID = '33333333-3333-3333-3333-333333333333';

// Master storageState — see the WHY MASTER block in the file header.
test.use({ storageState: STORAGE_STATE.master });

test.describe('invite user', () => {
  test('AC-INV1/2: master invites a uniquified user and the drawer confirms', async ({
    page,
  }) => {
    // Spec 161 — clears the admin store gate, then asserts the shell.
    await gotoShell(page);

    // Switch to the Users section via the stable nav testID (no section URL,
    // no i18n-fragile label text). nav-Users only renders for master/super-
    // admin (the section is master-gated, Spec 030) — which is why this spec
    // runs under the master storageState.
    await page.getByTestId(SIDEBAR_NAV.users).click();
    await expect(page.getByTestId('users-root')).toBeVisible();

    // Open the invite drawer.
    await page.getByTestId('users-invite-trigger').click();
    await expect(page.getByTestId('invite-email')).toBeVisible();

    // Master sees the role chips (a plain admin would not) — confirm the
    // Role block renders, then leave the default 'user' role selected.
    await expect(page.getByTestId('invite-role-user')).toBeVisible();

    // Fill the required fields (email + name) with a run-unique email.
    const email = uniqueInviteEmail();
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-name').fill('E2E Invitee');

    // Submit becomes enabled once email + name are present.
    await expect(page.getByTestId('invite-submit')).toBeEnabled();

    // Spec 198 F1 step 1 — the email send is fire-and-forget from the client,
    // so wait on its response explicitly (armed BEFORE the click).
    const emailResponse = page.waitForResponse('**/functions/v1/send-invite-email');
    await page.getByTestId('invite-submit').click();
    expect((await emailResponse).status()).toBe(200);

    // Step 2 — the one-time link replaces the form; the drawer stays open.
    const link = page.getByTestId('invite-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/\?register=true&invite=[0-9a-f]{32}$/);
    await expect(page.getByTestId('invite-email')).toHaveCount(0);

    // Step 3 — DONE closes the drawer and we're back on the Users section.
    await page.getByTestId('invite-done').click();
    await expect(page.getByTestId('invite-link')).toHaveCount(0);
    await expect(page.getByTestId('users-root')).toBeVisible();

    // Step 4 (durable effect, replaces AC-INV-DEPTH-1's getByText) — the
    // invitation landed server-side: one pending row for THIS run's email,
    // hashed code present, provenance stamped to the master. Keyed off the
    // run-unique email (AC-INV2 isolation preserved), never an absolute count.
    const { data: rows, error } = await serviceRoleClient()
      .from('invitations')
      .select('used, code_hash, invited_by')
      .eq('email', email.toLowerCase());
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0].used).toBe(false);
    expect(rows![0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows![0].invited_by).toBe(MASTER_USER_ID);
  });
});
