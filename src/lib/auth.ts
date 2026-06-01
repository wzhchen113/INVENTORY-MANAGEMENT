// src/lib/auth.ts
import { supabase } from './supabase';
import { User, SidebarLayoutOverride } from '../types';
import { isValidOverride } from './sidebarLayout';
import { fetchStoreIdsForBrand, fetchInvitationsForUserLookup } from './db';
import { resolveRecoveryRedirectUrl } from './recoveryRedirect';

export interface AuthResult {
  user: User | null;
  error: string | null;
  /** Saved theme preference from profiles.dark_mode. Undefined = unknown
   *  (e.g. signed out). Callers should apply this to the store after login. */
  darkMode?: boolean;
  /** Spec 008: per-user Cmd UI sidebar override list from
   *  profiles.sidebar_layout. `null` means uncustomized (use the hardcoded
   *  default). `undefined` means unknown (e.g. signed out). Callers should
   *  apply this to the store after login. Defensively coerced to null when
   *  the stored shape is invalid (wrong `v`, missing items array, etc). */
  sidebarLayout?: SidebarLayoutOverride | null;
  /** Spec 038: saved chrome-language preference from profiles.locale.
   *  Defaults to 'en' if the column is missing or holds an unexpected
   *  value (defense-in-depth via `coerceLocale`). Undefined = unknown
   *  (e.g. signed out). Callers should apply this to the store after
   *  login via `hydrateLocale`. */
  locale?: 'en' | 'es' | 'zh-CN';
  /** Spec 044: brand-prefix fast-path. Populated via PostgREST embed
   *  against profiles.brand_id → brands(id, name). `null` when the user
   *  has no brand (super_admin), when the brand is soft-deleted, or when
   *  RLS denies the embedded read. Callers should pass this to the store
   *  via `hydrateBrand(result.brand ?? null)` BEFORE `login()` so the
   *  TitleBar prefix renders the correct brand initials on first paint. */
  brand?: { id: string; name: string } | null;
}

/** Defensive shape guard for profiles.sidebar_layout. We treat any
 *  non-conforming JSON as "uncustomized" rather than crashing the
 *  sidebar render. Mirrors the invariant in spec 008 §2 — readers that
 *  don't recognize `v` fall back to the default.
 *
 *  Delegates to `isValidOverride` from sidebarLayout.ts (the single
 *  source of truth for shape validation — also validates per-item
 *  field types, which the prior local guard did not).
 */
function coerceSidebarLayout(raw: unknown): SidebarLayoutOverride | null {
  return isValidOverride(raw) ? raw : null;
}

/** Spec 038: defense-in-depth guard for profiles.locale. Returns 'en'
 *  for any value that is not one of the three in-scope locales. Same
 *  shape as `coerceSidebarLayout`: if a future migration introduces a
 *  fourth locale and an older client reads back a value it doesn't
 *  recognize, the client falls back to 'en' instead of breaking.
 *  Mirrors the runtime behaviour of the CHECK constraint
 *  `profiles_locale_check` (spec 038 §2).
 */
export function coerceLocale(value: unknown): 'en' | 'es' | 'zh-CN' {
  return value === 'es' || value === 'zh-CN' ? value : 'en';
}

/** Sign in with email + password */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { user: null, error: error.message };
  }

  if (!data.user) {
    return { user: null, error: 'No user returned' };
  }

  return await fetchProfile(data.user.id);
}

/** Sign out */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Get current session (call on app start) */
export async function getSession(): Promise<AuthResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return { user: null, error: null };
  return await fetchProfile(session.user.id);
}

