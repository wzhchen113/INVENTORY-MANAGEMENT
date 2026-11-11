// e2e/invite-claim.spec.ts — Spec 198 F2: an invitation is claimed through its
// one-time link, and only through it.
//
// This is the only track that exercises REAL GoTrue sign-up against the
// code-gated claim (jest mocks supabase; pgTAP simulates callers).
//
// FLOW
//   master (storageState) invites a run-unique email as staff with ONE store
//   (Towson), reads the link from `invite-link`, then a FRESH browser context
//   (no storageState — a different person's browser) opens that link:
//   LoginScreen sees ?register=true&invite=<code>, hands the code to Register
//   as a route param (AD-6) and strips the URL; `register-code` is prefilled;
//   the invitee registers, sees `register-success`, signs in, and lands on the
//   staff surface for the invited store (one store → straight to EODCount).
//
// NEGATIVE ARM
//   A second run-unique invitation; the link's last hex char is flipped (still
//   valid FORMAT, wrong code). Registering with the right email shows the
//   no-pending-invitation error, and a service-role check finds NO auth user
//   (the code-gated pre-check runs before signUp, so a wrong code leaves no
//   orphan account) and therefore no profile.
//
// LOCAL inviteUserByEmail FALLBACK (spec Risks / design §8.4)
//   Locally and in CI there is no RESEND_API_KEY, so the real send-invite-email
//   falls back to auth.admin.inviteUserByEmail, which CREATES an auth.users row
//   for the invitee — the later signUp for that email would then fail for a
//   reason unrelated to this spec. This spec therefore STUBS send-invite-email
//   in the master context (page.route → 200) and captures the request body to
//   prove the client sent `inviteCode` equal to the link's code. A guard then
//   asserts no auth user exists for the email yet, so the test fails fast with
//   a clear message if the stub ever stops working. e2e/invite.spec.ts still
//   exercises the real function.
//
// V-5 (design §8.4): signUp leaves the client holding a session (autoconfirm),
// but RoleRouter keys off the admin/staff STORES (set only by LoginScreen's
// sign-in path), not the raw supabase session, so RegisterScreen's success
// state is expected to stay up. If that ever changes, assert the staff surface
// directly instead and record it in the review.
//
// Selector contract: invite-* (InviteUserDrawer), invite-link / invite-done
// (InviteLinkPanel); register-email / -code / -password / -confirm / -submit /
// -error / -success / -go-signin (RegisterScreen); signin-* (LoginScreen,
// auth.spec.ts); eod-store-name / store-picker-root (staff landing, eod.spec.ts).

import { test, expect, type Browser, type Page } from '@playwright/test';
import { RUN_ID, SEED, SIDEBAR_NAV, STORAGE_STATE } from './fixtures/constants';
import { gotoShell } from './fixtures/storeGate';
import { serviceRoleClient } from './fixtures/db';

test.use({ storageState: STORAGE_STATE.master });

const PASSWORD = 'e2e-claim-pass-198';
// Mirrors NO_PENDING_INVITATION_ERROR in src/lib/auth.ts (e2e can't import the
// app graph — it's a react-native bundle).
const NO_PENDING_INVITATION_ERROR =
  'No pending invitation matches this email and invite code. Check the link, or ask your admin to invite you again.';
const STORE_NAME = 'Towson';

// Retry safety (review S2): RUN_ID is GITHUB_RUN_ID, which is the same on
// every Playwright retry (`retries: 2` in CI). A late flake in attempt 1 (after
// signUp) would leave that attempt's auth user and used invitation behind, so a
// retry reusing the email would trip the "stub did not take effect" guard or
// see two invitation rows. Each attempt therefore gets its own email.
const createdEmails: string[] = [];
function attemptEmail(prefix: string): string {
  const email = `${prefix}+${RUN_ID}-r${test.info().retry}@local.test`;
  createdEmails.push(email);
  return email;
}

/** Auth user id for an email, or null. Service role; local stack only. */
async function authUserIdFor(email: string): Promise<string | null> {
  const { data, error } = await serviceRoleClient().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`[e2e invite-claim] listUsers failed: ${error.message}`);
  const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
  return hit ? hit.id : null;
}

/**
 * As master: open the invite drawer, invite `email` as staff with Towson, and
 * return the link shown in `invite-link`. send-invite-email is stubbed (see
 * header) and its request body is checked for the matching `inviteCode`.
 */
async function inviteAndReadLink(page: Page, email: string, name: string): Promise<string> {
  let emailBody: Record<string, unknown> | null = null;
  await page.route('**/functions/v1/send-invite-email', async (route) => {
    emailBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"success":true,"method":"e2e-stub"}',
    });
  });

  await gotoShell(page);
  await page.getByTestId(SIDEBAR_NAV.users).click();
  await expect(page.getByTestId('users-root')).toBeVisible();
  await page.getByTestId('users-invite-trigger').click();
  await expect(page.getByTestId('invite-email')).toBeVisible();

  await page.getByTestId('invite-email').fill(email);
  await page.getByTestId('invite-name').fill(name);
  await page.getByTestId(`invite-store-${SEED.towsonStoreId}`).click();

  const emailRequest = page.waitForRequest('**/functions/v1/send-invite-email');
  await page.getByTestId('invite-submit').click();

  const linkEl = page.getByTestId('invite-link');
  await expect(linkEl).toHaveText(/\?register=true&invite=[0-9a-f]{32}$/);
  const link = (await linkEl.textContent())!.trim();
  const code = link.slice(-32);

  await emailRequest;
  expect(emailBody, 'send-invite-email was not called').not.toBeNull();
  expect(emailBody!.inviteCode).toBe(code);

  await page.getByTestId('invite-done').click();
  await expect(page.getByTestId('invite-link')).toHaveCount(0);
  return link;
}

