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
// clicks. We click the "Users & access" sidebar label (stable i18n string)
// to reach the Users section, then assert against the §7 testIDs.
//
// Selector contract (frozen §7): users-root, users-invite-trigger
// (UsersSection); invite-email, invite-name, invite-role-{user|admin},
// invite-submit (InviteUserDrawer).

import { test, expect } from '@playwright/test';
import { SIDEBAR_LABEL, STORAGE_STATE, uniqueInviteEmail } from './fixtures/constants';

// Master storageState — see the WHY MASTER block in the file header.
test.use({ storageState: STORAGE_STATE.master });

test.describe('invite user', () => {
  test('AC-INV1/2: master invites a uniquified user and the drawer confirms', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('cmd-shell-root')).toBeVisible();

    // Switch to the Users section via the sidebar label (no section URL).
    await page.getByText(SIDEBAR_LABEL.users, { exact: true }).first().click();
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
    await page.getByTestId('invite-submit').click();

    // Success signal: the drawer closes on a successful invite
    // (InviteUserDrawer calls onClose() after the success toast), so the
    // email field is removed from the DOM. This is the most robust signal —
    // the success toast auto-dismisses, but the drawer-close is durable.
    await expect(page.getByTestId('invite-email')).toHaveCount(0);
    // And we're back on the Users section.
    await expect(page.getByTestId('users-root')).toBeVisible();
  });
});