/** Fetch user profile + store access from DB */
async function fetchProfile(userId: string): Promise<AuthResult> {
  // Spec 044 — embed brands(id, name) via the profiles.brand_id FK so the
  // store can seed the `brand` slice synchronously after getSession() returns,
  // letting the TitleBar render the correct `<INITIALS>://` prefix on first
  // paint instead of flashing `inv://`. PostgREST silently returns null for
  // the embedded relation when RLS denies the read (super_admin, soft-deleted
  // brand) — desired behavior per the spec 044 design.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*, brands(id, name)')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    return { user: null, error: profileError?.message || 'Profile not found' };
  }

  const { data: storeLinks } = await supabase
    .from('user_stores')
    .select('store_id')
    .eq('user_id', userId);

  const stores = (storeLinks || []).map((s: any) => s.store_id);

  const user: User = {
    id: userId,
    name: profile.role === 'master' ? 'MASTER' : profile.name,
    nickname: profile.nickname || '',
    email: profile.email || '',
    role: profile.role,
    stores,
    status: profile.status,
    initials: profile.role === 'master' ? 'M' : (profile.initials || profile.name.slice(0, 2).toUpperCase()),
    color: profile.color || '#378ADD',
    // Default to true for legacy rows where the column hasn't been backfilled.
    notificationsEnabled: profile.notifications_enabled !== false,
    // Spec 012b — populate brandId from profiles.brand_id. NULL for
    // super-admin (sees all brands), set for admin/master per
    // profiles_role_brand_consistent CHECK from 012a.
    brandId: profile.brand_id ?? null,
  };

  // Spec 044 — normalize the embedded `brands` relation. PostgREST returns
  // either an object (FK pointing at a single row), null (no FK / RLS-denied
  // embed / soft-deleted), or in rare cases an array. Defensively coerce to
  // `{ id, name } | null` and never throw — the brand slice consumers tolerate
  // null (TitleBar falls back to the legacy `inv://` prefix).
  // supabase-js doesn't type PostgREST embeds on freeform selects; cast required.
  const embedded = (profile as any).brands;
  // PostgREST returns `null` for RLS-denied embeds and `[]` for a many-to-one
  // FK with no match. `embedded[0]` is `undefined` for the empty-array case
  // and falls through to the `brandRaw && ...` falsy check → `null`.
  const brandRaw = Array.isArray(embedded) ? embedded[0] : embedded;
  const brand: { id: string; name: string } | null =
    brandRaw && typeof brandRaw.id === 'string' && typeof brandRaw.name === 'string'
      ? { id: brandRaw.id, name: brandRaw.name }
      : null;

  return {
    user,
    error: null,
    darkMode: !!profile.dark_mode,
    // Spec 008: per-user sidebar override; null when uncustomized or when
    // the stored shape is invalid (defensive coercion).
    sidebarLayout: coerceSidebarLayout(profile.sidebar_layout),
    // Spec 038: per-user chrome-language preference; defaults to 'en'
    // if the column is missing or holds an unexpected value.
    locale: coerceLocale(profile.locale),
    // Spec 044: brand-prefix fast-path. See AuthResult.brand doc for null cases.
    brand,
  };
}

/**
 * Call a Supabase Edge Function with the caller's session bearer.
 *
 * Always resolves; never throws. Errors are surfaced via the `error`
 * field of the returned envelope:
 *   - HTTP 2xx → { data: <parsed JSON body or null>, error: null }
 *   - HTTP non-2xx with { error: "..." } body → { data: null, error: "..." }
 *   - HTTP non-2xx with { message: "..." } body → { data: null, error: "..." }
 *   - HTTP non-2xx with non-JSON body → { data: null, error: "HTTP <status>" }
 *   - fetch rejection → { data: null, error: <e.message or "Network error"> }
 *   - missing session → { data: null, error: "Not authenticated" }
 *
 * Some callers (inviteUser / registerInvitedUser) intentionally
 * fire-and-forget this helper without awaiting — the email send is
 * best-effort and not a load-bearing artifact. That pattern is
 * preserved and the envelope is simply discarded by those callers.
 */
