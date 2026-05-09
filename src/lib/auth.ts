// src/lib/auth.ts
import { supabase } from './supabase';
import { User, SidebarLayoutOverride } from '../types';
import { isValidOverride } from './sidebarLayout';
import { fetchStoreIdsForBrand, fetchInvitationsForUserLookup } from './db';

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
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
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

  return {
    user,
    error: null,
    darkMode: !!profile.dark_mode,
    // Spec 008: per-user sidebar override; null when uncustomized or when
    // the stored shape is invalid (defensive coercion).
    sidebarLayout: coerceSidebarLayout(profile.sidebar_layout),
  };
}

/** Helper: call a Supabase Edge Function */
async function callEdgeFunction(fnName: string, body: Record<string, any>): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    await fetch(`${url}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Email is non-critical — don't block the invite flow
  }
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

/**
 * @deprecated Spec 012b — positional shim kept exclusively so the legacy
 * AdminScreens.tsx mega-screen keeps compiling after inviteUser switched
 * to an options-object signature. Forwards to the new form with
 * brandId=null. Do NOT use from new code; new admin invitations flow
 * through the Cmd UI's InviteAdminDrawer which sets brand_id explicitly.
 *
 * The legacy AdminScreens.tsx is frozen pending removal once the new
 * UI becomes default; per CLAUDE.md "Legacy admin screens", agents must
 * NOT add new functionality there. This shim is a build-keep-green
 * refactor, not new functionality.
 */
export async function inviteUserLegacy(
  email: string,
  name: string,
  role: 'admin' | 'user',
  storeIds: string[],
  storeNames?: string,
): Promise<{ error: string | null }> {
  return inviteUser({ email, name, role, storeIds, storeNames, brandId: null });
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
    // accept either. Pass through whatever the invitation row carries.
    const { error: profileError } = await supabase.from('profiles').insert({
      id: authData.user.id,
      name: invitation.name,
      role: invitation.role,
      initials: invitation.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      color: '#378ADD',
      status: 'active',
      brand_id: invitation.brand_id ?? null,
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

    // Pull invitation rows for email inference. Cleanup #16 scopes the
    // query to the current brand when brand-filtered so the table read
    // doesn't span every tenant.
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
  try {
    await callEdgeFunction('delete-user', { userId });
    return { error: null };
  } catch (e: any) {
    return { error: e.message || 'Failed to delete user' };
  }
}