/** A signed-out browser context (another person's browser). */
async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return ctx.newPage();
}

/** Open the invite link and fill the register form (code comes from the link). */
async function registerThroughLink(page: Page, link: string, email: string, expectedCode: string) {
  await page.goto(link);
  // AD-6: the code arrived as a route param, not from the (now stripped) URL.
  await expect(page.getByTestId('register-code')).toHaveValue(expectedCode);
  await page.getByTestId('register-email').fill(email);
  await page.getByTestId('register-password').fill(PASSWORD);
  await page.getByTestId('register-confirm').fill(PASSWORD);
  await page.getByTestId('register-submit').click();
}

test.describe('invite claim (spec 198 F2)', () => {
  test.afterAll(async () => {
    // Best-effort; CI resets the DB anyway. Local runs would otherwise leave
    // the run-unique invitees behind.
    for (const email of createdEmails) {
      try {
        const id = await authUserIdFor(email);
        if (id) await serviceRoleClient().auth.admin.deleteUser(id);
      } catch {
        /* best effort */
      }
    }
  });

  test('F2: the invitee registers through the link and lands on their store', async ({ page, browser }) => {
    const claimEmail = attemptEmail('e2e-claim');
    const link = await inviteAndReadLink(page, claimEmail, 'E2E Claimant');
    const code = link.slice(-32);

    // Guard: the stub kept the local inviteUserByEmail fallback from
    // pre-creating the invitee's auth user (which would break signUp).
    expect(
      await authUserIdFor(claimEmail),
      'an auth user already exists for the invitee — the send-invite-email stub did not take effect',
    ).toBeNull();

    const invitee = await freshPage(browser);
    try {
      await registerThroughLink(invitee, link, claimEmail, code);

      await expect(invitee.getByTestId('register-success')).toBeVisible();
      await invitee.getByTestId('register-go-signin').click();

      await invitee.getByTestId('signin-email').fill(claimEmail);
      await invitee.getByTestId('signin-password').fill(PASSWORD);
      await invitee.getByTestId('signin-submit').click();

      // One granted store → the staff app skips the picker and opens EODCount
      // for it. Tolerate the picker too (spec 078 landing pattern).
      const picker = invitee.getByTestId('store-picker-root');
      const eodHeader = invitee.getByTestId('eod-store-name');
      await expect(picker.or(eodHeader).first()).toBeVisible();
      if (await picker.isVisible()) {
        await invitee.getByTestId(`store-row-${SEED.towsonStoreId}`).click();
      }
      await expect(eodHeader).toContainText(STORE_NAME);
    } finally {
      await invitee.context().close();
    }

    // Durable effect: the invitation is used and points at the new profile.
    const userId = await authUserIdFor(claimEmail);
    expect(userId).not.toBeNull();
    const { data: inv } = await serviceRoleClient()
      .from('invitations')
      .select('used, profile_id')
      .eq('email', claimEmail.toLowerCase());
    expect(inv).toHaveLength(1);
    expect(inv![0].used).toBe(true);
    expect(inv![0].profile_id).toBe(userId);
  });

  test('F2 negative: the right email with a wrong code is refused and creates no account', async ({
    page,
    browser,
  }) => {
    const wrongCodeEmail = attemptEmail('e2e-claim-neg');
    const link = await inviteAndReadLink(page, wrongCodeEmail, 'E2E Wrong Code');
    // Flip the last hex char: still valid format, wrong code.
    const last = link.slice(-1);
    const wrongLink = link.slice(0, -1) + (last === '0' ? '1' : '0');
    const wrongCode = wrongLink.slice(-32);

    const invitee = await freshPage(browser);
    try {
      await registerThroughLink(invitee, wrongLink, wrongCodeEmail, wrongCode);
      await expect(invitee.getByTestId('register-error')).toHaveText(NO_PENDING_INVITATION_ERROR);
      await expect(invitee.getByTestId('register-success')).toHaveCount(0);
    } finally {
      await invitee.context().close();
    }

    // The pre-check refused before signUp: no auth user → no profile.
    expect(await authUserIdFor(wrongCodeEmail)).toBeNull();
    const { data: profiles } = await serviceRoleClient()
      .from('profiles')
      .select('id')
      .eq('name', 'E2E Wrong Code');
    expect(profiles ?? []).toHaveLength(0);

    // And the real invitation is untouched.
    const { data: inv } = await serviceRoleClient()
      .from('invitations')
      .select('used')
      .eq('email', wrongCodeEmail.toLowerCase());
    expect(inv).toHaveLength(1);
    expect(inv![0].used).toBe(false);
  });
});