// Spec 040 P3 — exported so src/lib/db.ts can thread translateOnSave's
// edge-function call through the same envelope semantics that auth.ts has
// used since spec 032 (CLAUDE.md "Edge function calls go through
// callEdgeFunction"). Was file-private; auth.ts's pre-spec-040 callers
// (inviteUser, registerInvitedUser, deleteUser) keep their imports working
// because they live in the same module and don't go through the export
// boundary.
//
// Spec 040 review pass — accepts an optional `AbortSignal` so callers like
// the form drawers can cancel a stale in-flight DeepL request when the
// user types again (otherwise the AbortController only suppresses the
// stale RESULT, burning DeepL quota on every rapid retype).
export async function callEdgeFunction(
  fnName: string,
  body: Record<string, any>,
  options?: { signal?: AbortSignal },
): Promise<{ data: any; error: string | null }> {
  // (a) Missing session — short-circuit, do NOT call fetch.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { data: null, error: 'Not authenticated' };

  // (b) Network attempt. Catch only the fetch rejection; do NOT
  //     swallow inside the response-parsing branches.
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  let response: Response;
  try {
    response = await fetch(`${url}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  } catch (e: any) {
    // AbortError surfaces here when the caller fires signal.abort() mid-fetch.
    return { data: null, error: e?.message || 'Network error' };
  }

  // (c) Body parse. Wrap in try/catch — non-JSON body must not throw
  //     synchronously up to the caller.
  let parsed: any = null;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null; // text body, empty body, or malformed JSON
  }

  // (d) Status routing.
  if (response.ok) {
    return { data: parsed, error: null };
  }

  // (e) Non-2xx — pull the error string, falling back through the
  //     three tiers documented in the JSDoc.
  let error: string;
  if (parsed && typeof parsed.error === 'string') {
    error = parsed.error;
  } else if (parsed && typeof parsed.message === 'string') {
    error = parsed.message;
  } else {
    error = `HTTP ${response.status}`;
  }
  return { data: null, error };
}

/**
 * Spec 012b §4 — options-object signature so future inviter forms can
 * extend without breaking call sites. `brandId` is required for
 * role='admin' invitations per the profiles_role_brand_consistent CHECK
 * from 012a (the §1 migration in this spec adds the brand_id column to
 * the invitations table; registerInvitedUser writes it to profiles).
 */
export interface InviteUserOptions {
  email: string;
  name: string;
  role: 'admin' | 'user';
  /** Required for role='admin' (CHECK enforces). Allowed null for
   *  role='user' (staff app users have no brand scope today). */
  brandId: string | null;
  storeIds: string[];
  /** Pre-formatted store-name list for the send-invite-email template.
   *  Optional — when omitted the email template falls back to a generic
   *  "your assigned stores" string. */
  storeNames?: string;
}

/** Invite a new user (admin only — creates invitation record in Supabase) */
export async function inviteUser(opts: InviteUserOptions): Promise<{ error: string | null }> {
  try {
    // Spec 012b — pre-flight gate: admin invites without a brand assignment
    // would fail the profiles_role_brand_consistent CHECK at registration
    // time. Catch it here so the operator sees a clear error instead of a
    // delayed Postgres failure.
    if (opts.role === 'admin' && !opts.brandId) {
      return { error: 'Admin invitations require a brand assignment' };
    }

    // Clean up expired invitations first
    await supabase.from('invitations').delete().lt('expires_at', new Date().toISOString()).eq('used', false);

    // Check if invitation already exists for this email
    const { data: existing } = await supabase
      .from('invitations')
      .select('id')
      .eq('email', opts.email.toLowerCase())
      .eq('used', false)
      .single();

    if (existing) {
      return { error: 'An invitation for this email already exists' };
    }

    // Create invitation record — profile + auth user created at registration time
    const { error: inviteError } = await supabase.from('invitations').insert({
      email: opts.email.toLowerCase(),
      profile_id: '00000000-0000-0000-0000-000000000000',
      name: opts.name,
      role: opts.role,
      store_ids: opts.storeIds,
      // Spec 012b — load-bearing: registerInvitedUser will read this back
      // through get_pending_invitation and write profiles.brand_id from it.
      brand_id: opts.brandId,
    });

    if (inviteError) return { error: inviteError.message };

    // Send invitation email (non-blocking). Payload unchanged — brand
    // name not surfaced in the template (out of scope per spec).
    callEdgeFunction('send-invite-email', {
      email: opts.email,
      name: opts.name,
      role: opts.role,
      storeNames: opts.storeNames || '',
    });

    return { error: null };
  } catch (e: any) {
    return { error: e.message || 'Failed to invite user' };
  }
}

/** Register an invited user (creates Supabase auth account + profile) */
export async function registerInvitedUser(
  email: string,
  password: string,
  name: string
): Promise<AuthResult> {
  try {
    // Fetch the pending invitation via SECURITY DEFINER RPC —
    // anon cannot select from the invitations table directly.
    const { data: rpcRows, error: invError } = await supabase
      .rpc('get_pending_invitation', { p_email: email.toLowerCase() });

    const invitation = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (invError || !invitation) {
      return { user: null, error: 'No invitation found for this email. Please ask an admin to invite you.' };
    }

    // Spec 012b §4 — defensive validation BEFORE auth.signUp creates an
    // orphaned auth user. Catches the migration-window case where a
    // legacy invitation row has brand_id IS NULL but role='admin' — the
    // profile INSERT below would fail the profiles_role_brand_consistent
    // CHECK and leave a dangling auth.users row. Surface a clear error
    // so the operator can re-issue the invite via the new flow.
    if (invitation.role === 'admin' && !invitation.brand_id) {
      return {
        user: null,
        error: 'Invitation is missing a brand assignment. Please ask your admin to re-issue the invite.',
      };
    }

    // Create the Supabase auth user
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: invitation.name, role: invitation.role } },
    });

    if (signUpError) return { user: null, error: signUpError.message };
    if (!authData.user) return { user: null, error: 'Registration failed' };

    // Create profile with real auth user ID. Spec 012b — brand_id is
    // load-bearing: the profiles_role_brand_consistent CHECK from 012a
    // requires admin profiles to have a brand_id, and 'user' / NULL roles
    // accept either.
    //
    // Spec 069 — for role='user' (staff) invites the invitation row's
    // brand_id is NULL (InviteUserDrawer sends brandId: null for staff), which
    // left staff NULL-brand and unable to read brand-scoped catalog data in the
    // EOD app (the catalog_ingredients / vendors embeds returned null). We now
    // stamp brand_id from resolved_brand_id — the brand the invitation's store
    // assignments resolve to, computed server-side by get_pending_invitation
    // (SECURITY DEFINER, so it bypasses RLS; a client-side stores read here
    // would be RLS-blocked because the user_stores rows below are inserted
    // AFTER this profile INSERT). Admin invites are UNCHANGED: they already
    // carry a non-NULL invitation.brand_id (and resolved_brand_id COALESCEs to
    // it), so the role!=='user' branch passes brand_id straight through.
    const { error: profileError } = await supabase.from('profiles').insert({
      id: authData.user.id,
      name: invitation.name,
      role: invitation.role,
      initials: invitation.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      color: '#378ADD',
      status: 'active',
      brand_id: invitation.role === 'user'
        ? (invitation.resolved_brand_id ?? invitation.brand_id ?? null)
        : (invitation.brand_id ?? null),
    });

    if (profileError) {
      return { user: null, error: `Account created but profile setup failed: ${profileError.message}` };
    }

    // Create store links from invitation
    const storeIds = invitation.store_ids || [];
    for (const storeId of storeIds) {
      await supabase.from('user_stores').insert({ user_id: authData.user.id, store_id: storeId });
    }

    // Mark invitation as used via SECURITY DEFINER RPC — requires a fresh
    // authenticated session (auth.uid() must be present).
    await supabase.rpc('consume_invitation', {
      p_invitation_id: invitation.id,
      p_email: email.toLowerCase(),
    });

    // Send welcome email (non-blocking)
    callEdgeFunction('send-welcome-email', { email, name: invitation.name });

    return { user: null, error: null };
  } catch (e: any) {
    return { user: null, error: e.message || 'Registration failed' };
  }
}

/** Resend invitation (re-creates if needed) */
export async function resendInvite(email: string): Promise<{ error: string | null }> {
  // Check if invitation exists
  const { data: invitation } = await supabase
    .from('invitations')
    .select('*')
    .eq('email', email.toLowerCase())
    .eq('used', false)
    .single();

  if (!invitation) {
    return { error: 'No pending invitation found for this email' };
  }

  // For now, just confirm the invitation exists — the user can register via the app
  return { error: null };
}

/** Fetch all users from Supabase (profiles + store links).
 *  Spec 012b §5 — optional `{ brandId }` filter for the BrandsSection
 *  members tab. When supplied, server-side filters profiles by brand_id
 *  AND the returned `stores` array is also clipped to brand-scoped store
 *  ids (so a count makes sense across brands).
 */
export async function fetchAllUsers(opts?: { brandId?: string }): Promise<User[]> {
  try {
    let query = supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true });
    if (opts?.brandId) {
      query = query.eq('brand_id', opts.brandId);
    }
    const { data: profiles, error } = await query;

    if (error || !profiles) return [];

    // Fetch all store links in one query
    const userIds = profiles.map((p: any) => p.id);
    const { data: allStoreLinks } = await supabase
      .from('user_stores')
      .select('user_id, store_id')
      .in('user_id', userIds);

    // When brand-filtered, also clip the user_stores rows to stores in
    // that brand so a count doesn't include cross-brand grants (legacy
    // rows could in theory exist; defense-in-depth).
    // Spec 012b cleanup #1 — sub-queries now live in db.ts per CLAUDE.md.
    const allowedStoreIds: Set<string> | null = opts?.brandId
      ? await fetchStoreIdsForBrand(opts.brandId)
      : null;

    // Pull invitation rows for email inference. Spec 083 DROPPED the brand
    // filter here: fetchInvitationsForUserLookup now reads ALL invitations
    // (the old cleanup-#16 `.eq('brand_id', …)` narrowing HID NULL-brand
    // invitations from inference — the spec-083 "(email not loaded)" bug).
    // The per-user profile_id (winning) / name match below — not a brand
    // filter — is what scopes each invitation to the correct person. The
    // `opts?.brandId` passed here is RETAINED for call-site compatibility but
    // is currently UNUSED by the helper. (Which USERS appear is still
    // brand-scoped: the profiles query above filters by brand_id.)
    const invitations = await fetchInvitationsForUserLookup(opts?.brandId);

    // Fetch auth users' emails
    // Note: We can't query auth.users from client, so we use invitations for pending users
    // For active users, email comes from the session or we store it

    // Cleanup #4 — index invitations by profile_id (set on consume_invitation)
    // first; fall back to name match for legacy invitations whose profile_id
    // is still the placeholder. profile_id wins because two admins sharing a
    // display name would otherwise get swapped emails.
    const invByProfileId = new Map<string, any>();
    const invByName = new Map<string, any>();
    for (const inv of invitations || []) {
      if (inv.profile_id && inv.profile_id !== '00000000-0000-0000-0000-000000000000') {
        invByProfileId.set(inv.profile_id, inv);
      }
      if (inv.name) invByName.set(inv.name, inv);
    }

    return profiles.map((p: any) => {
      const stores = (allStoreLinks || [])
        .filter((sl: any) => sl.user_id === p.id)
        .map((sl: any) => sl.store_id)
        .filter((sid: string) => !allowedStoreIds || allowedStoreIds.has(sid));

      const invitation = invByProfileId.get(p.id) ?? invByName.get(p.name);

      return {
        id: p.id,
        name: p.role === 'master' ? 'MASTER' : p.name,
        nickname: p.nickname || '',
        email: invitation?.email || '',
        role: p.role,
        stores,
        status: p.status,
        initials: p.role === 'master' ? 'M' : (p.initials || p.name.slice(0, 2).toUpperCase()),
        color: p.color || '#378ADD',
        notificationsEnabled: p.notifications_enabled !== false,
        brandId: p.brand_id ?? null,
      } as User;
    });
  } catch {
    return [];
  }
}

/** Delete a user fully (profile + store links + auth account via edge function) */
export async function deleteUser(userId: string): Promise<{ error: string | null }> {
  const { error } = await callEdgeFunction('delete-user', { userId });
  return { error };
}

/**
 * Spec 025 §2.B — Trigger Supabase's built-in password-reset email for an
 * arbitrary user (admin tool, called from UsersSection). Uses the
 * project-level GoTrue mailer template — no edge function involved.
 *
 * Server-side this is gated by Supabase's GoTrue policy (the caller must
 * hold a valid session). Client-side the UsersSection enforces the role
 * gates from AC25 (master can reset anyone except master itself; admin
 * can reset only `user`-role rows).
 *
 * Return shape matches deleteUser for symmetry at the call site.
 */
export async function sendPasswordReset(email: string): Promise<{ error: string | null }> {
  try {
    // Spec 085 — pass a per-platform `redirectTo` so the recovery link lands on
    // OUR /reset-password screen instead of falling back to the dashboard Site
    // URL (the localhost:3000 bug). resolveRecoveryRedirectUrl() returns the
    // prod web URL (EXPO_PUBLIC_WEB_RECOVERY_URL) / web-dev origin / native
    // scheme URL depending on Platform.OS. Return shape is UNCHANGED so
    // UsersSection's toast handling at the call site is untouched.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: resolveRecoveryRedirectUrl(),
    });
    if (error) return { error: error.message };
    return { error: null };
  } catch (e: any) {
    return { error: e.message || 'Failed to send password reset email' };
  }
}
